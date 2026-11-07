'use strict';

/**
 * mail-alert.js — 同步失败邮件告警（SMTP 直发，零第三方依赖，Node 16 兼容）
 *
 * 配置（二选一，环境变量优先）：
 *   1) local.config.json 的 mail 段（模板见 local.config.example.json）：
 *      "mail": { "enabled": true, "host": "smtp.163.com", "port": 465, "secure": true,
 *                "user": "yanwx54@163.com", "pass": "163客户端授权码（不是登录密码）",
 *                "from": "yanwx54@163.com", "to": "yanwx54@163.com",
 *                "allowInvalidCert": true }（163 只下发叶子证书，需允许 TLS 降级）
 *   2) 环境变量：SC_ALERT_SMTP_HOST / SC_ALERT_SMTP_PORT / SC_ALERT_SMTP_SECURE /
 *      SC_ALERT_SMTP_USER / SC_ALERT_SMTP_PASS / SC_ALERT_FROM / SC_ALERT_TO /
 *      SC_ALERT_ENABLED=0（关闭告警）
 *
 * 行为约定：
 *   - 缺凭据或发信失败只打印日志，绝不抛错（不影响同步主流程与退出码）。
 *   - 同一天 + 同一原因只发一次（状态记录在 data/mail-alert-state.json）。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'mail-alert-state.json');
const DEFAULT_TO = 'yanwx54@163.com';
const SMTP_TIMEOUT_MS = 25000;

// ---- 配置解析 ----
function resolveConfig(baseConfig) {
    const m = (baseConfig && baseConfig.mail) || {};
    const host = process.env.SC_ALERT_SMTP_HOST || m.host || 'smtp.163.com';
    const port = Number(process.env.SC_ALERT_SMTP_PORT || m.port || 465);
    const secureEnv = process.env.SC_ALERT_SMTP_SECURE;
    const secure = secureEnv !== undefined && secureEnv !== ''
        ? secureEnv !== '0'
        : (m.secure === undefined ? port === 465 : !!m.secure);
    const user = process.env.SC_ALERT_SMTP_USER || m.user || '';
    const pass = process.env.SC_ALERT_SMTP_PASS || m.pass || '';
    const to = process.env.SC_ALERT_TO || m.to || DEFAULT_TO;
    const from = process.env.SC_ALERT_FROM || m.from || user;
    const disabled = m.enabled === false || process.env.SC_ALERT_ENABLED === '0';
    const allowEnv = process.env.SC_ALERT_ALLOW_INVALID_CERT;
    const allowInvalidCert = allowEnv !== undefined && allowEnv !== ''
        ? allowEnv !== '0'
        : (m.allowInvalidCert === undefined ? true : !!m.allowInvalidCert);
    return {
        enabled: !disabled && !!user && !!pass,
        configured: !!user && !!pass,
        disabled,
        host,
        port,
        secure,
        user,
        pass,
        from,
        to,
        allowInvalidCert,
        failRatio: Number(m.failRatioThreshold === undefined ? 0.2 : m.failRatioThreshold),
    };
}

// ---- 去重状态（同一天同一原因只发一次）----
function dateKey() {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
    } catch (e) {
        return new Date().toISOString().slice(0, 10);
    }
}

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

function hasSent(stateKey) {
    return !!readState()[stateKey];
}

function markSent(stateKey) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const today = dateKey();
        const state = readState();
        const next = {};
        Object.keys(state).forEach(k => { if (k.indexOf(today) === 0) next[k] = state[k]; });
        next[stateKey] = new Date().toISOString();
        fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
    } catch (e) {
        console.log(`⚠ 告警去重状态写入失败：${e.message}`);
    }
}

// ---- 极简 SMTP 客户端（仅支持 AUTH LOGIN；465 隐式 TLS 或 587 STARTTLS）----
function encodeHeader(value) {
    return '=?UTF-8?B?' + Buffer.from(String(value), 'utf8').toString('base64') + '?=';
}

function buildMessage(from, recipients, subject, text) {
    const body = Buffer.from(String(text), 'utf8').toString('base64');
    const wrapped = body.match(/.{1,76}/g).join('\r\n');
    return [
        `From: ${from}`,
        `To: ${recipients.join(', ')}`,
        `Subject: ${encodeHeader(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@scplayer-stats>`,
        '',
        wrapped,
    ].join('\r\n');
}

class SmtpSession {
    constructor(conf) {
        this.conf = conf;
        this.socket = null;
        this.buf = '';
        this.lines = [];
        this.pending = null;
        this.connectReject = null;
    }

    _attach(socket) {
        this.socket = socket;
        socket.setTimeout(SMTP_TIMEOUT_MS);
        socket.on('data', chunk => { this.buf += chunk.toString('utf8'); this._pump(); });
        socket.on('error', e => this._fail(e));
        socket.on('timeout', () => this._fail(new Error(`SMTP 连接超时（${SMTP_TIMEOUT_MS / 1000}s）`)));
    }

    _fail(err) {
        if (this.pending) { const p = this.pending; this.pending = null; p.reject(err); }
        else if (this.connectReject) { const r = this.connectReject; this.connectReject = null; r(err); }
    }

    connect() {
        const { host, port, secure } = this.conf;
        const verify = this.conf.insecureTls ? false : true;
        return new Promise((resolve, reject) => {
            this.connectReject = reject;
            const sock = secure
                ? tls.connect({ host, port, servername: host, rejectUnauthorized: verify }, () => { this.connectReject = null; resolve(); })
                : net.connect({ host, port }, () => { this.connectReject = null; resolve(); });
            this._attach(sock);
        });
    }

    _pump() {
        if (!this.pending) return;
        while (true) {
            const idx = this.buf.indexOf('\r\n');
            if (idx < 0) return;
            const line = this.buf.slice(0, idx);
            this.buf = this.buf.slice(idx + 2);
            this.lines.push(line);
            if (/^\d{3} /.test(line)) {
                const resp = { code: Number(line.slice(0, 3)), text: this.lines.join('\n') };
                this.lines = [];
                const p = this.pending;
                this.pending = null;
                p.resolve(resp);
                return;
            }
        }
    }

    _read() {
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject };
            this._pump();
        });
    }

    async _write(line) {
        this.socket.write(line + '\r\n');
    }

    async cmd(line, okCodes) {
        await this._write(line);
        const r = await this._read();
        if (okCodes && okCodes.indexOf(r.code) === -1) {
            throw new Error(`SMTP 命令 ${line.split(' ')[0]} 失败：${r.text}`);
        }
        return r;
    }

    async startTls() {
        await this.cmd('STARTTLS', [220]);
        const raw = this.socket;
        raw.removeAllListeners('data');
        raw.removeAllListeners('error');
        raw.removeAllListeners('timeout');
        const secureSock = tls.connect({
            socket: raw,
            servername: this.conf.host,
            rejectUnauthorized: this.conf.insecureTls ? false : true,
        });
        await new Promise((resolve, reject) => {
            secureSock.once('secureConnect', resolve);
            secureSock.once('error', reject);
        });
        this.buf = '';
        this.lines = [];
        this._attach(secureSock);
    }

    async send(subject, text) {
        const recipients = String(this.conf.to).split(',').map(s => s.trim()).filter(Boolean);
        const message = buildMessage(this.conf.from, recipients, subject, text);
        await this.cmd(`MAIL FROM:<${this.conf.from}>`, [250]);
        for (const addr of recipients) await this.cmd(`RCPT TO:<${addr}>`, [250, 251]);
        await this.cmd('DATA', [354]);
        await this._write(message + '\r\n.\r\n');
        const done = await this._read();
        if (done.code !== 250) throw new Error(`SMTP DATA 提交失败：${done.text}`);
        return done;
    }

    async close() {
        try { await this.cmd('QUIT', [221]); } catch (e) { /* ignore */ }
        try { this.socket.destroy(); } catch (e) { /* ignore */ }
    }
}

