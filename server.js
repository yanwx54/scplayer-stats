const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = 'http://eloboard.com/men';
const FIGHT_LIST_URL = `${BASE_URL}/bbs/fight_list.php`;
const FIGHT_PAGE_URL = `${BASE_URL}/bbs/board.php?bo_table=fight_list`;
const PLAYERS_MD = path.join(__dirname, 'docs', '韩国选手个人主页列表.md');
const MAPS_JSON = path.join(__dirname, 'public', 'maps.json');

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const MAPS_CONFIG = JSON.parse(fs.readFileSync(MAPS_JSON, 'utf8'));
const SEASON_MAPS = MAPS_CONFIG.maps;

function normalize(s) { return (s || '').replace(/\s+/g, '').trim().toLowerCase(); }

function matchSeasonMap(mapName) {
    const a = normalize(mapName);
    if (!a) return null;
    return SEASON_MAPS.find(m => {
        const b = normalize(m.kr);
        return a === b || a.includes(b);
    }) || null;
}

function parsePlayersFromMd() {
    const text = fs.readFileSync(PLAYERS_MD, 'utf8');
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
    return players;
}

function parsePlayerNameRace(displayName) {
    if (!displayName) return { name: '', race: '' };
    const match = displayName.match(/^(.+?)([TZP])?$/);
    if (match) return { name: match[1], race: match[2] || '' };
    return { name: displayName, race: '' };
}

// fight cache (still remote, ~3.5s) — keep 1h TTL
const fightCache = new Map();
const FIGHT_CACHE_TTL = 60 * 60 * 1000;

// ---- API: season maps ----
app.get('/api/maps', (req, res) => res.json(MAPS_CONFIG));

// ---- API: player list ----
app.get('/api/players', (req, res) => {
    try { res.json(parsePlayersFromMd()); }
    catch (e) { res.status(500).json({ error: 'Failed to load players', detail: e.message }); }
});

// ---- API: db status ----
app.get('/api/status', (req, res) => {
    res.json(db.getStats());
});

// ---- API: sync a single player on demand ----
// eloboard 已启用 Cloudflare 反爬，服务器端直抓不可用；数据由本地 local-sync.js 过盾抓取后推送
app.get('/api/sync-player', (req, res) => {
    res.json({ ok: false, message: '数据源已启用反爬保护，服务器端同步已停用（数据由本地电脑自动同步推送）' });
});

// ---- API: full sync all players ----
app.get('/api/sync-all', (req, res) => {
    res.json({ ok: false, message: '数据源已启用反爬保护，服务器端同步已停用（数据由本地电脑自动同步推送）' });
});

// ---- API: 本地同步工具数据上传（Bearer token 认证）----
// token 存于 data/upload-token.txt（不入 git），本地 local.config.json 配同一 token
const UPLOAD_TOKEN_FILE = path.join(__dirname, 'data', 'upload-token.txt');
let UPLOAD_TOKEN = null;
try { UPLOAD_TOKEN = fs.readFileSync(UPLOAD_TOKEN_FILE, 'utf8').trim() || null; } catch (e) {}
if (!UPLOAD_TOKEN) console.log('⚠ 未配置上传 token（data/upload-token.txt），/api/upload-data 不可用');

function atomicWrite(file, content) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
}

app.post('/api/upload-data', express.json({ limit: '30mb' }), (req, res) => {
    if (!UPLOAD_TOKEN) return res.status(503).json({ error: '上传未启用：请在服务器创建 data/upload-token.txt' });
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + UPLOAD_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    const { meta, players, avatars } = req.body || {};
    if (!players || typeof players !== 'object') return res.status(400).json({ error: 'players required' });

    const playersDir = path.join(__dirname, 'data', 'players');
    fs.mkdirSync(playersDir, { recursive: true });
    let count = 0;
    for (const [wrId, data] of Object.entries(players)) {
        if (!/^\d+$/.test(wrId) || !data) continue; // wrId 只允许纯数字，防路径注入
        atomicWrite(path.join(playersDir, wrId + '.json'), JSON.stringify(data));
        count++;
    }
    if (meta) atomicWrite(path.join(__dirname, 'data', 'meta.json'), JSON.stringify(meta, null, 2));

    // 头像（base64 → data/avatars/{wrId}.{ext}，经 /avatars 静态提供）
    let avatarCount = 0;
    if (avatars && typeof avatars === 'object') {
        const avDir = path.join(__dirname, 'data', 'avatars');
        fs.mkdirSync(avDir, { recursive: true });
        for (const [name, b64] of Object.entries(avatars)) {
            if (!/^\d+\.(jpg|jpeg|png|gif|webp)$/.test(name)) continue; // 文件名白名单，防路径注入
            try {
                atomicWrite(path.join(avDir, name), Buffer.from(b64, 'base64'));
                avatarCount++;
            } catch (e) { console.warn(`[upload] 头像写入失败 ${name}: ${e.message}`); }
        }
    }

    console.log(`[upload] 收到并写入 ${count} 个选手数据${avatarCount > 0 ? `，${avatarCount} 个头像` : ''}`);
    res.json({ ok: true, playersWritten: count, avatarsWritten: avatarCount });
});

