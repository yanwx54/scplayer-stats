/**
 * local-sync.js — 附着日常 Chrome 过盾全量同步 + 推送服务器
 *
 * 背景：eloboard.com 启用 Cloudflare Turnstile 反爬，服务器和自动化浏览器均被拦，
 *       但日常使用的真实 Chrome（真人环境信誉）可自动过盾。
 * 方案：附着到用户正在运行的 Chrome（需带 --remote-debugging-port=9222 启动），
 *       在真人浏览器环境内抓取全部选手页面，数据写入本地 data/ 后推送到服务器。
 *
 * 用法：
 *   node local-sync.js               # 增量同步（默认）：只抓近 14 天有比赛的活跃选手，
 *                                     #   新比赛追加进本地库（历史永久保留，不丢滚出网页窗口的比赛）
 *   node local-sync.js --full        # 全量同步全部选手（距上次全量超 7 天也会自动全量）
 *   node local-sync.js 12 33         # 只同步指定 wrId（测试用）
 *   node local-sync.js --no-upload   # 只同步不上传
 *   node local-sync.js --upload-only # 跳过抓取，直接推送本地已有数据（服务器可达后补传）
 *
 * 依赖：npm i -D playwright
 * 前置：无需手动操作 — 若 9222 调试端口未开放，脚本自动以独立 profile
 *       （.sync-chrome/）启动专用 Chrome，过盾 cookie 持久化在 profile 中，
 *       同步结束后自动关闭该实例，不影响日常浏览器。
 * 配置：local.config.json  { "server": "http://服务器:3001", "token": "..." }
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const axios = require('axios');
const db = require('./db');

const CONFIG_FILE = path.join(__dirname, 'local.config.json');
const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_DIR = path.join(DATA_DIR, 'players');
const CDP_PORT = 9222;
const ENTRY_URL = 'https://eloboard.com/men';
const SYNC_PROFILE_DIR = path.join(__dirname, '.sync-chrome'); // 专用 Chrome profile（持久化过盾 cookie）

// ---- Parse players from markdown（与 sync.js 一致）----
function parsePlayersFromMd() {
    const mdPath = path.join(__dirname, 'docs', '韩国选手个人主页列表.md');
    const text = fs.readFileSync(mdPath, 'utf8');
    const players = [];
    const re = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(https?:[^|]+?)\s*\|/;
    text.split(/\r?\n/).forEach(line => {
        const m = line.match(re);
        if (!m) return;
        const url = m[5].trim();
        const wrIdMatch = url.match(/wr_id=(\d+)/);
        players.push({
            id: m[1], krName: m[2].trim(), cnName: m[3].trim(),
            playerId: m[4].trim(), wrId: wrIdMatch ? wrIdMatch[1] : null, url,
        });
    });
    return players.filter(p => p.wrId);
}

// ---- Parse args ----
function parseArgs() {
    const args = process.argv.slice(2);
    return {
        wrIds: args.filter(a => /^\d+$/.test(a)),
        noUpload: args.includes('--no-upload'),
        uploadOnly: args.includes('--upload-only'), // 跳过抓取，直接推送本地已有数据
        full: args.includes('--full'),              // 强制全量（默认增量：只同步活跃选手）
    };
}

// ---- 增量模式：判定选手是否需要同步 ----
// 规则：本地无数据（新选手）或最新一场比赛在 ACTIVE_DAYS 天内 → 活跃，同步；
//       否则视为休眠选手跳过（其数据不会变化）
const ACTIVE_DAYS = 14;             // 活跃判定窗口（天）
const FULL_SYNC_INTERVAL_DAYS = 7;  // 距上次全量超过此天数 → 自动全量（兜底抓"复活"的休眠选手）

function playerLastMatchDate(wrId) {
    const data = db.readPlayerData ? db.readPlayerData(wrId) : null;
    if (!data || !Array.isArray(data.matches) || data.matches.length === 0) return null;
    // matches 按时间倒序，保险起见仍取最大日期
    return data.matches.reduce((max, m) => (m.date > max ? m.date : max), data.matches[0].date);
}

function selectActivePlayers(players) {
    const now = Date.now();
    const active = [], skipped = [];
    for (const p of players) {
        const lastDate = playerLastMatchDate(p.wrId);
        if (!lastDate) { active.push(p); continue; } // 无本地数据 → 视为需要同步
        const days = (now - new Date(lastDate + 'T23:59:59').getTime()) / 86400000;
        if (days <= ACTIVE_DAYS) active.push(p);
        else skipped.push(p);
    }
    return { active, skipped };
}

// ---- Chrome 自动管理 ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 探测 Chrome 安装路径（常见位置）
function findChrome() {
    const candidates = [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean);
    return candidates.find(p => fs.existsSync(p)) || null;
}

// 查询 CDP 端口是否就绪，返回 version 信息或 null
async function cdpVersion(timeoutMs = 2000) {
    try {
        const r = await axios.get(`http://127.0.0.1:${CDP_PORT}/json/version`, { timeout: timeoutMs });
        return r.data;
    } catch (e) { return null; }
}

// 启动专用同步 Chrome（独立 profile，窗口移出屏幕），返回主进程 pid
function launchSyncChrome(chromePath) {
    const child = spawn(chromePath, [
        `--user-data-dir=${SYNC_PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        `--remote-debugging-port=${CDP_PORT}`,
        '--window-position=-32000,-32000', // 窗口移出屏幕，不打扰日常使用
        'about:blank',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    return child.pid;
}

// 杀掉指定进程树（同步结束后清理自启的 Chrome）
function killPidTree(pid) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* 已退出 */ }
}