function isCertError(e) {
    const m = `${(e && e.message) || ''} ${(e && e.code) || ''}`;
    return /certificate|altnames|self[- ]signed|authority|unable to verify|depth zero/i.test(m);
}

// 163 的 SMTP 只下发叶子证书、不下发中间证书，Node 无法完成链校验：
// 严格校验失败且允许降级时，改用「仍然 TLS 加密但不校验证书」重连（可配置关闭）
async function openSession(conf) {
    let session = new SmtpSession(conf);
    try {
        await session.connect();
        return session;
    } catch (e) {
        try { session.socket.destroy(); } catch (e2) { /* ignore */ }
        if (conf.allowInvalidCert && isCertError(e)) {
            console.log(`⚠ SMTP TLS 证书链校验失败（${e.message}），降级为加密但不校验证书继续（设置 mail.allowInvalidCert=false 可禁用该降级）`);
            session = new SmtpSession(Object.assign({}, conf, { insecureTls: true }));
            await session.connect();
            return session;
        }
        throw e;
    }
}

async function send(conf, { subject, text }) {
    const session = await openSession(conf);
    try {
        const greeting = await session._read();
        if (greeting.code !== 220) throw new Error(`SMTP 握手失败：${greeting.text}`);
        let ehlo = await session.cmd(`EHLO ${require('os').hostname() || 'localhost'}`, [250]);
        if (!conf.secure && /STARTTLS/i.test(ehlo.text)) {
            await session.startTls();
            ehlo = await session.cmd(`EHLO ${require('os').hostname() || 'localhost'}`, [250]);
        }
        await session.cmd('AUTH LOGIN', [334]);
        await session.cmd(Buffer.from(conf.user, 'utf8').toString('base64'), [334]);
        await session.cmd(Buffer.from(conf.pass, 'utf8').toString('base64'), [235]);
        await session.send(subject, text);
        await session.close();
    } catch (e) {
        try { session.socket.destroy(); } catch (e2) { /* ignore */ }
        throw e;
    }
}