// ---- API: head-to-head (local-first, remote fallback) ----
app.get('/api/fight', async (req, res) => {
    try {
        const { player1, player2, wrId1, wrId2 } = req.query;
        if (!player1 || !player2) return res.status(400).json({ error: 'Both player1 and player2 are required' });

        // 本地优先：双方均有本地数据时毫秒级返回（无远程请求）
        if (wrId1 && wrId2) {
            const local = db.computeH2H(wrId1, wrId2);
            if (local) {
                const players = parsePlayersFromMd();
                const p1Def = players.find(p => p.wrId === wrId1);
                const p2Def = players.find(p => p.wrId === wrId2);
                if (p1Def) {
                    local.player1.name = p1Def.krName;
                    local.player1.displayName = p1Def.krName + (local.player1.race || '');
                }
                if (p2Def) {
                    local.player2.name = p2Def.krName;
                    local.player2.displayName = p2Def.krName + (local.player2.race || '');
                }
                return res.json(local);
            }
        }

        const cacheKey = `${player1}|${player2}`;
        const cached = fightCache.get(cacheKey);
        if (cached && (Date.now() - cached.time) < FIGHT_CACHE_TTL) return res.json(cached.data);

        const formData = new URLSearchParams();
        formData.append('wr_1', player1);
        formData.append('wr_11', player2);
        formData.append('wr_111', '');
        formData.append('sear', '');
        formData.append('b_id', 'eloboard');

        const response = await axios.post(FIGHT_LIST_URL, formData.toString(), {
            headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': FIGHT_PAGE_URL, 'X-Requested-With': 'XMLHttpRequest' },
            timeout: 30000,
        });

        const $ = cheerio.load(response.data);
        const summaryTable = $('table').first();
        const p1Cell = summaryTable.find('td').eq(0);
        const p2Cell = summaryTable.find('td').eq(4);
        const p1Img = p1Cell.find('img').attr('src') || '';
        const p2Img = p2Cell.find('img').attr('src') || '';
        const p1Href = p1Cell.find('a').attr('href') || '';
        const p2Href = p2Cell.find('a').attr('href') || '';
        const p1WrIdMatch = p1Href.match(/wr_id=(\d+)/);
        const p2WrIdMatch = p2Href.match(/wr_id=(\d+)/);
        const p1Text = p1Cell.text().replace(p1Img, '').trim();
        const p2Text = p2Cell.text().replace(p2Img, '').trim();
        const p1Info = parsePlayerNameRace(p1Text);
        const p2Info = parsePlayerNameRace(p2Text);

        const row1Spans = summaryTable.find('tr').first().find('span');
        console.log('[fight] row1Spans count:', row1Spans.length, 'p1Text:', p1Text, 'p2Text:', p2Text);
        const player1Wins = parseInt(row1Spans.eq(0).text().trim()) || 0;
        const player1WinRate = row1Spans.eq(1).text().trim();
        const player1Elo = row1Spans.eq(2).text().trim();
        const player2Wins = parseInt(row1Spans.eq(4).text().trim()) || 0;
        const player2WinRate = row1Spans.eq(5).text().trim();
        const player2Elo = row1Spans.eq(6).text().trim();

        const recentSpans = summaryTable.find('tr').eq(1).find('span');
        const player1RecentWins = parseInt(recentSpans.eq(0).text().trim()) || 0;
        const player2RecentWins = parseInt(recentSpans.eq(1).text().trim()) || 0;

        const oppCells = summaryTable.find('tr').eq(2).find('td');
        const extractOpponents = (cell) => {
            const out = [];
            cell.find('a').each((i, el) => {
                const text = $(el).text().trim();
                const href = $(el).attr('href') || '';
                const m = href.match(/wr_id=(\d+)/);
                if (text) out.push({ text, wrId: m ? m[1] : null });
            });
            return out;
        };
        const player1Opponents = extractOpponents(oppCells.eq(0));
        const player2Opponents = extractOpponents(oppCells.eq(2));

        const fightMapData = [];
        const seenMaps = new Set();
        $('.list-board table tbody tr').each((i, el) => {
            const tds = $(el).find('td');
            if (tds.length !== 3) return;
            const p1MapWins = parseInt($(tds[0]).text().trim()) || 0;
            const mapName = $(tds[1]).text().trim();
            const p2MapWins = parseInt($(tds[2]).text().trim()) || 0;
            const matched = matchSeasonMap(mapName);
            if (!matched) return;
            const key = normalize(matched.kr);
            if (seenMaps.has(key)) return;
            seenMaps.add(key);
            fightMapData.push({ mapKr: matched.kr, mapCn: matched.cn, mapFull: matched.full, player1Wins: p1MapWins, player2Wins: p2MapWins, total: p1MapWins + p2MapWins });
        });
        fightMapData.sort((a, b) => SEASON_MAPS.findIndex(m => normalize(m.kr) === normalize(a.mapKr)) - SEASON_MAPS.findIndex(m => normalize(m.kr) === normalize(b.mapKr)));

        const result = {
            player1: { name: p1Info.name, race: p1Info.race, displayName: p1Text, image: p1Img, wrId: p1WrIdMatch ? p1WrIdMatch[1] : null, wins: player1Wins, winRate: player1WinRate, elo: player1Elo, recentWins: player1RecentWins, topOpponents: player1Opponents },
            player2: { name: p2Info.name, race: p2Info.race, displayName: p2Text, image: p2Img, wrId: p2WrIdMatch ? p2WrIdMatch[1] : null, wins: player2Wins, winRate: player2WinRate, elo: player2Elo, recentWins: player2RecentWins, topOpponents: player2Opponents },
            totalMatches: player1Wins + player2Wins,
            mapData: fightMapData,
        };

        fightCache.set(cacheKey, { data: result, time: Date.now() });
        res.json(result);
    } catch (error) {
        console.error('Error fetching fight data:', error.message);
        res.status(500).json({ error: 'Failed to fetch fight data', detail: error.message });
    }
});

