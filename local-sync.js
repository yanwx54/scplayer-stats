/**
 * local-sync.js — 附着 Chrome「页面内 fetch」同步 eloboard API + 推送服务器
 *
 * 背景：eloboard.com 有客户端指纹反爬。2026-11 起对 /api/* 收紧：curl / axios /
 *       Playwright context.request（Node 网络栈）一律 nginx 403，而真实 Chrome 页面内
 *       fetch 正常 200（与 Cookie 无关）。
 *       2026-08 网站改版：旧 HTML 选手页废弃，改为 JSON API（/api/players、/api/matches）。
 * 方案：附着到专用 Chrome（CDP 9222），在页面上下文用 fetch 抓取新版 API 的选手详情与
 *       比赛分页，写入本地 data/ 后推送到服务器。
 *
 * 用法：
 *   node local-sync.js               # 增量同步（默认）：只抓近 14 天有比赛的活跃选手，
 *                                     #   新比赛追加进本地库（历史永久保留，不丢滚出窗口的比赛）
 *   node local-sync.js --full        # 全量同步全部选手（距上次全量超 7 天也会自动全量）
 *   node local-sync.js 12 33         # 只同步指定 wrId（测试用）
 *   node local-sync.js --no-upload   # 只同步不上传
 *   node local-sync.js --upload-only # 跳过抓取，直接推送本地已有数据（服务器可达后补传）
 *   node local-sync.js --avatars-only # 只下载选手头像（eloboard 外链被拦，头像本地化）
 *   node local-sync.js --rebuild-id-map # 重建 旧wrId→新playerId 映射（MD 列表变动后运行；
 *                                     #   映射文件缺失时同步前也会自动重建）
 *
 * 依赖：npm i -D patchright（或 playwright）
 * 前置：无需手动操作 — 若 9222 调试端口未开放，脚本自动以独立 profile
 *       （.sync-chrome/）启动专用 Chrome，会话持久化在 profile 中，
 *       同步结束后自动关闭该实例，不影响日常浏览器。
 * 配置：local.config.json  { "server": "http://服务器:3001", "token": "...",
 *                          "mail": { ... }（失败邮件告警，可选，模板见 local.config.example.json） }
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const axios = require('axios');
const db = require('./db');
const mailAlert = require('./mail-alert');

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
        avatarsOnly: args.includes('--avatars-only'), // 只下载头像（不重抓比赛数据）
        rebuildIdMap: args.includes('--rebuild-id-map'), // 重建旧wrId→新playerId映射
        full: args.includes('--full'),              // 强制全量（默认增量：只同步活跃选手）
        testMail: args.includes('--test-mail'),      // 立即发送一封测试告警邮件，验证凭据
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

// 从任务栏隐藏同步 Chrome：给窗口加 WS_EX_TOOLWINDOW 扩展样式（任务栏/Alt-Tab 均不显示）
// 窗口本体仍在屏幕外且保持 visible（不最小化、不 SW_HIDE），页面渲染与过盾行为完全不变
// 只匹配命令行含 sync-chrome 的进程，绝不影响用户自己打开的 Chrome
function hideSyncChromeWindows() {
    const ps = `
$ProgressPreference = 'SilentlyContinue'
$sig = '[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i); [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);'
Add-Type -MemberDefinition $sig -Name U -Namespace W
$styled = 0
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  $styled = 0
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*sync-chrome*' } | ForEach-Object {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) {
      $h = $p.MainWindowHandle
      $ex = [W.U]::GetWindowLong($h, -20)
      if (($ex -band 0x80) -eq 0) {
        [void][W.U]::SetWindowLong($h, -20, ($ex -bor 0x80))
        [void][W.U]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x33)
      }
      $styled++
    }
  }
  if ($styled -gt 0) { break }
  Start-Sleep -Milliseconds 400
}
Write-Output $styled`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    try {
        return parseInt(execSync(`powershell -NoProfile -EncodedCommand ${encoded}`).toString().trim()) || 0;
    } catch (e) { return 0; }
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
        // 窗口创建后立即从任务栏隐藏（内部轮询等窗口出现，最多 15s）
        if (hideSyncChromeWindows() > 0) console.log('✓ Chrome 已隐藏（屏幕外，任务栏不显示）');
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

// ---- 页面上下文抓取 ----
// 2026-11 起 eloboard 对 /api/* 增加客户端指纹拦截：curl / axios / Playwright
// context.request（Node 网络栈）一律返回 nginx 403，而真实 Chrome 页面内 fetch
// 正常返回 200（且与 Cookie 无关，空 profile 同样可用）。
// 因此所有 API 请求都必须在页面上下文执行，不能再走 context.request。
const API_PROBE_URL = 'https://eloboard.com/api/players?limit=1&offset=0';

// 给 URL 追加一次性时间戳：绕开 eloboard /api/* 中间层按 URL 键控的缓存
// （2026-11 曾出现"每次同步都成功，但比赛数据冻结在 11-07"——同一 URL 命中旧快照）
function bustCache(url) {
    if (/[?&]_t=/.test(url)) return url;
    return url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
}

// 页面内 fetch，返回 { status, text }
async function pageFetch(page, url) {
    return page.evaluate(async (u) => {
        const resp = await fetch(u, { cache: 'no-store' });
        let text = '';
        try { text = await resp.text(); } catch (e) { text = ''; }
        return { status: resp.status, text };
    }, bustCache(url));
}

// 页面内取 JSON；错误信息带分类前缀（403 拦截 / HTTP 状态 / JSON 解析），便于统计
async function pageGetJson(page, url) {
    const r = await pageFetch(page, url);
    if (r.status === 403) throw new Error(`HTTP 403（被反爬拦截）: ${url}`);
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}: ${url}`);
    try { return JSON.parse(r.text); }
    catch (e) { throw new Error(`JSON 解析失败(${String(r.text).slice(0, 80)}): ${url}`); }
}

// 打开 eloboard 页面（供页面内 fetch），并做一次 API 可用性探测：
// 403 → 明确报错（拦截策略再次升级）；非 200 → 明确报错。不再输出“过盾就绪”式误报。
async function openApiPage(context) {
    const page = await context.newPage();
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
        try {
            console.log(`打开 eloboard.com 页面（页面内 fetch 抓取）${i > 0 ? `（第 ${i + 1} 次尝试）` : ''}…`);
            await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
            console.log(`  页面已加载：${await page.title()}`);
            loaded = true;
        } catch (e) {
            if (i === 2) throw e;
            console.log(`  ⚠ 入口页失败(${e.message.split('\n')[0]})，30s 后重试`);
            await sleep(30000);
        }
    }
    const probe = await pageFetch(page, API_PROBE_URL);
    if (probe.status === 403) {
        await page.close().catch(() => {});
        throw new Error('eloboard /api 返回 403（页面内 fetch 也被拦，站点拦截策略可能再次升级）');
    }
    if (probe.status !== 200) {
        await page.close().catch(() => {});
        throw new Error(`eloboard /api 探测失败：HTTP ${probe.status}`);
    }
    console.log('✓ 页面内 fetch 可用（/api/players 返回 200）');
    return page;
}

// ---- 用页面会话构造 JSON API 抓取器（注入 db，替代 axios/context.request 直连）----
function makeApiFetcher(page) {
    return (url) => pageGetJson(page, url);
}

// ---- 重建 旧wrId → 新playerId 映射（全量枚举新站选手，按韩文名匹配 MD 列表）----
// 输出 data/player-id-map.json；同名选手取 games 最多者
async function rebuildIdMap(page, players) {
    console.log('=== 重建 ID 映射（全量枚举新站选手）===');
    const all = [];
    let offset = 0;
    const LIMIT = 200;
    while (true) {
        // 与选手/比赛抓取同路径：页面上下文 fetch（Node 网络栈会被 nginx 403）
        const arr = await pageGetJson(page, `https://eloboard.com/api/players?limit=${LIMIT}&offset=${offset}`);
        if (!Array.isArray(arr) || arr.length === 0) break;
        all.push(...arr);
        process.stdout.write(`\r已拉取 ${all.length}`);
        offset += arr.length;
        if (arr.length < LIMIT) break;
        await sleep(250);
    }
    const men = all.filter(p => p.division === 'men');
    console.log(`\n新站共 ${all.length} 名选手（men=${men.length}）`);

    // 韩文名 → 新 id（同名取 games 最多）
    const byName = {};
    men.forEach(p => { if (!byName[p.name] || (p.games || 0) > (byName[p.name].games || 0)) byName[p.name] = p; });

    const map = {}, byNewId = {}, missing = [];
    for (const p of players) {
        if (!p.wrId) { missing.push(p.cnName + '(无wrId)'); continue; }
        const found = byName[p.krName];
        if (found) {
            map[p.wrId] = found.id;
            byNewId[found.id] = p.wrId;
        } else {
            missing.push(`${p.cnName}(${p.krName})`);
        }
    }
    const file = path.join(__dirname, 'data', 'player-id-map.json');
    fs.writeFileSync(file, JSON.stringify({
        builtAt: new Date().toISOString(),
        totalPlayers: all.length,
        oldToNew: map, newToOld: byNewId,
    }, null, 2));
    db.clearIdMapCache();

    const changed = Object.entries(map).filter(([o, n]) => Number(o) !== n);
    console.log(`映射 ${Object.keys(map).length}/${players.length}（ID 相同 ${Object.keys(map).length - changed.length}，变化 ${changed.length}）`);
    if (missing.length) console.log(`⚠ 未匹配: ${missing.join(', ')}`);
    return Object.keys(map).length;
}

// ---- 下载选手头像到本地（eloboard 外链被 Cloudflare 拦，必须本地化）----
// 用浏览器 context 请求（自带 cf_clearance cookie）；URL 未变且文件已存在则跳过
async function downloadAvatars(context, players) {
    const AV_DIR = path.join(DATA_DIR, 'avatars');
    if (!fs.existsSync(AV_DIR)) fs.mkdirSync(AV_DIR, { recursive: true });
    const INDEX_FILE = path.join(AV_DIR, 'index.json'); // wrId → 已下载的源 URL
    let index = {};
    try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch (e) {}

    let downloaded = 0, skipped = 0, failed = 0;
    for (const p of players) {
        const data = db.readPlayerData(p.wrId);
        const url = data && data.avatar;
        if (!url) { skipped++; continue; }
        const existing = findAvatarLocal(p.wrId);
        if (existing && index[p.wrId] === url) { skipped++; continue; } // 已缓存且未变

        try {
            const resp = await context.request.get(url, { timeout: 30000 });
            if (!resp.ok()) throw new Error('HTTP ' + resp.status());
            const buf = await resp.body();
            const ct = (resp.headers()['content-type'] || '').toLowerCase();
            const ext = ct.includes('png') ? '.png' : ct.includes('gif') ? '.gif'
                : ct.includes('webp') ? '.webp' : '.jpg';
            // 删除旧扩展名文件（URL 可能换了图片格式）
            ['.jpg', '.jpeg', '.png', '.gif', '.webp'].forEach(e => {
                const f = path.join(AV_DIR, p.wrId + e);
                if (fs.existsSync(f) && e !== ext) fs.unlinkSync(f);
            });
            fs.writeFileSync(path.join(AV_DIR, p.wrId + ext), buf);
            index[p.wrId] = url;
            downloaded++;
        } catch (e) {
            failed++;
            console.warn(`  ⚠ 头像下载失败 ${p.cnName}(wrId=${p.wrId}): ${e.message}`);
        }
        await sleep(200); // 礼貌间隔
    }
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
    console.log(`头像: ${downloaded} 下载, ${skipped} 已缓存, ${failed} 失败`);
}

// 查找本地头像文件名（与 db.findAvatarFile 相同逻辑，本地独立实现避免依赖）
function findAvatarLocal(wrId) {
    const AV_DIR = path.join(DATA_DIR, 'avatars');
    for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp']) {
        if (fs.existsSync(path.join(AV_DIR, wrId + ext))) return wrId + ext;
    }
    return null;
}

// ---- 打包本地数据并上传 ----
// wrIds 为 null 时上传全部本地选手；否则只上传指定选手（增量模式减小传输量）
// 服务器 /api/upload-data 单请求限制 30MB（UTF-8 字节）；数据含大量韩文（1字符=3字节），
// 全量打包实际字节数超字符数约 20%，2026-09-09 全量 30.15MB 触发 413。
// 修复：按字节预算分片上传，每片独立调用接口写入，服务器代码无需改动。
const UPLOAD_CHUNK_BYTES = 20 * 1024 * 1024; // 每分片字节预算（20MB，留 10MB 余量）

async function uploadToServer(server, token, wrIds = null) {
    const wanted = wrIds ? new Set(wrIds.map(String)) : null;

    // 逐选手序列化（便于按字节分片，勿用字符串 length 计量——那是字符数不是字节数）
    const playerItems = [];
    fs.readdirSync(PLAYERS_DIR).forEach(f => {
        const m = f.match(/^(\d+)\.json$/);
        if (m && (!wanted || wanted.has(m[1]))) {
            try {
                const json = fs.readFileSync(path.join(PLAYERS_DIR, f), 'utf8');
                playerItems.push({ wrId: m[1], json, bytes: Buffer.byteLength(json, 'utf8') });
            } catch (e) { console.warn(`跳过损坏文件 ${f}: ${e.message}`); }
        }
    });

    // 头像打包（base64；服务器写入 data/avatars/ 并经 /avatars 静态提供）
    const avatarItems = [];
    const AV_DIR = path.join(DATA_DIR, 'avatars');
    if (fs.existsSync(AV_DIR)) {
        fs.readdirSync(AV_DIR).forEach(f => {
            const m = f.match(/^(\d+)(\.\w+)$/);
            if (m && (!wanted || wanted.has(m[1]))) {
                try {
                    const b64 = fs.readFileSync(path.join(AV_DIR, f)).toString('base64');
                    avatarItems.push({ name: m[1] + m[2], b64, bytes: Buffer.byteLength(b64, 'utf8') });
                } catch (e) { /* 读取失败跳过 */ }
            }
        });
    }

    const metaFile = path.join(DATA_DIR, 'meta.json');
    const metaJson = fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf8') : null;

    // 贪心分片：players / avatars / meta 混装，每片累计字节 ≤ 预算
    const ITEM_OVERHEAD = 64; // JSON 键名等结构开销的粗略估算
    const chunks = [];
    let cur = { players: [], avatars: [], meta: false }, curBytes = 0;
    const push = (item) => {
        if (curBytes + item.bytes + ITEM_OVERHEAD > UPLOAD_CHUNK_BYTES &&
            (cur.players.length || cur.avatars.length || cur.meta)) {
            chunks.push(cur);
            cur = { players: [], avatars: [], meta: false }; curBytes = 0;
        }
        if (item.kind === 'player') { cur.players.push(item); curBytes += item.bytes + ITEM_OVERHEAD; }
        else if (item.kind === 'avatar') { cur.avatars.push(item); curBytes += item.bytes + ITEM_OVERHEAD; }
        else { cur.meta = true; curBytes += item.bytes + ITEM_OVERHEAD; }
    };
    playerItems.forEach(p => push({ kind: 'player', ...p }));
    avatarItems.forEach(a => push({ kind: 'avatar', ...a }));
    if (metaJson) push({ kind: 'meta', json: metaJson, bytes: Buffer.byteLength(metaJson, 'utf8') });
    if (cur.players.length || cur.avatars.length || cur.meta) chunks.push(cur);

    const totalBytes = playerItems.reduce((s, p) => s + p.bytes, 0) +
        avatarItems.reduce((s, a) => s + a.bytes, 0) + (metaJson ? Buffer.byteLength(metaJson, 'utf8') : 0);
    console.log(`\n=== 上传数据到服务器 ===`);
    console.log(`打包 ${playerItems.length} 个选手数据（${(totalBytes / 1048576).toFixed(2)}MB，分 ${chunks.length} 片）→ ${server}`);

    let written = 0;
    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const payload = { players: {}, avatars: {} };
        c.players.forEach(p => payload.players[p.wrId] = JSON.parse(p.json));
        c.avatars.forEach(a => payload.avatars[a.name] = a.b64);
        if (c.meta && metaJson) payload.meta = JSON.parse(metaJson);

        const r = await axios.post(`${server.replace(/\/$/, '')}/api/upload-data`, payload, {
            headers: { Authorization: 'Bearer ' + token },
            timeout: 180000,
        });
        if (!(r.data && r.data.ok)) throw new Error('上传失败: ' + JSON.stringify(r.data));
        written += r.data.playersWritten || 0;
        console.log(`  分片 ${i + 1}/${chunks.length} ✓`);
    }
    console.log(`✓ 上传成功：服务器已写入 ${written} 个选手数据`);
}