/**
 * 发送失败告警；永不抛错。
 * @returns {Promise<{sent:boolean, skipped?:boolean, reason?:string, error?:string}>}
 */
async function notify(baseConfig, { reasonKey, subject, text }) {
    try {
        const conf = resolveConfig(baseConfig);
        if (!conf.enabled) {
            console.log(conf.configured
                ? '⚠ 未发送失败告警邮件：告警已禁用（mail.enabled=false 或 SC_ALERT_ENABLED=0）'
                : '⚠ 未发送失败告警邮件：未配置 SMTP 凭据（需在 local.config.json 的 mail.user/mail.pass 填 163 邮箱与客户端授权码，或设置 SC_ALERT_SMTP_USER / SC_ALERT_SMTP_PASS）');
            return { sent: false, skipped: true, reason: 'unconfigured' };
        }
        const stateKey = `${dateKey()}|${reasonKey}`;
        if (hasSent(stateKey)) {
            console.log(`⚠ 今日已就同一原因（${reasonKey}）发送过告警，跳过重复邮件`);
            return { sent: false, skipped: true, reason: 'duplicate' };
        }
        await send(conf, { subject, text });
        markSent(stateKey);
        console.log(`✓ 失败告警邮件已发送至 ${conf.to}（原因：${reasonKey}）`);
        return { sent: true };
    } catch (e) {
        console.log(`⚠ 失败告警邮件发送失败（不影响同步主流程与退出码）：${e.message}`);
        return { sent: false, error: e.message };
    }
}

module.exports = { resolveConfig, send, notify, dateKey, STATE_FILE };
