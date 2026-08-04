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
async function fetchAndParsePlayer(wrId, opts = {}) {
    const response = await axios.get(PLAYER_PAGE_URL(wrId), { headers, timeout: 45000 });
    const $ = cheerio.load(response.data);

    // extract race from 주종 row + current ELO
    let race = '';
    let elo = '';
    $('th').each((i, el) => {
        if (race && elo) return;
        const label = $(el).text().trim();
        if (label === '주종' && !race) {
            const val = $(el).next('td').text().trim();
            race = RACE_FULL[val] || '';
        } else if (label === 'ELO' && !elo) {
            elo = $(el).next('td').text().trim();
        }
    });

    // extract avatar: 页面顶部选手信息卡的第一张 w=120 头像图
    let avatar = '';
    $('img[width="120"]').each((i, el) => {
        if (avatar) return;
        avatar = $(el).attr('src') || '';
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

    // ---- 解析 맵별통계 표 (eloboard 공식 집계 맵별 대종족 전적) ----
    // 개인 홈페이지의 여러 .list-board 중 "저그전"+"총전적" 포함 것이 맵별통계 표
    // 열 순서: 맵 | 저그전(Z) | 프로토스전(P) | 테란전(T) | 총전적 | 승률
    const mapStats = {};
    // 이 표는 .list-board 내에 없고, td[width="25%"] + td[width="15%"]*5 구조를 가짌
    // 열 순서: 맵 | 저그전(Z) | 프로토스전(P) | 테란전(T) | 총전적 | 승률
    $('tr').each((i, el) => {
        const tds = $(el).find('td');
        if (tds.length < 6) return;
        const firstTd = $(tds[0]);
        if (firstTd.attr('width') !== '25%') return;
        const mapName = firstTd.text().trim();
        if (!mapName || mapName === '맵') return;
        const parseWL = (text) => {
            const m = text.match(/(\d+)승\s*(\d+)패/);
            return m ? { wins: parseInt(m[1]), losses: parseInt(m[2]) } : { wins: 0, losses: 0 };
        };
        const vsZ = parseWL($(tds[1]).text().trim());
        const vsP = parseWL($(tds[2]).text().trim());
        const vsT = parseWL($(tds[3]).text().trim());
        const key = normalize(mapName);
        if (mapStats[key]) {
            mapStats[key].vsZ.wins += vsZ.wins; mapStats[key].vsZ.losses += vsZ.losses;
            mapStats[key].vsP.wins += vsP.wins; mapStats[key].vsP.losses += vsP.losses;
            mapStats[key].vsT.wins += vsT.wins; mapStats[key].vsT.losses += vsT.losses;
        } else {
            mapStats[key] = { mapKr: mapName, vsZ, vsP, vsT };
        }
    });


    return { wrId, race, elo, avatar, matchCount: matches.length, matches, storyByOpp, mapStats, fetchedAt: new Date().toISOString() };
}

// ---- Save player data to local file ----
function savePlayerData(wrId, data) {
    const file = path.join(PLAYERS_DIR, `${wrId}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
}

// ---- Sync one player (full re-fetch, with retry) ----
async function syncPlayer(wrId, opts = {}) {
    const retries = opts.retries || 0;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const data = await fetchAndParsePlayer(wrId, opts);
            savePlayerData(wrId, data);

            const meta = readMeta();
            meta.playerSync = meta.playerSync || {};
            meta.playerSync[wrId] = { time: new Date().toISOString(), matchCount: data.matchCount };
            writeMeta(meta);

            if (!opts.silent) console.log(`  ✓ wrId=${wrId} race=${data.race} matches=${data.matchCount}`);
            return data;
        } catch (e) {
            lastErr = e;
            if (attempt < retries) {
                const wait = 2000 * (attempt + 1); // 2s / 4s / 6s 递增退避
                if (!opts.silent) console.log(`  ⚠ wrId=${wrId} 第${attempt + 1}次失败(${e.message})，${wait / 1000}s 后重试`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }
    throw lastErr;
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
        const retries = opts.retries || 2; // 网络抖动自动重试
        const results = await Promise.allSettled(
            batch.map(p => syncPlayer(p.wrId, { silent: true, retries }))
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

    const statsByMap = {};
    const matchupTotals = {};
    muKeys.forEach(k => matchupTotals[k] = { wins: 0, losses: 0, total: 0 });
    let totalWins = 0, totalLosses = 0;

    const mapStatsRaw = data.mapStats || {};
    const hasFullMapStats = Object.keys(mapStatsRaw).length > 0;

    if (hasFullMapStats) {
        // mapStats 已包含全量赛季地图统计（来自 맵별통계 표 或 view_list.php 全量加载）
        SEASON_MAPS.forEach(mapDef => {
            const key = normalize(mapDef.kr);
            const raw = mapStatsRaw[key];
            if (!raw) return;
            const matchups = {};
            let mapW = 0, mapL = 0;
            const cols = [['Z', raw.vsZ], ['P', raw.vsP], ['T', raw.vsT]];
            cols.forEach(([opp, v]) => {
                const muKey = `${race}v${opp}`;
                const w = v.wins || 0, l = v.losses || 0;
                matchups[muKey] = { wins: w, losses: l, total: w + l };
                mapW += w; mapL += l;
            });
            statsByMap[key] = { kr: mapDef.kr, cn: mapDef.cn, matchups };
            Object.entries(matchups).forEach(([k, v]) => {
                matchupTotals[k].wins += v.wins;
                matchupTotals[k].losses += v.losses;
                matchupTotals[k].total += v.total;
            });
            totalWins += mapW; totalLosses += mapL;
        });
    } else {
        // fallback: 从 storyByOpp + matches 累加
        const seenMatchKeys = new Set();
        function addMatch(mapName, isWin, oppRace) {
            const matched = matchSeasonMap(mapName);
            if (!matched) return;
            const key = normalize(matched.kr);
            if (!statsByMap[key]) {
                statsByMap[key] = { kr: matched.kr, cn: matched.cn, matchups: {} };
                muKeys.forEach(k => statsByMap[key].matchups[k] = { wins: 0, losses: 0, total: 0 });
            }
            const muKey = race !== '?' && oppRace ? `${race}v${oppRace}` : null;
            if (muKey && statsByMap[key].matchups[muKey]) {
                if (isWin) { statsByMap[key].matchups[muKey].wins++; matchupTotals[muKey].wins++; }
                else { statsByMap[key].matchups[muKey].losses++; matchupTotals[muKey].losses++; }
                statsByMap[key].matchups[muKey].total++;
                matchupTotals[muKey].total++;
            }
            if (isWin) totalWins++; else totalLosses++;
        }

        const oppRaceMap = {};
        (data.matches || []).forEach(m => {
            if (m.oppWrId && m.oppRace) oppRaceMap[m.oppWrId] = m.oppRace;
        });

        const storyByOpp = data.storyByOpp || {};
        Object.entries(storyByOpp).forEach(([oppWrId, matches2]) => {
            let oppRace = oppRaceMap[oppWrId] || '';
            if (!oppRace) {
                const oppData = readPlayerData(oppWrId);
                if (oppData && oppData.race) oppRace = oppData.race;
            }
            (matches2 || []).forEach(m => {
                const mk = `${m.date}|${m.mapName}|${m.format}|${m.viewerWon}`;
                if (seenMatchKeys.has(mk)) return;
                seenMatchKeys.add(mk);
                addMatch(m.mapName, m.viewerWon, oppRace);
            });
        });

        (data.matches || []).forEach(r => {
            if (!r.isSeasonMap) return;
            const mk = `${r.date}|${r.mapKr || r.mapName}|${r.format}|${r.isWin}`;
            if (seenMatchKeys.has(mk)) return;
            seenMatchKeys.add(mk);
            addMatch(r.mapKr || r.mapName, r.isWin, r.oppRace);
        });
    }

    // 3. 构建完整赛季地图列表输出
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

// ---- Compute head-to-head summary from LOCAL data (no remote request) ----
// 从双方 storyByOpp（同步时已抓取的全量互相对战）+ matches 合并统计，
// 毫秒级返回，字段结构与远程 /api/fight 对齐。
// 返回 null 表示本地数据不完整（任一方无本地文件），调用方应回退远程抓取。
function computeH2H(wrId1, wrId2) {
    const d1 = readPlayerData(wrId1);
    const d2 = readPlayerData(wrId2);
    if (!d1 || !d2) return null;

    // 去重 key: date + mapName + 胜者 + format（与 computeRecentMatches 一致）
    const seen = new Map();

    // 从 wrId1 主页的 storyByOpp[wrId2] 取全量对战（wrId1 视角）
    if (d1.storyByOpp && d1.storyByOpp[wrId2]) {
        d1.storyByOpp[wrId2].forEach(r => {
            const winner = r.viewerWon ? 'p1' : 'p2';
            const key = `${r.date}|${r.mapName}|${winner}|${r.format}`;
            if (!seen.has(key)) {
                seen.set(key, { date: r.date, mapName: r.mapName, format: r.format, winner });
            }
        });
    }

    // 从 wrId2 主页的 storyByOpp[wrId1] 取全量对战（wrId2 视角，镜像）
    if (d2.storyByOpp && d2.storyByOpp[wrId1]) {
        d2.storyByOpp[wrId1].forEach(r => {
            const winner = r.viewerWon ? 'p2' : 'p1';
            const key = `${r.date}|${r.mapName}|${winner}|${r.format}`;
            if (!seen.has(key)) {
                seen.set(key, { date: r.date, mapName: r.mapName, format: r.format, winner });
            }
        });
    }

    // 补充近期列表（双保险：storyByOpp 没覆盖到的场景）
    const mapOne = (data, oppWrId, viewerIsP1) => {
        if (!data || !data.matches) return;
        data.matches
            .filter(r => r.oppWrId === oppWrId)
            .forEach(r => {
                const viewerWon = r.isWin;
                const winner = (viewerIsP1 === viewerWon) ? 'p1' : 'p2';
                const key = `${r.date}|${r.mapName}|${winner}|${r.format}`;
                if (!seen.has(key)) {
                    seen.set(key, { date: r.date, mapName: r.mapName, format: r.format, winner });
                }
            });
    };
    mapOne(d1, wrId2, true);
    mapOne(d2, wrId1, false);

    const records = [...seen.values()];
    const totalMatches = records.length;

    let wins1 = 0, wins2 = 0, recentWins1 = 0, recentWins2 = 0;
    const now = Date.now();
    const monthMs = 30 * 24 * 60 * 60 * 1000;
    const mapTally = {}; // key: normalize(mapKr) -> { p1: n, p2: n }

    records.forEach(r => {
        if (r.winner === 'p1') wins1++; else wins2++;

        const date = new Date(r.date + 'T00:00:00');
        const isRecent = date.getTime() && (now - date.getTime()) <= monthMs;
        if (isRecent) {
            if (r.winner === 'p1') recentWins1++; else recentWins2++;
        }

        const matched = matchSeasonMap(r.mapName);
        if (matched) {
            const key = normalize(matched.kr);
            if (!mapTally[key]) mapTally[key] = { p1: 0, p2: 0 };
            if (r.winner === 'p1') mapTally[key].p1++; else mapTally[key].p2++;
        }
    });

    // mapData 按 SEASON_MAPS 顺序输出，仅保留有交战的赛季地图
    const mapData = [];
    SEASON_MAPS.forEach(m => {
        const key = normalize(m.kr);
        const t = mapTally[key];
        if (!t) return;
        mapData.push({
            mapKr: m.kr, mapCn: m.cn, mapFull: m.full,
            player1Wins: t.p1, player2Wins: t.p2, total: t.p1 + t.p2,
        });
    });

    const fmtRate = (w, l) => {
        const total = w + l;
        return total > 0 ? ((w / total) * 100).toFixed(1) + '%' : '0%';
    };
    const mkPlayer = (wrId, data, wins, losses, recentWins) => ({
        name: '', // server 端补充韩文名
        race: data.race || '',
        displayName: '',
        image: data.avatar || '',
        wrId,
        wins,
        winRate: fmtRate(wins, losses),
        elo: data.elo || null, // 同步时抓取的当前 ELO
        recentWins,
        topOpponents: [],
    });

    return {
        source: 'local',
        player1: mkPlayer(wrId1, d1, wins1, wins2, recentWins1),
        player2: mkPlayer(wrId2, d2, wins2, wins1, recentWins2),
        totalMatches,
        mapData,
    };
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
    computeH2H,
    getStats,
    SEASON_MAPS,
};