// ---- 附着 Chrome（CDP），返回 context ----
// 端口未开放时自动启动专用 Chrome；返回 launchedPid（非 null 表示由本脚本启动，需在结束时关闭）
async function attachChrome() {
    let pw;
    try { pw = require('patchright'); }
    catch (e) {
        try { pw = require('playwright'); }
        catch (e2) {
            console.error('缺少浏览器库，请先运行: npm i -D patchright');
            process.exit(1);
        }
    }

    // 检查 CDP 端口；不通则自动启动专用 Chrome 并等待就绪
    let version = await cdpVersion(3000);
    let launchedPid = null;
    if (!version) {
        const chromePath = findChrome();
        if (!chromePath) {
            console.error(`调试端口 ${CDP_PORT} 未开放，且未找到 Chrome。`);
            console.error('请安装 Chrome 或手动带参数启动：chrome.exe --remote-debugging-port=9222');
            process.exit(1);
        }
        console.log(`调试端口未开放，自动启动专用 Chrome（独立 profile）…`);
        launchedPid = launchSyncChrome(chromePath);
        for (let i = 0; i < 30 && !version; i++) {
            await sleep(1000);
            version = await cdpVersion(1500);
        }
        if (!version) {
            killPidTree(launchedPid);
            console.error('Chrome 已启动但调试端口超时未就绪（30 秒）。');
            process.exit(1);
        }
        console.log('✓ 专用 Chrome 已就绪（同步结束后将自动关闭）');
    }
    console.log(`已连接 Chrome: ${version.Browser}`);

    const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    // Chrome 会有多个 context（默认 + Profile），取已有的第一个（含 cookie 与过盾信誉）
    const context = browser.contexts()[0];
    if (!context) {
        await browser.close();
        if (launchedPid) killPidTree(launchedPid);
        throw new Error('Chrome 中未找到可用会话');
    }
    return { browser, context, launchedPid };
}