// ---- 失败邮件告警（只告警，不改变同步主流程与退出码）----
let runAlerted = false;   // 本次运行已发过告警（避免 0 成功后再发“异常退出”重复邮件）
let uploadDone = false;   // 本次运行是否已成功上传

function formatNow() {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

// 北京时间当天（YYYY-MM-DD）
function todayShanghai() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function daysBetween(fromDate, toDate) {
    return Math.round((Date.parse(toDate + 'T00:00:00') - Date.parse(fromDate + 'T00:00:00')) / 86400000);
}

// 全局新鲜度：本次同步涉及的选手里最新的比赛日期
function freshnessOf(wrIds) {
    let newest = '';
    let have = 0;
    wrIds.forEach(id => {
        const d = db.readPlayerData(id);
        if (!d || !Array.isArray(d.matches) || d.matches.length === 0) return;
        have++;
        const max = d.matches.reduce((m, x) => (x.date && x.date > m ? x.date : m), '');
        if (max > newest) newest = max;
    });
    return { newest, playersWithData: have, players: wrIds.length };
}

// 把客户端版本写进 meta：服务器 /api/status 可据此确认同步端跑的是哪一版代码
function stampClientMeta() {
    try {
        const meta = db.readMeta();
        meta.client = {
            version: require('./package.json').version,
            gitHead: (() => { try { return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch (e) { return ''; } })(),
            hostname: os.hostname(),
            cacheBust: true,
            staleGuardDays: 2,
            recordedAt: new Date().toISOString(),
        };
        db.writeMeta(meta);
    } catch (e) {
        console.log(`⚠ 写入客户端版本信息失败（已忽略）：${e.message}`);
    }
}

function readLogTail(limit = 25) {
    try {
        const p = path.join(__dirname, 'sync-local.log');
        if (!fs.existsSync(p)) return '(无 sync-local.log)';
        const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean);
        return lines.slice(-limit).join('\n') || '(日志为空)';
    } catch (e) {
        return `(读取日志失败：${e.message})`;
    }
}

function failureSummaryLines(result) {
    const lines = [];
    if (!result) return lines;
    const ft = result.failTypes || {};
    lines.push(`结果：成功 ${result.success}/${result.total}，失败 ${result.failed.length}`);
    lines.push(`失败分类：403拦截=${ft.forbidden || 0}，数据过期=${ft.stale || 0}，JSON解析=${ft.json || 0}，响应异常=${ft.contract || 0}，ID映射=${ft.idmap || 0}，网络/其它=${ft.other || 0}`);
    if (result.emptyWindow) lines.push(`窗口内 0 场：${result.emptyWindow} 人（休眠选手或无新比赛，非错误）`);
    if (result.failed.length > 0) {
        lines.push('', '错误行（日志摘录）：');
        result.failed.slice(0, 10).forEach(f => {
            lines.push(`✗ ${f.player.cnName}(${f.player.krName}) wrId=${f.player.wrId} ERROR: ${f.error}`);
        });
        if (result.failed.length > 10) lines.push(`… 其余 ${result.failed.length - 10} 条已省略`);
    }
    return lines;
}

async function sendFailureAlert(config, { reasonKey, title, mode, result, conclusion, extraLines }) {
    try {
        if (runAlerted) {
            console.log('⚠ 本次运行已发送过失败告警，跳过重复告警');
            return;
        }
        runAlerted = true;
        const lines = [
            `时间：${formatNow()}（Asia/Shanghai）`,
            `主机：${os.hostname()}`,
            `同步模式：${mode}`,
            ...failureSummaryLines(result),
        ];
        if (extraLines) lines.push('', '异常详情：', String(extraLines));
        lines.push('', `结论：${conclusion}`, '', '最近同步日志（sync-local.log 末尾 25 行）：', readLogTail(25));
        await mailAlert.notify(config, { reasonKey, subject: `[SC Stats 同步失败] ${title} · ${formatNow()}`, text: lines.join('\n') });
    } catch (e) {
        // 告警本身绝不抛出，避免影响同步结果与退出码
        console.log(`⚠ 失败告警流程出错（已忽略）：${e.message}`);
    }
}

// 上传失败统一入口：先告警再抛错（告警失败也不影响抛错/退出码）
async function uploadWithAlert(config, wrIds, mode) {
    try {
        await uploadToServer(config.server, config.token, wrIds);
        uploadDone = true;
    } catch (e) {
        await sendFailureAlert(config, {
            reasonKey: 'upload-failed',
            title: '上传服务器失败',
            mode,
            result: null,
            conclusion: '线上数据未更新（上传失败，服务器仍为上一次成功上传的数据）',
            extraLines: e.message,
        });
        throw e;
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

    // --test-mail：立即发一封测试告警邮件（验证 SMTP 凭据，不触发同步）
    if (opts.testMail) {
        console.log('=== --test-mail：发送测试告警邮件 ===');
        const conf = mailAlert.resolveConfig(config);
        if (!conf.enabled) {
            console.error(conf.configured
                ? '✗ 告警已禁用（mail.enabled=false 或 SC_ALERT_ENABLED=0）'
                : '✗ 未配置 SMTP 凭据：请在 local.config.json 的 mail.user / mail.pass 填入 163 邮箱和客户端授权码（或用 SC_ALERT_SMTP_USER / SC_ALERT_SMTP_PASS 环境变量）');
            process.exit(2);
        }
        try {
            await mailAlert.send(conf, {
                subject: `[SC Stats 测试邮件] ${formatNow()}`,
                text: [
                    '这是一封同步失败告警的测试邮件。',
                    '',
                    `时间：${formatNow()}（Asia/Shanghai）`,
                    `主机：${os.hostname()}`,
                    `SMTP：${conf.host}:${conf.port}（secure=${conf.secure}）`,
                    `收件人：${conf.to}`,
                    '',
                    '收到此邮件说明 SMTP 凭据与网络均可用。',
                ].join('\n'),
            });
            console.log(`✓ 测试邮件已发送至 ${conf.to}`);
            process.exit(0);
        } catch (e) {
            console.error(`✗ 测试邮件发送失败：${e.message}`);
            process.exit(1);
        }
    }

    // --upload-only：跳过抓取，直接推送本地已有数据（服务器恢复可达后补传用）
    if (opts.uploadOnly) {
        console.log('=== --upload-only：跳过抓取，直接推送本地数据 ===');
        await uploadWithAlert(config, undefined, '--upload-only');
        return;
    }

    let players = parsePlayersFromMd();
    if (opts.wrIds.length > 0) {
        players = players.filter(p => opts.wrIds.includes(p.wrId));
        console.log(`测试模式：只同步 ${players.length} 个选手`);
    }

    // --avatars-only：只补头像（选手数据不重抓；头像 URL 取自本地已同步数据）
    if (opts.avatarsOnly) {
        console.log(`=== --avatars-only：下载 ${players.length} 个选手头像 ===`);
        const { browser, context, launchedPid } = await attachChrome();
        let apiPage = null;
        try {
            apiPage = await openApiPage(context);
            await downloadAvatars(context, players);
        } finally {
            if (apiPage) await apiPage.close().catch(() => {});
            await browser.close();
            if (launchedPid) {
                await sleep(1500);
                killPidTree(launchedPid);
                console.log('✓ 专用 Chrome 已关闭');
            }
        }
        // 头像上传到服务器（uploadToServer 会连带打包本地选手数据）
        await uploadWithAlert(config, undefined, '--avatars-only');
        return;
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
        console.log(`=== 附着 Chrome 页面内 fetch 同步 ${players.length} 个选手 ===`);
    }
    const uploadWrIds = players.map(p => p.wrId); // 上传只传本次同步过的选手（增量减小传输量）
    const modeText = isFull
        ? (autoFull ? '全量（自动触发）' : '全量（--full）')
        : (opts.wrIds.length > 0 ? `指定选手（${players.length} 人）` : '增量');

    const { browser, context, launchedPid } = await attachChrome();
    let syncOk = false;
    let apiPage = null;
    let result = null;
    try {
        // 打开 eloboard 页面：既是抓取载体（页面内 fetch），也做一次 API 可用性探测
        apiPage = await openApiPage(context);

        db.setFetcher(makeApiFetcher(apiPage));

        // ID 映射缺失或 --rebuild-id-map 时，同步前先重建映射
        const idMapFile = path.join(__dirname, 'data', 'player-id-map.json');
        let hasIdMap = false;
        try { hasIdMap = !!JSON.parse(fs.readFileSync(idMapFile, 'utf8')).oldToNew; } catch (e) {}
        if (!hasIdMap || opts.rebuildIdMap) {
            if (!opts.rebuildIdMap) console.log('⚠ 缺少 ID 映射文件，自动重建…');
            await rebuildIdMap(apiPage, players);
        }
        result = await db.syncAll(players, { concurrency: 1, delay: 800, silent: false, full: isFull });
        await downloadAvatars(context, players); // 同步完趁浏览器会话还在，下载头像
        syncOk = true;
    } finally {
        if (apiPage) await apiPage.close().catch(() => {});
        await browser.close(); // 只断开 CDP 连接
        // 若 Chrome 由本脚本启动，同步结束后关闭（过盾 cookie 已持久化在 profile）
        if (launchedPid) {
            await sleep(1500); // 给 Chrome 一点时间将 cookie 落盘
            killPidTree(launchedPid);
            console.log('✓ 专用 Chrome 已关闭');
        }
    }

    if (!syncOk) throw new Error('同步过程出错');
    // 0 成功 = 抓取链路整体失效（历史上曾因 403 全失败却继续上传，形成“假成功”）；直接失败退出
    if (result && players.length > 0 && result.success === 0) {
        console.error(`✗ 同步失败：${players.length} 个选手全部失败（0 成功），本次没有产生任何新数据，已跳过上传`);
        await sendFailureAlert(config, {
            reasonKey: 'zero-success',
            title: '0 个选手同步成功',
            mode: modeText,
            result,
            conclusion: '线上数据未更新（本次 0 人成功，已跳过上传；服务器仍为上一次成功同步的数据）',
        });
        throw new Error('0 个选手同步成功（疑似数据源拦截或接口异常）');
    }

    // ---- 全局新鲜度断言 ----
    // 防"看似成功其实抓到旧快照"：2026-11-08 起同步端连续 5 天 60 人全部"成功"，
    // 但 /api/matches 返回的一直是 11-07 的快照，页面因此一直停在 11-06/11-07。
    // 分级：落后 ≥3 天视为链路整体失效（告警 + 阻断，不上传旧快照后推进计时器）；
    //       落后 2 天可能只是赛程空档（告警但继续上传）；≤1 天正常。
    // 注意：只在全量/增量整库同步时断言——指定选手（测试模式）只抓 1 人，
    //       休眠选手最近没比赛是正常现象，不代表链路过期（2026-11-13 曾误报）。
    const isWholeLibraryRun = opts.wrIds.length === 0;
    const fresh = freshnessOf(players.map(p => p.wrId));
    const lagDays = fresh.newest ? daysBetween(fresh.newest, todayShanghai()) : Infinity;
    stampClientMeta();
    if (isWholeLibraryRun && fresh.playersWithData > 0 && lagDays >= 2) {
        const lines = [
            `最新比赛：${fresh.newest}（今天 ${todayShanghai()}，落后 ${lagDays} 天）`,
            `涉及选手：${fresh.playersWithData} 人有比赛数据`,
            '排查顺序：①抓取 URL 是否带 _t 缓存参数（应随每次请求变化）',
            '②同步端网络出口是否命中 CDN/代理缓存（换网络或用手机热点复测）',
            '③eloboard 站点是否改版（页面内 fetch 的 /api 结构变化）',
        ].join('\n');
        if (lagDays >= 3) {
            console.error(`✗ 数据过期：最新比赛 ${fresh.newest}，落后今天（${todayShanghai()}）${lagDays} 天，跳过上传`);
            await sendFailureAlert(config, {
                reasonKey: 'stale-data',
                title: '抓到的比赛数据整体过期',
                mode: modeText,
                result,
                conclusion: '线上数据未更新（本次抓到的比赛数据整体过期，已跳过上传；疑似 eloboard /api 中间层缓存或接口降级）',
                extraLines: lines,
            });
            throw new Error(`数据过期：最新比赛 ${fresh.newest}，落后今天 ${lagDays} 天（疑似中间层缓存）`);
        }
        console.log(`⚠ 最新比赛 ${fresh.newest}（落后今天 ${lagDays} 天）——可能为赛程空档，继续上传，仅发提醒`);
        await sendFailureAlert(config, {
            reasonKey: 'stale-data-soft',
            title: '最新比赛已落后 ' + lagDays + ' 天（提醒）',
            mode: modeText,
            result,
            conclusion: '线上数据已更新（落后 2 天，未达 3 天阻断阈值；若连续多天如此请排查）',
            extraLines: lines,
        });
    } else {
        console.log(`✓ 数据新鲜：最新比赛 ${fresh.newest}`);
    }

    // 部分失败：失败占比达到阈值（默认 20%，配置 mail.failRatioThreshold）也告警
    const mailConf = mailAlert.resolveConfig(config);
    const failRatioLimit = Number.isFinite(mailConf.failRatio) ? mailConf.failRatio : 0.2;
    const partialFailed = result && result.failed.length > 0 && players.length > 0
        && (result.failed.length / players.length) >= failRatioLimit;

    if (opts.noUpload) {
        console.log('\n--no-upload：跳过上传');
        if (partialFailed) {
            await sendFailureAlert(config, {
                reasonKey: 'partial-failure',
                title: `部分选手失败（${result.success}/${players.length} 成功）`,
                mode: modeText,
                result,
                conclusion: '本地数据部分更新；本次为 --no-upload，线上数据未更新',
            });
        }
        return;
    }
    await uploadWithAlert(config, uploadWrIds, modeText);
    if (partialFailed) {
        await sendFailureAlert(config, {
            reasonKey: 'partial-failure',
            title: `部分选手失败（${result.success}/${players.length} 成功）`,
            mode: modeText,
            result,
            conclusion: `线上数据已部分更新：${result.success} 人已上传，失败 ${result.failed.length} 人未更新`,
        });
    }
}

main().then(() => {
    console.log(`\n全部完成 ${new Date().toLocaleString()}`);
    process.exit(0);
}).catch(async e => {
    console.error('失败:', e.message);
    // 异常退出同样告警（0 成功/上传失败已发过告警的不重复发）
    if (!runAlerted) {
        let config = null;
        try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e2) { /* 配置缺失时仍可用环境变量告警 */ }
        await sendFailureAlert(config, {
            reasonKey: 'exception',
            title: '脚本异常退出',
            mode: '未知（同步未完成）',
            result: null,
            conclusion: uploadDone ? '线上数据已更新（异常发生在上传完成之后）' : '线上数据未更新（本次同步未完成）',
            extraLines: `${e.message}\n${String(e.stack || '').split('\n').slice(0, 4).join('\n')}`,
        });
    }
    process.exit(1);
});
