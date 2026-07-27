/**
 * sync.js — 数据同步脚本（命令行）
 *
 * 用法：
 *   node sync.js              # 全量同步所有选手（从 docs/韩国选手个人主页列表.md 读取）
 *   node sync.js 15           # 同步单个选手（按 wrId）
 *   node sync.js 15 42        # 同步多个选手
 *   node sync.js --status     # 查看本地数据库状态
 *
 * 选项：
 *   --concurrency=N           # 并发数（默认 3）
 *   --delay=N                 # 批次间隔毫秒（默认 1500，对服务器友好）
 *   --silent                  # 静默模式
 *
 * 全量同步约需：60 选手 × ~30秒 / 3并发 ≈ 10 分钟
 * 增量同步：只同步单选手约 30 秒
 */
const path = require('path');
const fs = require('fs');
const db = require('./db');

// ---- Parse players from markdown ----
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
    const opts = { concurrency: 3, delay: 1500, silent: false, wrIds: [], status: false };
    for (const a of args) {
        if (a === '--status') opts.status = true;
        else if (a === '--silent') opts.silent = true;
        else if (a.startsWith('--concurrency=')) opts.concurrency = parseInt(a.split('=')[1]) || 3;
        else if (a.startsWith('--delay=')) opts.delay = parseInt(a.split('=')[1]) || 0;
        else if (/^\d+$/.test(a)) opts.wrIds.push(a);
    }
    return opts;
}

async function main() {
    const opts = parseArgs();

    if (opts.status) {
        const stats = db.getStats();
        console.log('=== 本地数据库状态 ===');
        console.log(`数据目录: ${stats.dataDir}`);
        console.log(`已入库选手: ${stats.playerFiles} / 60`);
        console.log(`比赛记录总数: ${stats.totalMatches}`);
        console.log(`上次全量同步: ${stats.lastFullSync || '从未'}`);
        return;
    }

    db.ensureDirs();

    // sync specific wrIds or all
    let players;
    if (opts.wrIds.length > 0) {
        const all = parsePlayersFromMd();
        players = opts.wrIds.map(id => all.find(p => p.wrId === id)).filter(Boolean);
        if (players.length === 0) {
            // wrId not in md, sync anyway with minimal info
            players = opts.wrIds.map(id => ({ wrId: id, cnName: '?', krName: '?', playerId: '?' }));
        }
        console.log(`同步 ${players.length} 个选手: ${players.map(p => p.wrId).join(', ')}`);
        for (const p of players) {
            try {
                await db.syncPlayer(p.wrId, { silent: opts.silent });
                const d = db.readPlayerData(p.wrId);
                if (d && !opts.silent) {
                    console.log(`  ✓ ${p.cnName || '?'}(${p.krName || '?'}) wrId=${p.wrId} race=${d.race} matches=${d.matchCount}`);
                }
            } catch (e) {
                console.error(`  ✗ wrId=${p.wrId} 失败: ${e.message}`);
            }
        }
        console.log('完成');
    } else {
        players = parsePlayersFromMd();
        console.log(`=== 全量同步 ${players.length} 个选手 ===`);
        console.log(`并发: ${opts.concurrency}, 批次间隔: ${opts.delay}ms`);
        console.log(`预计耗时: ~${Math.ceil(players.length * 30 / opts.concurrency / 60)} 分钟\n`);
        await db.syncAll(players, { concurrency: opts.concurrency, delay: opts.delay, silent: opts.silent });
    }
}

main().catch(e => {
    console.error('同步出错:', e.message);
    process.exit(1);
});
