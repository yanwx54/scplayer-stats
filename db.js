/**
 * db.js — 本地数据层
 * 存储：每选手一个 JSON 文件（data/players/{wrId}.json），含选手元数据 + 全部比赛记录
 * 优势：零依赖、读取 <5ms、易维护、增量更新简单
 * 预计总量：60 选手 × ~150KB ≈ 9MB
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_DIR = path.join(DATA_DIR, 'players');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars'); // 选手头像本地缓存（eloboard 外链被 Cloudflare 拦，需本地化）

// ---- eloboard 新版 API（2026-08 改版：旧 HTML 页面已废弃，改用 JSON API）----
const API_BASE = 'https://eloboard.com/api';
const AVATAR_BASE = 'https://eloboard.co.kr/static/'; // thumb_url 为相对路径 players/{id}.jpg
const ID_MAP_FILE = path.join(DATA_DIR, 'player-id-map.json'); // 旧wrId ↔ 新playerId 映射
const MATCH_WINDOW_DAYS = 120;  // 每次同步拉取的比赛深度（UI 需要 90 天，留余量）
const PAGE_LIMIT = 200;         // /api/matches 单页上限
const MAX_PAGES = 30;           // 单选手分页安全上限（30×200=6000 场，远超 120 天量）

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
    if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
}

// 查找选手本地头像文件，返回文件名（如 "38.jpg"）或 null
function findAvatarFile(wrId) {
    const exts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    for (const ext of exts) {
        if (fs.existsSync(path.join(AVATARS_DIR, wrId + ext))) return wrId + ext;
    }
    return null;
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

// ---- API 抓取器（默认 axios 直连，会被 Cloudflare 拦；本地过盾同步时注入浏览器会话抓取器）----
let apiGet = async (url) => {
    const response = await axios.get(url, { timeout: 45000 });
    return response.data;
};
// 注入自定义抓取器：fn(url) => 解析后的 JSON（local-sync 注入 Playwright context.request）
function setFetcher(fn) { apiGet = fn; }

// ---- ID 映射（旧 wrId ↔ 新 player_id，由 local-sync --rebuild-id-map 生成）----
let idMapCache = null;
function loadIdMap() {
    if (idMapCache) return idMapCache;
    try {
        idMapCache = JSON.parse(fs.readFileSync(ID_MAP_FILE, 'utf8'));
    } catch (e) {
        idMapCache = null;
    }
    return idMapCache;
}
function clearIdMapCache() { idMapCache = null; }

// 对手 player_id → 本地 oppWrId：
//   跟踪选手 → 旧 wrId（H2H/去重 与既有数据对齐）
//   非跟踪选手 → 'n' + 新 id（前缀避免与旧 wrId 数字空间冲突）
function oppIdToLocal(newId) {
    const map = loadIdMap();
    const old = map && map.newToOld && map.newToOld[String(newId)];
    return old != null ? String(old) : 'n' + newId;
}

function fmtElo(eloRaw) {
    const n = parseFloat(eloRaw);
    if (isNaN(n)) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// API 比赛记录 → 本地格式（viewer = 选手本人视角）
function convertApiMatch(m, myNewId) {
    const me = (m.participants || []).find(p => p.player_id === myNewId);
    const opp = (m.participants || []).find(p => p.player_id !== myNewId);
    const isWin = !!me && me.result === 'win';
    const matched = matchSeasonMap(m.map_name);
    // elo_delta 恒为胜方增益（正数）；本地约定为本人视角带符号字符串
    let eloChange = '';
    if (m.elo_delta != null && !isNaN(parseFloat(m.elo_delta))) {
        const d = parseFloat(m.elo_delta);
        eloChange = (isWin ? '+' : '-') + Math.abs(d).toFixed(1);
    }
    let memo = m.memo || '';
    if (!memo && (m.event_name || m.round_label)) {
        memo = [m.event_name, m.round_label].filter(Boolean).join(' ');
    }
    return {
        date: m.played_on || '',
        oppWrId: opp ? oppIdToLocal(opp.player_id) : null,
        oppRace: opp ? (opp.race || '') : '',
        mapName: m.map_name || '',
        mapKr: matched ? matched.kr : '',
        mapCn: matched ? matched.cn : '',
        isSeasonMap: !!matched,
        isWin,
        eloChange,
        format: m.format_raw || '',
        memo,
    };
}

// ---- 拉取并解析一名选手（新版 API：选手详情 + 比赛分页）----
async function fetchAndParsePlayer(wrId, opts = {}) {
    const map = loadIdMap();
    if (!map || !map.oldToNew || map.oldToNew[wrId] == null) {
        throw new Error(`缺少新站 ID 映射（wrId=${wrId}），请先运行 node local-sync.js --rebuild-id-map`);
    }
    const newId = map.oldToNew[wrId];

    // 选手详情：种族 / 当前 ELO / 头像
    const info = await apiGet(`${API_BASE}/players/${newId}`);
    if (!info || !info.id) throw new Error(`选手详情响应异常（wrId=${wrId}, newId=${newId}）`);

    // 比赛列表：分页拉取，直到越过窗口或翻完
    const cutoff = new Date(Date.now() - MATCH_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
    const matches = [];
    for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * PAGE_LIMIT;
        const arr = await apiGet(`${API_BASE}/matches?player_id=${newId}&limit=${PAGE_LIMIT}&offset=${offset}`);
        if (!Array.isArray(arr)) throw new Error(`比赛列表响应异常（wrId=${wrId}, offset=${offset}）`);
        for (const m of arr) {
            if (m.played_on && m.played_on < cutoff) continue; // 窗口外（页内跨界部分）
            matches.push(convertApiMatch(m, newId));
        }
        if (arr.length < PAGE_LIMIT) break;       // 翻完
        if (arr[arr.length - 1].played_on < cutoff) break; // 最老一条已越界
        await new Promise(r => setTimeout(r, 200)); // 分页间礼貌间隔
    }

    return {
        wrId,
        newId,
        race: info.main_race || '',
        elo: fmtElo(info.elo_raw),
        avatar: info.thumb_url ? AVATAR_BASE + info.thumb_url : '',
        matchCount: matches.length,
        matches,
        storyByOpp: {},  // 生涯对战数据仅旧站 HTML 提供，由 merge 的防回退逻辑保留本地既有值
        mapStats: {},    // 生涯地图统计表同上；新比赛在 syncPlayer 内增量累加
        fetchedAt: new Date().toISOString(),
        source: 'api',
    };
}

// ---- Save player data to local file ----
function savePlayerData(wrId, data) {
    const file = path.join(PLAYERS_DIR, `${wrId}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
}

// ---- 增量合并：API 抓取结果 与 本地既有数据 合并 ----
// 语义：本地库只增不减 —
//   1. API 窗口内出现的比赛（当前 120 天）取 API 最新值
//   2. 本地有而 API 窗口外的（更早的历史）继续保留
//   3. 新比赛（API 有、本地没有的）追加
// 去重键：日期+对手+地图+赛制+胜负；同键多条按数量对账（同日同对手同图多场不误删）
// 迁移（旧 HTML 数据 → API 数据）：对手 ID 体系不同（旧 wrId vs 新 player_id），
//   无法逐条对账；API 窗口内的本地旧记录整体替换（API 覆盖更深，是超集），
//   早于 API 窗口的本地历史保留。合并结果标记 source='api'，后续走常规键对账。
function mergePlayerData(existing, fresh) {
    const keyOf = (m) => `${m.date}|${m.oppWrId || ''}|${m.mapKr || m.mapName}|${m.format}|${m.isWin ? 'W' : 'L'}`;

    if (!existing || !Array.isArray(existing.matches) || existing.matches.length === 0) {
        return { data: fresh, newCount: fresh.matches.length, newRecords: fresh.matches.slice(), isMigration: false }; // 首次抓取：整批入库
    }
    const isMigration = existing.source !== 'api' && fresh.source === 'api' && fresh.matches.length > 0;

    let existingMatches = existing.matches;
    if (isMigration) {
        // 迁移清洗：丢弃 API 覆盖范围内的本地旧记录（fresh 最老日期之前全保留）
        const freshOldest = fresh.matches.reduce((min, m) => (m.date && m.date < min ? m.date : min), '9999-12-31');
        existingMatches = existingMatches.filter(m => !m.date || m.date < freshOldest);
    }

    // API 比赛的键计数
    const freshCount = {};
    fresh.matches.forEach(m => { const k = keyOf(m); freshCount[k] = (freshCount[k] || 0) + 1; });

    // 本地比赛逐条对账：API 上还有的 → 由 API 版本替代；API 上没有的 → 保留为历史
    const consumed = {};
    const history = [];
    existingMatches.forEach(m => {
        const k = keyOf(m);
        const used = consumed[k] || 0;
        if (used < (freshCount[k] || 0)) {
            consumed[k] = used + 1;
        } else {
            history.push(m);
        }
    });

    // 本次真正新增的 fresh 记录：每键前 consumed[k] 条与本地重复，其余为新增
    const seenFresh = {};
    const newRecords = fresh.matches.filter(m => {
        const k = keyOf(m);
        seenFresh[k] = (seenFresh[k] || 0) + 1;
        return seenFresh[k] > (consumed[k] || 0);
    });
    const newCount = newRecords.length;

    const merged = fresh.matches.concat(history);
    merged.sort((a, b) => (a.date < b.date ? 1 : (a.date > b.date ? -1 : 0)));

    // 元数据（race/elo/avatar/storyByOpp/mapStats）取 API 最新值，比赛记录为合并结果
    const data = Object.assign({}, fresh, { matches: merged, matchCount: merged.length });

    // 防回退：API 截断/异常解析导致字段为空时，保留本地已有值（下次抓取自动覆盖）
    ['race', 'elo', 'avatar', 'storyByOpp', 'mapStats'].forEach((k) => {
        const v = data[k];
        const isEmpty = v == null || v === '' ||
            (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
        if (isEmpty && existing[k]) data[k] = existing[k];
    });

    return { data, newCount, newRecords, isMigration };
}

// ---- 生涯地图统计增量累计 ----
// 旧站 HTML 的 맵별통계 表是生涯全量统计（迁移时经防回退保留为基线）；
// API 每场比赛带对手种族，把「基线之后新入库」的比赛累加进去，保持生涯口径持续更新。
// mapStatsCutoff = 已累计到的最新比赛日期。
function tallyMapStats(data, tallyRecords, existing) {
    const mapStats = data.mapStats && Object.keys(data.mapStats).length > 0
        ? JSON.parse(JSON.stringify(data.mapStats))
        : {};
    let cutoff = (existing && existing.mapStatsCutoff) || '';
    let added = 0;
    for (const r of tallyRecords) {
        if (!r.isSeasonMap || !r.mapKr || !r.oppRace) continue;
        if (r.date && r.date <= cutoff) continue; // 基线已含（防重复累计）
        const key = normalize(r.mapKr);
        if (!mapStats[key]) mapStats[key] = { mapKr: r.mapKr, vsZ: { wins: 0, losses: 0 }, vsP: { wins: 0, losses: 0 }, vsT: { wins: 0, losses: 0 } };
        const col = { Z: 'vsZ', P: 'vsP', T: 'vsT' }[r.oppRace];
        if (!col) continue;
        if (r.isWin) mapStats[key][col].wins++; else mapStats[key][col].losses++;
        if (r.date && r.date > cutoff) cutoff = r.date;
        added++;
    }
    if (added > 0 || Object.keys(mapStats).length > 0) {
        data.mapStats = mapStats;
        data.mapStatsCutoff = cutoff;
    }
    return added;
}

// ---- Sync one player (fetch + incremental merge, with retry) ----
async function syncPlayer(wrId, opts = {}) {
    const retries = opts.retries || 0;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const existing = readPlayerData(wrId);
            const fresh = await fetchAndParsePlayer(wrId, opts);
            const { data, newCount, newRecords, isMigration } = mergePlayerData(existing, fresh);

            // 地图统计增量累计：
            //   常规同步 → 本次新入库的比赛（API 源记录，带对手种族）
            //   迁移同步 → 基线（旧数据最新一场）之后的新比赛（基线表已含更早的所有场次）
            let tallyRecords = newRecords;
            if (isMigration) {
                const preNewest = existing.matches.reduce((max, m) => (m.date && m.date > max ? m.date : max), '');
                tallyRecords = fresh.matches.filter(m => m.date && m.date > preNewest);
            }
            tallyMapStats(data, tallyRecords, existing);

            savePlayerData(wrId, data);

            const meta = readMeta();
            meta.playerSync = meta.playerSync || {};
            meta.playerSync[wrId] = { time: new Date().toISOString(), matchCount: data.matchCount };
            writeMeta(meta);

            if (!opts.silent) console.log(`  ✓ wrId=${wrId} race=${data.race} matches=${data.matchCount}${newCount > 0 ? ` (+${newCount}新)` : ''}`);
            data._newCount = newCount; // 仅供调用方日志用，不入库
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
                const nc = r.value._newCount || 0;
                console.log(`  [${done}/${players.length}] ✓ ${p.cnName}(${p.krName}) wrId=${p.wrId} race=${r.value.race} matches=${r.value.matchCount}${nc > 0 ? ` (+${nc}新)` : ''}`);
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
    if (opts.full !== false) meta.lastFullSync = new Date().toISOString(); // 增量模式不覆盖全量时间
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
        image: (() => { // 本地头像优先（eloboard 外链被 Cloudflare 拦截）
            const f = findAvatarFile(wrId);
            return f ? `/avatars/${f}` : (data.avatar || '');
        })(),
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
    mergePlayerData,
    syncPlayer,
    syncAll,
    setFetcher,
    clearIdMapCache,
    computeMapStats,
    computeRecentMatches,
    computeH2H,
    getStats,
    SEASON_MAPS,
};