// ---- 等待页面通过 Cloudflare 盾（无交互 managed challenge 自动过）----
// 盾页标题各语言版本：Just a moment… / 잠시만… / 请稍候… / Verifying…
const SHIELD_TITLE_RE = /just a moment|잠시만|请稍候|安全验证|security check|checking your browser|verifying|attention required/i;
// 盾页正文特征（HTML 兜底检测）
const SHIELD_HTML_RE = /just a moment|잠시만|请稍候|安全验证|verifying you are human|attention required|cf-challenge/i;

async function waitPassShield(page, timeoutMs = 60000) {
    try {
        await page.waitForFunction(
            () => !/just a moment|잠시만|请稍候|安全验证|security check|checking your browser|verifying|attention required/i.test(document.title),
            { timeout: timeoutMs }
        );
        return true;
    } catch (e) {
        return false; // 超时仍未通过
    }
}

// ---- 用浏览器会话构造 HTML 抓取器（注入 db，替代 axios）----
// 选手页约 7MB，必须等完全加载（domcontentloaded 时 DOM 可能仍在流式填充）
function makeFetcher(context) {
    return async (url) => {
        const page = await context.newPage();
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            // 弹盾时等待自动通过（managed challenge 通常 5~30 秒自动完成并刷新页面）
            const title = await page.title().catch(() => '');
            if (SHIELD_TITLE_RE.test(title)) {
                const ok = await waitPassShield(page, 90000);
                if (!ok) throw new Error(`盾等待超时: ${url}`);
                await page.waitForTimeout(2000); // 挑战通过后页面自动刷新，等渲染
            }
            // 等网络空闲（大页面完全加载），广告脚本导致空闲检测失灵时 30s 兜底
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(1500);
            let html = await page.content();
            // 若拿到的仍是盾页（标题未识别的变体），重新导航再等一次
            if (SHIELD_HTML_RE.test(html)) {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                if (!(await waitPassShield(page, 90000))) throw new Error(`盾重试超时: ${url}`);
                await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(2000);
                html = await page.content();
                if (SHIELD_HTML_RE.test(html)) throw new Error(`盾未通过: ${url}`);
            }
            return html;
        } finally {
            await page.close();
        }
    };
}

// ---- 打包本地数据并上传 ----
// wrIds 为 null 时上传全部本地选手；否则只上传指定选手（增量模式减小传输量）
async function uploadToServer(server, token, wrIds = null) {
    const payload = { players: {} };
    const wanted = wrIds ? new Set(wrIds.map(String)) : null;
    fs.readdirSync(PLAYERS_DIR).forEach(f => {
        const m = f.match(/^(\d+)\.json$/);
        if (m && (!wanted || wanted.has(m[1]))) {
            try { payload.players[m[1]] = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, f), 'utf8')); }
            catch (e) { console.warn(`跳过损坏文件 ${f}: ${e.message}`); }
        }
    });
    const metaFile = path.join(DATA_DIR, 'meta.json');
    if (fs.existsSync(metaFile)) payload.meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));

    const sizeMB = (JSON.stringify(payload).length / 1024 / 1024).toFixed(2);
    console.log(`\n=== 上传数据到服务器 ===`);
    console.log(`打包 ${Object.keys(payload.players).length} 个选手数据（${sizeMB}MB）→ ${server}`);

    const r = await axios.post(`${server.replace(/\/$/, '')}/api/upload-data`, payload, {
        headers: { Authorization: 'Bearer ' + token },
        timeout: 180000,
    });
    if (r.data && r.data.ok) {
        console.log(`✓ 上传成功：服务器已写入 ${r.data.playersWritten} 个选手数据`);
    } else {
        throw new Error('上传失败: ' + JSON.stringify(r.data));
    }
}

