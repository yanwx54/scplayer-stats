/**
 * db.js — 本地数据层
 * 存储：每选手一个 JSON 文件（data/players/{wrId}.json），含选手元数据 + 全部比赛记录
 * 优势：零依赖、读取 <5ms、易维护、增量更新简单
 * 预计总量：60 选手 × ~150KB ≈ 9MB
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_DIR = path.join(DATA_DIR, 'players');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const H2H_DIR = path.join(DATA_DIR, 'h2h'); // 双人全量对战缓存（来自网页 storyb 详情）

const BASE_URL = 'http://eloboard.com/men';
const PLAYER_PAGE_URL = (wrId) => `${BASE_URL}/bbs/board.php?bo_table=bj_list&wr_id=${wrId}`;

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const RACE_FULL = { Terran: 'T', Zerg: 'Z', Protoss: 'P' };

// ---- Season maps (shared with server) ----
const MAPS_JSON = path.join(__dirname, 'public', 'maps.json');
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

function extractOpponentRace(cellText) {
    const m = cellText.match(/\(([TZP])\)/);
    return m ? m[1] : '';
}

// ELO 变化取反：eloChange 是 wrId1 视角的字符串（如 "+22.2"/"-10.0"），
// 胜者为 wrId2 时需取反以显示胜者本人的加分
function invertElo(elo) {
    if (!elo) return elo;
    const n = parseFloat(elo);
    if (isNaN(n)) return elo;
    const inverted = -n;
    return (inverted >= 0 ? '+' : '') + inverted.toFixed(1);
}

// 胜者加分（恒为正）：剥离韩文前缀 승/패，取数值绝对值，返回 "+X.X"
// storyb 抓取的 eloChange 形如 "승(+16.8)" / "패(-14.9)"，parseFloat 无法直接解析
function winnerGain(elo) {
    if (!elo) return '';
    const m = String(elo).match(/-?\d+(\.\d+)?/);
    if (!m) return '';
    const n = parseFloat(m[0]);
    if (isNaN(n)) return '';
    return '+' + Math.abs(n).toFixed(1);
}

// ---- Ensure dirs ----
function ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(PLAYERS_DIR)) fs.mkdirSync(PLAYERS_DIR, { recursive: true });
}

// ---- Meta (last sync time etc.) ----
function readMeta() {
    if (!fs.existsSync(META_FILE)) return { lastFullSync: null, playerSync: {} };
    try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); }
    catch { return { lastFullSync: null, playerSync: {} }; }
}

function writeMeta(meta) {
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

// ---- Read one player's data from local file ----
function readPlayerData(wrId) {
    const file = path.join(PLAYERS_DIR, `${wrId}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
}

// ---- Fetch + parse a player's page from eloboard ----
async function fetchAndParsePlayer(wrId) {
    const response = await axios.get(PLAYER_PAGE_URL(wrId), { headers, timeout: 45000 });
    const $ = cheerio.load(response.data);

    // extract race from 주종 row
    let race = '';
    $('th').each((i, el) => {
        if (race) return;
        if ($(el).text().trim() === '주종') {
            const val = $(el).next('td').text().trim();
            race = RACE_FULL[val] || '';
        }
    });

    // extract all match rows
    // 页面有多个 .list-board，比赛数据所在的那个不确定（不同选手 index 不同），
    // 遍历所有 .list-board，取含比赛数据行（td style 含 #0cf 胜/#434348 负）的那个
    const matches = [];
    let matchRows = null;
    $('.list-board').each((i, el) => {
        if (matchRows) return; // 已找到则跳过
        const trs = $(el).find('table tbody tr');
        trs.each((j, tr) => {
            if (matchRows) return;
            const firstTdStyle = ($(tr).find('td').first().attr('style') || '').toLowerCase();
            if (firstTdStyle.includes('#0cf') || firstTdStyle.includes('#434348')) {
                matchRows = trs;
            }
        });
    });

    if (matchRows) {
        matchRows.each((i, el) => {
            const tds = $(el).find('td');
            if (tds.length < 3) return;
            const bgStyle = ($(tds[0]).attr('style') || '').toLowerCase();
            const isWin = bgStyle.includes('#0cf');
            const isLoss = bgStyle.includes('#434348');
            if (!isWin && !isLoss) return;

        const dateText = $(tds[0]).text().trim();
        const dateMatch = dateText.match(/\d{4}-\d{2}-\d{2}/);
        const date = dateMatch ? dateMatch[0] : '';

        const oppCell = $(tds[1]);
        const oppText = oppCell.text().trim();
        const oppHref = oppCell.find('a').attr('href') || '';
        const oppWrIdMatch = oppHref.match(/wr_id=(\d+)/);
        const oppRace = extractOpponentRace(oppText);

        const mapName = $(tds[2]).text().trim();
        const matched = matchSeasonMap(mapName);

        const eloChange = (tds[3] ? $(tds[3]).text().trim() : '') || '';
        const format = (tds[4] ? $(tds[4]).text().trim() : '') || '';
        const memo = (tds[5] ? $(tds[5]).text().trim() : '') || '';

        matches.push({
            date,
            oppWrId: oppWrIdMatch ? oppWrIdMatch[1] : null,
            oppRace,
            mapName,
            mapKr: matched ? matched.kr : '',
            mapCn: matched ? matched.cn : '',
            isSeasonMap: !!matched,
            isWin,
            eloChange,
            format,
            memo,
        });
    });
    }

    // 解析对手汇总 board 的 storyb 全量对战（vs 每个对手的生涯完整记录）
    // board 1 每行 td[5] 有 moreb{N} id，对应 #storyb{N} 内嵌套 table
    // 一次页面请求即可拿到该选手 vs 所有对手的全量对战，无需额外 HTTP 请求
    const storyByOpp = {};
    $('.list-board').each((i, el) => {
        $(el).find('table tbody tr').each((j, tr) => {
            const link = $(tr).find('a[href*="wr_id="]').first();
            if (!link.length) return;
            const href = link.attr('href') || '';
            const oppMatch = href.match(/wr_id=(\d+)/);
            if (!oppMatch) return;
            const oppWrId = oppMatch[1];

            // 对手汇总行 td[5] 含 moreb{N} id
            const td5 = $(tr).find('td').eq(5);
            const morebMatch = (td5.html() || '').match(/id="moreb(\d+)"/);
            if (!morebMatch) return;
            const storyId = morebMatch[1];

            const story = $(`#storyb${storyId}`);
            if (!story.length) return;

            const storyMatches = [];
            story.find('table tr').each((k, tr2) => {
                const tds2 = $(tr2).find('td');
                if (tds2.length < 5) return;
                const bgStyle2 = ($(tds2[0]).attr('style') || '').toLowerCase();
                const isWin2 = bgStyle2.includes('#0cf');
                const isLoss2 = bgStyle2.includes('#434348');
                if (!isWin2 && !isLoss2) return;

                const dateText2 = $(tds2[0]).text().trim();
                const dateMatch2 = dateText2.match(/\d{4}-\d{2}-\d{2}/);
                const mapName2 = $(tds2[1]).text().trim();
                const eloText2 = $(tds2[2]).text().trim();
                const format2 = $(tds2[3]).text().trim();
                const memo2 = $(tds2[4]).text().trim();

                storyMatches.push({
                    date: dateMatch2 ? dateMatch2[0] : '',
                    mapName: mapName2,
                    viewerWon: isWin2,
                    eloChange: eloText2,
                    format: format2,
                    memo: memo2,
                });
            });
            if (storyMatches.length > 0) storyByOpp[oppWrId] = storyMatches;
        });
    });

    return { wrId, race, matchCount: matches.length, matches, storyByOpp, fetchedAt: new Date().toISOString() };
}

// ---- Save player data to local file ----
function savePlayerData(wrId, data) {
    const file = path.join(PLAYERS_DIR, `${wrId}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
}

// ---- Sync one player (full re-fetch) ----
async function syncPlayer(wrId, opts = {}) {
    const data = await fetchAndParsePlayer(wrId);
    savePlayerData(wrId, data);

    const meta = readMeta();
    meta.playerSync = meta.playerSync || {};
    meta.playerSync[wrId] = { time: new Date().toISOString(), matchCount: data.matchCount };
    writeMeta(meta);

    if (!opts.silent) console.log(`  ✓ wrId=${wrId} race=${data.race} matches=${data.matchCount}`);
    return data;
}

// ---- Sync all players ----
async function syncAll(players, opts = {}) {
    ensureDirs();
    const concurrency = opts.concurrency || 3;
    const delay = opts.delay || 1500; // ms between batches, be polite to server
    let done = 0;
    const failed = [];

    for (let i = 0; i < players.length; i += concurrency) {
        const batch = players.slice(i, i + concurrency);
        const results = await Promise.allSettled(
            batch.map(p => syncPlayer(p.wrId, { silent: true }))
        );
        results.forEach((r, idx) => {
            const p = batch[idx];
            done++;
            if (r.status === 'fulfilled') {
                console.log(`  [${done}/${players.length}] ✓ ${p.cnName}(${p.krName}) wrId=${p.wrId} race=${r.value.race} matches=${r.value.matchCount}`);
            } else {
                console.log(`  [${done}/${players.length}] ✗ ${p.cnName}(${p.krName}) wrId=${p.wrId} ERROR: ${r.reason.message}`);
                failed.push({ player: p, error: r.reason.message });
            }
        });
        if (i + concurrency < players.length && delay > 0) {
            await new Promise(r => setTimeout(r, delay));
        }
    }

    const meta = readMeta();
    meta.lastFullSync = new Date().toISOString();
    writeMeta(meta);

    console.log(`\n同步完成: ${players.length - failed.length}/${players.length} 成功, ${failed.length} 失败`);
    if (failed.length > 0) {
        console.log('失败列表:', failed.map(f => `${f.player.cnName}(wrId=${f.player.wrId})`).join(', '));
    }
    return { total: players.length, success: players.length - failed.length, failed };
}

// ---- Compute map stats by matchup from local data ----
function computeMapStats(wrId) {
    const data = readPlayerData(wrId);
    if (!data) return null;

    const race = data.race || '?';
    const RACE_ORDER = ['T', 'Z', 'P'];
    const muKeys = race !== '?' ? RACE_ORDER.map(o => `${race}v${o}`) : [];

    // per-map per-matchup aggregation
    const statsByMap = {};
    const matchupTotals = {};
    muKeys.forEach(k => matchupTotals[k] = { wins: 0, losses: 0, total: 0 });
    let totalWins = 0, totalLosses = 0;

    data.matches.forEach(r => {
        if (!r.isSeasonMap) return; // season maps only
        const key = normalize(r.mapKr);
        if (!statsByMap[key]) {
            const mapDef = SEASON_MAPS.find(m => normalize(m.kr) === key) || { kr: r.mapKr, cn: r.mapCn };
            statsByMap[key] = { kr: mapDef.kr, cn: mapDef.cn, matchups: {} };
            muKeys.forEach(k => statsByMap[key].matchups[k] = { wins: 0, losses: 0, total: 0 });
        }
        const muKey = race !== '?' && r.oppRace ? `${race}v${r.oppRace}` : null;
        if (muKey && statsByMap[key].matchups[muKey]) {
            if (r.isWin) { statsByMap[key].matchups[muKey].wins++; matchupTotals[muKey].wins++; }
            else { statsByMap[key].matchups[muKey].losses++; matchupTotals[muKey].losses++; }
            statsByMap[key].matchups[muKey].total++;
            matchupTotals[muKey].total++;
        }
        if (r.isWin) totalWins++; else totalLosses++;
    });

    // build full season-map list
    const mapStats = SEASON_MAPS.map(m => {
        const key = normalize(m.kr);
        const s = statsByMap[key];
        const matchups = {};
        muKeys.forEach(k => {
            const mu = (s && s.matchups[k]) || { wins: 0, losses: 0, total: 0 };
            matchups[k] = { ...mu, winRate: mu.total > 0 ? ((mu.wins / mu.total) * 100).toFixed(1) + '%' : '-' };
        });
        let w = 0, l = 0;
        muKeys.forEach(k => { w += matchups[k].wins; l += matchups[k].losses; });
        const total = { wins: w, losses: l, total: w + l };
        total.winRate = total.total > 0 ? ((w / total.total) * 100).toFixed(1) + '%' : '-';
        return {
            mapKr: (s && s.kr) || m.kr,
            mapCn: (s && s.cn) || m.cn,
            mapFull: m.full,
            matchups,
            total,
        };
    });

    const muTotalsOut = {};
    muKeys.forEach(k => {
        const t = matchupTotals[k];
        muTotalsOut[k] = { ...t, winRate: t.total > 0 ? ((t.wins / t.total) * 100).toFixed(1) + '%' : '-' };
    });

    const totalMatches = totalWins + totalLosses;
    return {
        playerRace: race,
        matchupKeys: muKeys,
        totalWins, totalLosses, totalMatches,
        overallWinRate: totalMatches > 0 ? ((totalWins / totalMatches) * 100).toFixed(1) + '%' : '-',
        matchupTotals: muTotalsOut,
        mapStats,
    };
}

// ---- Compute recent head-to-head matches (last 3 months) ----
// 纯本地查询：从双方 storyByOpp（同步时已抓取的全量对战）合并，
// 毫秒级返回，无任何网络请求。
// storyByOpp 是同步时从 board 1 的 storyb{N} 详情解析的全量对战，
// 每条记录是 viewer 视角（viewerWon=true 表示该选手胜）。
function computeRecentMatches(wrId1, wrId2) {
    const now = Date.now();
    const windowMs = 90 * 24 * 60 * 60 * 1000;
    const inWindow = (date) => {
        if (!date) return false;
        const d = new Date(date + 'T00:00:00');
        const diff = now - d.getTime();
        return diff >= 0 && diff <= windowMs;
    };

    const d1 = readPlayerData(wrId1);
    const d2 = readPlayerData(wrId2);

    // 去重 key: date + mapName + 胜者 + format（区分同日同图同胜者的不同 SET）
    const seen = new Map();

    // 从 wrId1 主页的 storyByOpp[wrId2] 取全量对战（wrId1 视角）
    if (d1 && d1.storyByOpp && d1.storyByOpp[wrId2]) {
        d1.storyByOpp[wrId2].forEach(r => {
            if (!inWindow(r.date)) return;
            const matched = matchSeasonMap(r.mapName);
            const winner = r.viewerWon ? 'p1' : 'p2';
            const key = `${r.date}|${r.mapName}|${winner}|${r.format}`;
            if (!seen.has(key)) {
                seen.set(key, {
                    date: r.date,
                    mapKr: matched ? matched.kr : '',
                    mapCn: matched ? matched.cn : '',
                    mapName: r.mapName,
                    isSeasonMap: !!matched,
                    winner,
                    eloChange: winnerGain(r.eloChange),
                    format: r.format,
                    memo: r.memo,
                });
            }
        });
    }

    // 从 wrId2 主页的 storyByOpp[wrId1] 取全量对战（wrId2 视角，镜像：wrId2 胜 = p2 胜）
    if (d2 && d2.storyByOpp && d2.storyByOpp[wrId1]) {
        d2.storyByOpp[wrId1].forEach(r => {
            if (!inWindow(r.date)) return;
            const matched = matchSeasonMap(r.mapName);
            const winner = r.viewerWon ? 'p2' : 'p1';
            const key = `${r.date}|${r.mapName}|${winner}|${r.format}`;
            if (!seen.has(key)) {
                seen.set(key, {
                    date: r.date,
                    mapKr: matched ? matched.kr : '',
                    mapCn: matched ? matched.cn : '',
                    mapName: r.mapName,
                    isSeasonMap: !!matched,
                    winner,
                    eloChange: winnerGain(r.eloChange),
                    format: r.format,
                    memo: r.memo,
                });
            }
        });
    }

    // 补充 board 0 的近期数据（双保险：storyByOpp 没覆盖到的场景）
    const mapOne = (data, oppWrId, viewerIsP1) => {
        if (!data || !data.matches) return;
        data.matches
            .filter(r => r.oppWrId === oppWrId && inWindow(r.date))
            .forEach(r => {
                const viewerWon = r.isWin;
                const p1Won = viewerIsP1 ? viewerWon : !viewerWon;
                const winner = p1Won ? 'p1' : 'p2';
                const winnerElo = viewerWon ? r.eloChange : invertElo(r.eloChange);
                const key = `${r.date}|${r.mapName}|${winner}|${r.format}`;
                if (!seen.has(key)) {
                    seen.set(key, {
                        date: r.date,
                        mapKr: r.mapKr || r.mapName,
                        mapCn: r.isSeasonMap ? r.mapCn : '',
                        mapName: r.mapName,
                        isSeasonMap: r.isSeasonMap,
                        winner,
                        eloChange: winnerElo,
                        format: r.format,
                        memo: r.memo,
                    });
                }
            });
    };
    mapOne(d1, wrId2, true);
    mapOne(d2, wrId1, false);

    const recent = [...seen.values()]
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    return { count: recent.length, recentMatches: recent };
}

// ---- 从 eloboard 网页实时抓取双人全量对战（storyb 详情）----
// board 1 的对手汇总行 td[5] 有 moreb{N}，对应 storyb{N} TR 元素
// storyb{N} 内嵌套 table，每行是一场单场比赛（5 列：日期/地图/胜负elo/方式/备注）
// 双方主页互补：同一场在 wrId1 主页是「승(+16.8)」，在 wrId2 主页是「패(-16.8)」
const H2H_CACHE_TTL = 24 * 60 * 60 * 1000; // 1 天

function h2hCacheFile(wrId1, wrId2) {
    if (!fs.existsSync(H2H_DIR)) fs.mkdirSync(H2H_DIR, { recursive: true });
    // 文件名按 wrId 升序，确保 A_B 和 B_A 是同一文件
    const [a, b] = [wrId1, wrId2].sort();
    return path.join(H2H_DIR, `${a}_${b}.json`);
}

// 抓取某选手主页 board 1 里 vs oppWrId 的 storyb 详情
// 返回数组：[{date, mapName, viewerWon, eloChange, format, memo}]
async function fetchStoryMatches(viewerWrId, oppWrId) {
    const response = await axios.get(PLAYER_PAGE_URL(viewerWrId), { headers, timeout: 45000 });
    const $ = cheerio.load(response.data);
    const boards = $('.list-board');
    if (boards.length < 2) return [];
    const b1 = $(boards[1]);

    // 在 board 1 中找含 oppWrId 链接的对手汇总行
    let storyId = null;
    b1.find('table tbody tr').each((j, tr) => {
        if (storyId) return;
        if ($(tr).find(`a[href*="wr_id=${oppWrId}"]`).length > 0) {
            const td5 = $(tr).find('td').eq(5);
            const m = (td5.html() || '').match(/id="moreb(\d+)"/);
            if (m) storyId = m[1];
        }
    });
    if (!storyId) return [];

    const story = $(`#storyb${storyId}`);
    if (!story.length) return [];

    const matches = [];
    story.find('table tr').each((j, tr) => {
        const tds = $(tr).find('td');
        if (tds.length < 5) return;
        const bgStyle = ($(tds[0]).attr('style') || '').toLowerCase();
        const isWin = bgStyle.includes('#0cf');
        const isLoss = bgStyle.includes('#434348');
        if (!isWin && !isLoss) return;

        const dateText = $(tds[0]).text().trim();
        const dateMatch = dateText.match(/\d{4}-\d{2}-\d{2}/);
        const date = dateMatch ? dateMatch[0] : '';

        const mapName = $(tds[1]).text().trim();
        const eloText = $(tds[2]).text().trim();
        const format = $(tds[3]).text().trim();
        const memo = $(tds[4]).text().trim();

        matches.push({
            date,
            mapName,
            viewerWon: isWin,
            eloChange: eloText,
            format,
            memo,
        });
    });
    return matches;
}

// 异步抓取：从双方主页 storyb 合并全量对战，缓存 1 天
// 返回 { matches: [...], fetchedAt }
async function fetchH2HFromStory(wrId1, wrId2) {
    const cacheFile = h2hCacheFile(wrId1, wrId2);

    // 1. 先读缓存
    if (fs.existsSync(cacheFile)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (cached && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime() < H2H_CACHE_TTL)) {
                return cached;
            }
        } catch {}
    }

    // 2. 并发抓取双方主页
    const [m1, m2] = await Promise.all([
        fetchStoryMatches(wrId1, wrId2),
        fetchStoryMatches(wrId2, wrId1),
    ]);

    // 3. 合并去重：同一场在两边互为镜像，elo 数值相同符号相反
    // 去重 key 包含 format（如 "끝장전(1)" vs "끝장전(6)"），避免同日同图同胜者
    // 的多场比赛（如 SET 1 和 SET 6）被误判为重复
    const seen = new Map();
    m1.forEach(r => {
        const matched = matchSeasonMap(r.mapName);
        const key = `${r.date}|${r.mapName}|${r.viewerWon ? 'p1' : 'p2'}|${r.format}`;
        if (!seen.has(key)) {
            seen.set(key, {
                date: r.date, mapName: r.mapName,
                mapKr: matched ? matched.kr : '',
                mapCn: matched ? matched.cn : '',
                isSeasonMap: !!matched,
                viewer1Won: r.viewerWon,
                eloChange: winnerGain(r.eloChange), format: r.format, memo: r.memo,
            });
        }
    });
    m2.forEach(r => {
        const matched = matchSeasonMap(r.mapName);
        const viewer1Won = !r.viewerWon; // 镜像：viewer2 胜 = viewer1 负
        const key = `${r.date}|${r.mapName}|${viewer1Won ? 'p1' : 'p2'}|${r.format}`;
        if (!seen.has(key)) {
            seen.set(key, {
                date: r.date, mapName: r.mapName,
                mapKr: matched ? matched.kr : '',
                mapCn: matched ? matched.cn : '',
                isSeasonMap: !!matched,
                viewer1Won,
                // winnerGain 取绝对值，胜者加分恒为正，无需区分视角反转
                eloChange: winnerGain(r.eloChange),
                format: r.format, memo: r.memo,
            });
        }
    });

    const result = { matches: [...seen.values()], fetchedAt: new Date().toISOString() };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch {}
    return result;
}

// ---- Stats summary (for status display) ----
function getStats() {
    const meta = readMeta();
    let playerFiles = 0;
    let totalMatches = 0;
    if (fs.existsSync(PLAYERS_DIR)) {
        fs.readdirSync(PLAYERS_DIR).forEach(f => {
            if (f.endsWith('.json')) {
                playerFiles++;
                try {
                    const d = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, f), 'utf8'));
                    totalMatches += (d.matchCount || 0);
                } catch {}
            }
        });
    }
    return {
        lastFullSync: meta.lastFullSync,
        playerFiles,
        totalMatches,
        dataDir: DATA_DIR,
    };
}

module.exports = {
    ensureDirs,
    readMeta,
    writeMeta,
    readPlayerData,
    fetchAndParsePlayer,
    savePlayerData,
    syncPlayer,
    syncAll,
    computeMapStats,
    computeRecentMatches,
    getStats,
    SEASON_MAPS,
};