// ---- API: player map stats — LOCAL DB, instant ----
app.get('/api/player-map-stats', (req, res) => {
    try {
        const { wrId } = req.query;
        if (!wrId) return res.status(400).json({ error: 'wrId is required' });
        const stats = db.computeMapStats(wrId);
        if (!stats) return res.status(404).json({ error: '本地无此选手数据，请先同步', wrId });
        res.json(stats);
    } catch (error) {
        console.error('Error computing map stats:', error.message);
        res.status(500).json({ error: 'Failed', detail: error.message });
    }
});

// ---- API: recent matches — 纯本地查询，毫秒级 ----
app.get('/api/recent-matches', (req, res) => {
    try {
        const { wrId1, wrId2 } = req.query;
        if (!wrId1 || !wrId2) return res.status(400).json({ error: 'wrId1 and wrId2 are required' });
        const result = db.computeRecentMatches(wrId1, wrId2);
        res.json(result);
    } catch (error) {
        console.error('Error computing recent matches:', error.message);
        res.status(500).json({ error: 'Failed', detail: error.message });
    }
});

// 头像本地静态服务（eloboard 外链被 Cloudflare 拦，头像已随同步本地化）
app.use('/avatars', express.static(path.join(__dirname, 'data', 'avatars')));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    const stats = db.getStats();
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Players: ${parsePlayersFromMd().length}, Season maps: ${SEASON_MAPS.length}`);
    console.log(`Local DB: ${stats.playerFiles}/60 players, ${stats.totalMatches} matches, last sync: ${stats.lastFullSync || 'never'}`);
    if (stats.playerFiles === 0) {
        console.log('\n⚠ 本地数据库为空！请运行: node sync.js  (全量同步，约10分钟)');
    }
});
