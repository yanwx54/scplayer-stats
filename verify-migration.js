// 迁移后完整校验：本地数据 vs API 官方数据一致性
const fs = require('fs');
const path = require('path');
const db = require('./db');

function parsePlayersFromMd() {
    const text = fs.readFileSync(path.join(__dirname, 'docs', '韩国选手个人主页列表.md'), 'utf8');
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

const all = JSON.parse(fs.readFileSync('diag-all-players.json', 'utf8'));
const idMap = JSON.parse(fs.readFileSync('data/player-id-map.json', 'utf8'));
const byNewId = {};
all.forEach(p => { if (!byNewId[p.id] || (p.games||0) > (byNewId[p.id].games||0)) byNewId[p.id] = p; });

const players = parsePlayersFromMd();
console.log('=== 1. 本地最新日期 vs API last_played_on ===');
let mismatch = 0, ok = 0;
const rows = [];
for (const p of players) {
    const newId = idMap.oldToNew[p.wrId];
    const api = byNewId[newId];
    const d = db.readPlayerData(p.wrId);
    if (!d || !d.matches || !d.matches.length) { rows.push([p.cnName, '无数据', '', '']); continue; }
    const localNewest = d.matches.reduce((max, m) => (m.date > max ? m.date : max), '');
    const apiLast = api ? (api.last_played_on || '') : '?';
    const status = localNewest === apiLast ? 'OK' : 'DIFF';
    if (status === 'OK') ok++; else mismatch++;
    rows.push([p.cnName, localNewest, apiLast, status]);
}
rows.sort((a, b) => (a[1] < b[1] ? -1 : 1));
rows.forEach(r => console.log(`  ${String(r[1]).padEnd(12)} 本地=${r[1]||'-'} API=${r[2]||'-'} ${r[3]} ${r[0]}`));
console.log(`一致: ${ok}, 不一致: ${mismatch}`);

console.log('\n=== 2. 数据完整性抽查（所有选手）===');
let totalDup = 0, noStory = 0, noMap = 0, notApi = 0;
for (const p of players) {
    const d = db.readPlayerData(p.wrId);
    if (!d) continue;
    if (d.source !== 'api') { notApi++; console.log(`  ⚠ ${p.cnName} source=${d.source}`); }
    const keyOf = m => `${m.date}|${m.oppWrId||''}|${m.mapKr||m.mapName}|${m.format}|${m.isWin?'W':'L'}`;
    const seen = {}; let dup = 0;
    d.matches.forEach(m => { const k = keyOf(m); if (seen[k]) dup++; seen[k]=1; });
    totalDup += dup;
    if (!d.storyByOpp || !Object.keys(d.storyByOpp).length) noStory++;
    if (!d.mapStats || !Object.keys(d.mapStats).length) noMap++;
}
console.log(`  source!=api: ${notApi} | 键碰撞总数(含合法멸망전多场): ${totalDup} | storyByOpp缺失: ${noStory} | mapStats缺失: ${noMap}`);

console.log('\n=== 3. 近期新数据抽查（8-27 之后）===');
let recentTotal = 0;
for (const p of players) {
    const d = db.readPlayerData(p.wrId);
    if (!d) continue;
    const recent = d.matches.filter(m => m.date >= '2026-08-27');
    if (recent.length) {
        recentTotal += recent.length;
        const opps = {};
        recent.forEach(m => { const k = m.oppWrId; opps[k] = (opps[k]||0)+1; });
        console.log(`  ${p.cnName}: ${recent.length}场 (${recent[0].date}~${recent[recent.length-1].date})`);
    }
}
console.log(`  8-27后总场次: ${recentTotal}`);

console.log('\n=== 4. H2H 抽查（조일장 vs 이재호，8-30 有交战）===');
const h = db.computeH2H('13', '33');
if (h) {
    console.log(`  总场次=${h.totalMatches} p1胜=${h.player1.wins} p2胜=${h.player2.wins}`);
    console.log(`  近30天: p1=${h.player1.recentWins} p2=${h.player2.recentWins}`);
    console.log(`  地图数据条数: ${h.mapData.length}`);
}
const rm = db.computeRecentMatches('13', '33');
console.log(`  交战记录(90天): ${rm.count}场`);
const rmRecent = rm.recentMatches.filter(m => m.date >= '2026-08-29');
console.log(`  其中8-29后: ${rmRecent.length}场`);
rmRecent.slice(0,5).forEach(m => console.log(`    ${m.date} ${m.winner==='p1'?'조일장胜':'이재호胜'} ${m.mapKr||m.mapName} ${m.format} ${m.eloChange}`));

console.log('\n=== 5. 地图统计抽查（永镇）===');
const ms = db.computeMapStats('12');
console.log(`  总胜负: ${ms.totalWins}胜${ms.totalLosses}负 | 对阵列: ${ms.matchupKeys.join(',')}`);
ms.mapStats.slice(0, 3).forEach(m => {
    console.log(`  ${m.mapCn}(${m.mapKr}): ${JSON.stringify(m.total)}`);
});