// ---- Main ----
async function main() {
    const opts = parseArgs();

    let config;
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) {
        console.error(`缺少配置文件 ${CONFIG_FILE}，请创建：`);
        console.error(`{ "server": "http://服务器IP:3001", "token": "与服务器 data/upload-token.txt 一致" }`);
        process.exit(1);
    }

    db.ensureDirs();

    // --upload-only：跳过抓取，直接推送本地已有数据（服务器恢复可达后补传用）
    if (opts.uploadOnly) {
        console.log('=== --upload-only：跳过抓取，直接推送本地数据 ===');
        await uploadToServer(config.server, config.token);
        return;
    }

    let players = parsePlayersFromMd();
    if (opts.wrIds.length > 0) {
        players = players.filter(p => opts.wrIds.includes(p.wrId));
        console.log(`测试模式：只同步 ${players.length} 个选手`);
    }

    // ---- 增量/全量选择 ----
    // --full 强制全量；距上次全量超 7 天自动全量；否则增量（只同步近 14 天有比赛的活跃选手）
    const meta = db.readMeta();
    const daysSinceFull = meta.lastFullSync
        ? (Date.now() - new Date(meta.lastFullSync).getTime()) / 86400000
        : Infinity;
    let isFull = opts.full;
    let autoFull = false;
    if (!isFull && daysSinceFull > FULL_SYNC_INTERVAL_DAYS) { isFull = true; autoFull = true; }

    if (!isFull && opts.wrIds.length === 0) {
        const { active, skipped } = selectActivePlayers(players);
        console.log(`=== 增量同步：${active.length} 个活跃选手（近 ${ACTIVE_DAYS} 天有比赛），跳过 ${skipped.length} 个休眠选手 ===`);
        if (skipped.length > 0) {
            console.log(`  跳过: ${skipped.map(p => p.cnName).join(', ')}`);
        }
        players = active;
    } else if (isFull) {
        console.log(`=== 全量同步 ${players.length} 个选手${autoFull ? `（距上次全量 ${daysSinceFull.toFixed(1)} 天，自动转全量）` : '（--full）'} ===`);
    } else {
        console.log(`=== 附着 Chrome 过盾同步 ${players.length} 个选手 ===`);
    }
    const uploadWrIds = players.map(p => p.wrId); // 上传只传本次同步过的选手（增量减小传输量）

    const { browser, context, launchedPid } = await attachChrome();
    let syncOk = false;
    try {
        // 先访问主页过一次盾，激活会话信誉（同 tab 内导航共享过盾状态）
        // 入口页偶发超时/限流，重试 3 次（间隔递增）
        const entry = await context.newPage();
        try {
            let entryOk = false;
            for (let i = 0; i < 3 && !entryOk; i++) {
                try {
                    console.log(`访问 eloboard.com 激活过盾状态${i > 0 ? `（第 ${i + 1} 次尝试）` : ''}…`);
                    await entry.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
                    await waitPassShield(entry, 90000);
                    entryOk = true;
                } catch (e) {
                    if (i === 2) throw e;
                    console.log(`  ⚛ 入口页失败(${e.message.split('\n')[0]})，30s 后重试`);
                    await sleep(30000);
                }
            }
            console.log('✓ 过盾状态就绪');
        } finally {
            await entry.close();
        }

        db.setFetcher(makeFetcher(context));
        await db.syncAll(players, { concurrency: 1, delay: 800, silent: false, full: isFull });
        syncOk = true;
    } finally {
        await browser.close(); // 只断开 CDP 连接
        // 若 Chrome 由本脚本启动，同步结束后关闭（过盾 cookie 已持久化在 profile）
        if (launchedPid) {
            await sleep(1500); // 给 Chrome 一点时间将 cookie 落盘
            killPidTree(launchedPid);
            console.log('✓ 专用 Chrome 已关闭');
        }
    }

    if (!syncOk) throw new Error('同步过程出错');
    if (opts.noUpload) {
        console.log('\n--no-upload：跳过上传');
        return;
    }
    await uploadToServer(config.server, config.token, uploadWrIds);
}

main().then(() => {
    console.log(`\n全部完成 ${new Date().toLocaleString()}`);
    process.exit(0);
}).catch(e => {
    console.error('失败:', e.message);
    process.exit(1);
});
