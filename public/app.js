// State
let allPlayers = [];
let seasonMaps = [];
let selectedPlayer1 = null;
let selectedPlayer2 = null;
let currentData = null;       // 最近一次查询的完整数据（用于地图筛选重渲染）
let selectedMapKey = '';      // 当前筛选的地图 key（空 = 全部）

// Race display helpers
const RACE_NAME = { T: 'TERRAN', Z: 'ZERG', P: 'PROTOSS' };
const RACE_COLOR = { T: 'var(--r-T)', Z: 'var(--r-Z)', P: 'var(--r-P)' };
const MU_OPP_ORDER = ['T', 'Z', 'P']; // order of opponent race columns

// DOM
const player1Input = document.getElementById('player1-input');
const player2Input = document.getElementById('player2-input');
const player1Dropdown = document.getElementById('player1-dropdown');
const player2Dropdown = document.getElementById('player2-dropdown');
const searchBtn = document.getElementById('search-btn');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const errorDiv = document.getElementById('error');
const results = document.getElementById('results');
const seasonTag = document.getElementById('season-tag');
const mapFilter = document.getElementById('map-filter');
const syncInfo = document.getElementById('sync-info');
const syncBtn = document.getElementById('sync-btn');
const eloDiff = document.getElementById('elo-diff');

// ---- Helpers ----
function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}
function normalizeStr(s) { return (s || '').replace(/\s+/g, '').toLowerCase(); }
function mapKey(kr) { return normalizeStr(kr); }

// ---- Init ----
async function init() {
    try {
        const [playersRes, mapsRes] = await Promise.all([
            fetch('/api/players').then(r => r.json()),
            fetch('/api/maps').then(r => r.json()),
        ]);
        allPlayers = playersRes;
        seasonMaps = mapsRes.maps || [];
        seasonTag.textContent = `SEASON MAPS${mapsRes.season ? ' // ' + mapsRes.season : ''} · ${seasonMaps.length} MAPS`;
        populateMapFilter();
        loadSyncStatus();
    } catch (err) {
        showError('初始化失败: ' + err.message);
    }
    setupEventListeners();
}

// 加载同步状态并显示，超7天标红提醒
async function loadSyncStatus() {
    try {
        const s = await fetch('/api/status').then(r => r.json());
        updateSyncDisplay(s.lastFullSync);
    } catch {}
}

function updateSyncDisplay(lastSync) {
    if (!lastSync) { syncInfo.textContent = 'SYNC: 从未'; syncInfo.classList.add('stale'); return; }
    const d = new Date(lastSync);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    const dateStr = `${d.getMonth() + 1}/${d.getDate()}`;
    syncInfo.textContent = `SYNC: ${dateStr} (${days}天前)`;
    syncInfo.classList.toggle('stale', days > 7);
}

// ---- Search & dropdown ----
function setupEventListeners() {
    setupPlayerSearch(player1Input, player1Dropdown, 1);
    setupPlayerSearch(player2Input, player2Dropdown, 2);
    searchBtn.addEventListener('click', handleSearch);
    mapFilter.addEventListener('change', () => {
        selectedMapKey = mapFilter.value;
        mapFilter.classList.toggle('active', !!selectedMapKey);
        if (currentData) renderFilteredSections();
    });
    syncBtn.addEventListener('click', handleSyncAll);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.select-wrapper')) {
            player1Dropdown.classList.remove('active');
            player2Dropdown.classList.remove('active');
        }
    });
}

// 填充地图筛选下拉框
function populateMapFilter() {
    if (!mapFilter) return;
    mapFilter.innerHTML = '<option value="">全部地图</option>';
    seasonMaps.forEach(m => {
        const opt = document.createElement('option');
        opt.value = mapKey(m.kr);
        opt.textContent = `${m.cn} · ${m.kr}`;
        mapFilter.appendChild(opt);
    });
}

function setupPlayerSearch(input, dropdown, playerNum) {
    input.addEventListener('input', () => {
        const query = input.value.trim();
        if (playerNum === 1) selectedPlayer1 = null;
        else selectedPlayer2 = null;
        updateSearchButton();
        if (query.length === 0) { dropdown.classList.remove('active'); return; }
        const q = normalizeStr(query);
        const filtered = allPlayers.filter(p =>
            normalizeStr(p.cnName).includes(q) ||
            normalizeStr(p.krName).includes(q) ||
            normalizeStr(p.playerId).includes(q)
        ).slice(0, 50);
        renderDropdown(dropdown, filtered, playerNum, input);
    });
    input.addEventListener('focus', () => {
        if (input.value.trim().length === 0 && allPlayers.length > 0) {
            renderDropdown(dropdown, allPlayers, playerNum, input);
        }
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (selectedPlayer1 && selectedPlayer2) handleSearch();
        }
    });
}

function renderDropdown(dropdown, players, playerNum, input) {
    dropdown.innerHTML = '';
    if (players.length === 0) {
        const item = document.createElement('div');
        item.className = 'dropdown-item empty';
        item.textContent = '// 无匹配选手';
        dropdown.appendChild(item);
        dropdown.classList.add('active');
        return;
    }
    players.forEach(player => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.innerHTML =
            `<span class="dd-cn">${escapeHtml(player.cnName)}</span>` +
            `<span class="dd-kr">${escapeHtml(player.krName)}</span>` +
            `<span class="dd-id">${escapeHtml(player.playerId)}</span>`;
        item.addEventListener('click', () => selectPlayer(player, playerNum, input, dropdown));
        dropdown.appendChild(item);
    });
    dropdown.classList.add('active');
}

function selectPlayer(player, playerNum, input, dropdown) {
    input.value = player.cnName;
    if (playerNum === 1) selectedPlayer1 = player;
    else selectedPlayer2 = player;
    dropdown.classList.remove('active');
    updateSearchButton();
    // 后台静默同步该选手到本地库（若已存在则刷新，查询时本地秒回）
    if (player.wrId) {
        fetch(`/api/sync-player?wrId=${player.wrId}`).catch(() => {});
    }
    if (selectedPlayer1 && selectedPlayer2) handleSearch();
}

function updateSearchButton() {
    searchBtn.disabled = !(selectedPlayer1 && selectedPlayer2);
}

// ---- Search ----
async function handleSearch() {
    if (!selectedPlayer1 || !selectedPlayer2) return;
    if (selectedPlayer1.wrId === selectedPlayer2.wrId) {
        showError('请选择两位不同的选手');
        return;
    }

    loading.classList.remove('hidden');
    results.classList.add('hidden');
    errorDiv.classList.add('hidden');
    loadingText.textContent = '// 正在获取战术情报…';

    try {
        const p1 = selectedPlayer1;
        const p2 = selectedPlayer2;

        const fightPromise = fetch(
            `/api/fight?player1=${encodeURIComponent(p1.krName)}&player2=${encodeURIComponent(p2.krName)}`
        ).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)));

        const mkStats = (wrId) => wrId
            ? fetch(`/api/player-map-stats?wrId=${wrId}`).then(r => r.ok ? r.json() : null).catch(() => null)
            : Promise.resolve(null);

        const recentPromise = (p1.wrId && p2.wrId)
            ? fetch(`/api/recent-matches?wrId1=${p1.wrId}&wrId2=${p2.wrId}`).then(r => r.ok ? r.json() : null).catch(() => null)
            : Promise.resolve(null);

        const [fightData, p1Stats, p2Stats, recentData] = await Promise.all([
            fightPromise, mkStats(p1.wrId), mkStats(p2.wrId), recentPromise,
        ]);

        displayResults({ fightData, p1Stats, p2Stats, recentData, p1, p2 });
        loading.classList.add('hidden');
        results.classList.remove('hidden');
    } catch (err) {
        loading.classList.add('hidden');
        showError('查询失败: ' + (err.error || err.detail || err.message || '未知错误'));
    }
}

// 一键全量同步
async function handleSyncAll() {
    if (syncBtn.disabled) return;
    if (!confirm('全量同步所有选手数据，约需8分钟。期间可继续查询（旧数据）。确定开始？')) return;
    syncBtn.disabled = true;
    syncBtn.classList.add('syncing');
    syncBtn.textContent = '同步中…';
    try {
        const r = await fetch('/api/sync-all').then(r => r.json());
        if (r.ok) {
            syncInfo.textContent = 'SYNC: 同步中…';
            syncInfo.classList.remove('stale');
            // 轮询状态，每30秒查一次，直到完成
            const poll = setInterval(async () => {
                try {
                    const s = await fetch('/api/status').then(r => r.json());
                    // 简单判断：lastFullSync 变新了就认为完成
                    updateSyncDisplay(s.lastFullSync);
                } catch {}
            }, 30000);
            // 8分钟后停止轮询并恢复按钮
            setTimeout(() => {
                clearInterval(poll);
                syncBtn.disabled = false;
                syncBtn.classList.remove('syncing');
                syncBtn.textContent = '同步数据';
                loadSyncStatus();
            }, 8 * 60 * 1000);
        } else {
            alert(r.message || '同步已在进行中');
            syncBtn.disabled = false;
            syncBtn.classList.remove('syncing');
            syncBtn.textContent = '同步数据';
        }
    } catch (e) {
        alert('同步启动失败: ' + e.message);
        syncBtn.disabled = false;
        syncBtn.classList.remove('syncing');
        syncBtn.textContent = '同步数据';
    }
}

// 切换地图筛选时，只重渲染受影响的三个区块（H2H 表 / Intel 表 / 交战日志）
function renderFilteredSections() {
    if (!currentData) return;
    renderH2HMapTable(currentData.fightData.mapData, selectedMapKey);
    renderIntel('p1', currentData.p1Stats, currentData.p1, selectedMapKey);
    renderIntel('p2', currentData.p2Stats, currentData.p2, selectedMapKey);
    renderRecentLog(currentData.recentData, currentData.p1, currentData.p2, selectedMapKey);
}

// ---- Display ----
function displayResults(data) {
    const { fightData, p1Stats, p2Stats, recentData, p1, p2 } = data;
    currentData = data;                 // 缓存供地图筛选重渲染
    selectedMapKey = '';                // 新查询重置筛选
    if (mapFilter) { mapFilter.value = ''; mapFilter.classList.remove('active'); }
    const fp1 = fightData.player1;
    const fp2 = fightData.player2;

    const p1Display = `${p1.cnName} · ${fp1.displayName || p1.krName}`;
    const p2Display = `${p2.cnName} · ${fp2.displayName || p2.krName}`;

    // player cards
    setImg('p1-image', fp1.image);
    setText('p1-name', p1Display);
    setText('p1-meta', `ID: ${p1.playerId}${fp1.race ? ' · RACE: ' + RACE_NAME[fp1.race] : ''}`);
    setText('p1-wins', fp1.wins);
    setText('p1-winrate', fp1.winRate || '-');
    setText('p1-elo', fp1.elo || '-');
    setRaceWatermark('p1-race-wm', fp1.race);

    setImg('p2-image', fp2.image);
    setText('p2-name', p2Display);
    setText('p2-meta', `ID: ${p2.playerId}${fp2.race ? ' · RACE: ' + RACE_NAME[fp2.race] : ''}`);
    setText('p2-wins', fp2.wins);
    setText('p2-winrate', fp2.winRate || '-');
    setText('p2-elo', fp2.elo || '-');
    setRaceWatermark('p2-race-wm', fp2.race);

    setText('total-matches', fightData.totalMatches);
    setText('p1-score', fp1.wins);
    setText('p2-score', fp2.wins);
    setText('recent-record', `${fp1.recentWins} : ${fp2.recentWins}`);

    // ELO 差值
    const e1 = parseFloat(String(fp1.elo).replace(/[^\d.\-]/g, '')) || 0;
    const e2 = parseFloat(String(fp2.elo).replace(/[^\d.\-]/g, '')) || 0;
    if (e1 || e2) {
        const diff = e1 - e2;
        eloDiff.className = 'elo-diff mono';
        if (diff > 0) {
            eloDiff.classList.add('p1-lead');
            eloDiff.innerHTML = `ELO Δ <span class="diff-val">+${diff.toFixed(1)}</span> · ${p1.cnName}领先`;
        } else if (diff < 0) {
            eloDiff.classList.add('p2-lead');
            eloDiff.innerHTML = `ELO Δ <span class="diff-val">+${(-diff).toFixed(1)}</span> · ${p2.cnName}领先`;
        } else {
            eloDiff.innerHTML = `ELO Δ <span class="diff-val">0</span> · 持平`;
        }
    } else {
        eloDiff.textContent = 'ELO Δ -';
    }

    setText('p1-map-header', `${p1.cnName} 胜`);
    setText('p2-map-header', `${p2.cnName} 胜`);

    renderH2HMapTable(fightData.mapData, selectedMapKey);
    renderIntel('p1', p1Stats, p1, selectedMapKey);
    renderIntel('p2', p2Stats, p2, selectedMapKey);
    renderRecentLog(recentData, p1, p2, selectedMapKey);
}

function setImg(id, src) {
    const el = document.getElementById(id);
    el.src = src || '';
    el.style.display = src ? '' : 'none';
}
function setText(id, val) { document.getElementById(id).textContent = val; }

function setRaceWatermark(id, race) {
    const el = document.getElementById(id);
    el.textContent = '';
    el.style.display = 'none'; // 头像上不显示种族字母
}

// ---- H2H map table ----
function renderH2HMapTable(fightMapData, filterKey) {
    const tbody = document.getElementById('map-tbody');
    tbody.innerHTML = '';
    const fightByMap = {};
    (fightMapData || []).forEach(m => { fightByMap[mapKey(m.mapKr)] = m; });

    const mapsToShow = filterKey ? seasonMaps.filter(m => mapKey(m.kr) === filterKey) : seasonMaps;
    mapsToShow.forEach(map => {
        const key = mapKey(map.kr);
        const fm = fightByMap[key] || { player1Wins: 0, player2Wins: 0, total: 0 };
        const h2hTotal = fm.player1Wins + fm.player2Wins;
        const p1Pct = h2hTotal > 0 ? Math.round(fm.player1Wins / h2hTotal * 100) : 0;
        const p2Pct = h2hTotal > 0 ? 100 - p1Pct : 0;

        const tr = document.createElement('tr');
        if (h2hTotal === 0) tr.classList.add('row-empty');

        const tdMap = document.createElement('td');
        tdMap.className = 'map-name';
        tdMap.innerHTML = `<span class="map-cn">${escapeHtml(map.cn)}</span><span class="map-kr">${escapeHtml(map.kr)}</span>`;
        tr.appendChild(tdMap);

        const td1 = document.createElement('td');
        td1.className = 'p1-wins';
        td1.textContent = h2hTotal > 0 ? fm.player1Wins : '·';
        if (h2hTotal === 0) td1.classList.add('muted');
        tr.appendChild(td1);

        const td2 = document.createElement('td');
        td2.className = 'p2-wins';
        td2.textContent = h2hTotal > 0 ? fm.player2Wins : '·';
        if (h2hTotal === 0) td2.classList.add('muted');
        tr.appendChild(td2);

        const tdBar = document.createElement('td');
        tdBar.className = 'bar-cell';
        const bar = document.createElement('div');
        bar.className = 'bar-container';
        const b1 = document.createElement('div'); b1.className = 'bar-p1'; b1.style.width = p1Pct + '%';
        const b2 = document.createElement('div'); b2.className = 'bar-p2'; b2.style.width = p2Pct + '%';
        bar.appendChild(b1); bar.appendChild(b2);
        const lbl = document.createElement('div'); lbl.className = 'bar-label';
        lbl.textContent = h2hTotal > 0 ? `${p1Pct}% : ${p2Pct}%` : 'NO ENGAGEMENT';
        tdBar.appendChild(bar); tdBar.appendChild(lbl);
        tr.appendChild(tdBar);

        tbody.appendChild(tr);
    });
}

// ---- Map intel (per matchup) ----
function renderIntel(prefix, stats, player, filterKey) {
    const nameEl = document.getElementById(`${prefix}-intel-name`);
    const sumEl = document.getElementById(`${prefix}-intel-summary`);
    const legendEl = document.getElementById(`${prefix}-mu-legend`);
    const tableEl = document.getElementById(`${prefix}-intel-table`);

    nameEl.textContent = `${player.cnName} · ${player.krName}`;

    if (!stats) {
        sumEl.textContent = '数据不可用';
        legendEl.innerHTML = '';
        tableEl.innerHTML = '';
        return;
    }

    const race = stats.playerRace || '?';
    const muKeys = stats.matchupKeys || [];

    // summary: 全部地图显示总战绩，筛选单地图时只显示该地图战绩
    const mapByKr = {};
    (stats.mapStats || []).forEach(m => { mapByKr[mapKey(m.mapKr)] = m; });

    const parts = [`RACE ${race}`];
    if (filterKey) {
        const fm = mapByKr[filterKey];
        if (fm) {
            const t = fm.total;
            parts.push(`${t.wins}W-${t.losses}L`);
            muKeys.forEach(k => {
                const mu = fm.matchups[k];
                if (mu && mu.total > 0) parts.push(`${k} ${mu.wins}-${mu.losses}`);
            });
        } else {
            parts.push('0W-0L');
        }
    } else {
        parts.push(`${stats.totalWins}W-${stats.totalLosses}L`);
        muKeys.forEach(k => {
            const t = stats.matchupTotals[k];
            if (t && t.total > 0) parts.push(`${k} ${t.wins}-${t.losses}`);
        });
    }
    sumEl.textContent = parts.join('  ·  ');

    // legend chips
    legendEl.innerHTML = '';
    MU_OPP_ORDER.forEach(opp => {
        const chip = document.createElement('span');
        chip.className = 'mu-chip';
        chip.innerHTML = `<span class="mu-dot" style="background:${RACE_COLOR[opp]}"></span>${race}v${opp}`;
        legendEl.appendChild(chip);
    });

    // table
    let html = '<thead><tr><th class="map-col-h" style="text-align:left">MAP</th>';
    MU_OPP_ORDER.forEach(opp => {
        html += `<th class="mu-${opp}">${escapeHtml(race)}v${escapeHtml(opp)}</th>`;
    });
    html += '<th>TOTAL</th></tr></thead><tbody>';

    const mapsToShow = filterKey ? seasonMaps.filter(m => mapKey(m.kr) === filterKey) : seasonMaps;
    mapsToShow.forEach(map => {
        const key = mapKey(map.kr);
        const m = mapByKr[key] || { matchups: {}, total: { wins: 0, losses: 0, total: 0, winRate: '-' } };
        html += `<tr><td class="map-col"><span class="ic-cn">${escapeHtml(map.cn)}</span><span class="ic-kr">${escapeHtml(map.kr)}</span></td>`;
        MU_OPP_ORDER.forEach(opp => {
            const muKey = `${race}v${opp}`;
            const mu = (m.matchups && m.matchups[muKey]) || { wins: 0, losses: 0, total: 0, winRate: '-' };
            html += `<td>${muCell(mu)}</td>`;
        });
        html += `<td>${muCell(m.total, true)}</td>`;
        html += '</tr>';
    });
    html += '</tbody>';
    tableEl.innerHTML = html;
}

function muCell(mu, isTotal) {
    if (!mu || mu.total === 0) return `<span class="cell-zero">—</span>`;
    return `<span class="rec-wins">${mu.wins}</span><span class="rec-sep">-</span><span class="rec-losses">${mu.losses}</span>`;
}

// ---- Recent engagement log (last 6 months, paginated) ----
const LOG_PAGE_SIZE = 30;
let logCurrentPage = 1;

function renderRecentLog(recentData, p1, p2, filterKey, page) {
    const container = document.getElementById('recent-log');
    const countEl = document.getElementById('log-count');
    container.innerHTML = '';

    let matches = (recentData && recentData.recentMatches) || [];
    // 地图筛选：只保留该赛季地图的记录
    if (filterKey) {
        matches = matches.filter(m => mapKey(m.mapKr) === filterKey);
    }

    const total = matches.length;
    const totalPages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
    // 切换筛选/新查询时重置到第1页；否则用传入 page（来自分页按钮）
    const cur = page || 1;
    logCurrentPage = Math.min(cur, totalPages);

    countEl.textContent = total > 0 ? `// ${total} ENGAGEMENT(S)` : '// 0 ENGAGEMENT';

    if (total === 0) {
        const empty = document.createElement('div');
        empty.className = 'log-empty';
        empty.textContent = '近 3 个月内无交战记录';
        container.appendChild(empty);
        return;
    }

    const start = (logCurrentPage - 1) * LOG_PAGE_SIZE;
    const pageItems = matches.slice(start, start + LOG_PAGE_SIZE);

    // 列优先排列：前一半进左列，后一半进右列
    const half = Math.ceil(pageItems.length / 2);
    const leftCol = document.createElement('div');
    leftCol.className = 'log-col';
    const rightCol = document.createElement('div');
    rightCol.className = 'log-col';

    const buildItem = (m) => {
        const item = document.createElement('div');
        item.className = `log-item win-${m.winner}`;

        // elo change sign + class
        let eloText = m.eloChange || '';
        let eloCls = '';
        const eloNum = parseFloat(String(eloText).replace(/[^\d.\-]/g, ''));
        if (!isNaN(eloNum)) {
            if (eloNum > 0) { eloCls = 'pos'; if (eloText.charAt(0) !== '+') eloText = '+' + eloText; }
            else if (eloNum < 0) { eloCls = 'neg'; }
        }

        const winnerName = m.winner === 'p1' ? p1.cnName : p2.cnName;
        const winnerCls = m.winner === 'p1' ? 'p1' : 'p2';
        // 非赛季地图：mapCn 显示空白，仅显示原始韩文地图名
        const mapCn = m.isSeasonMap ? m.mapCn : '';
        const mapKr = m.mapKr || m.mapName || '';
        const memoText = m.memo || m.format || '';

        item.innerHTML =
            `<div class="log-date">${escapeHtml(m.date)}</div>` +
            `<div class="log-map">${escapeHtml(mapCn)}<span class="lm-kr">${escapeHtml(mapKr)}</span></div>` +
            `<div class="log-memo" title="${escapeHtml(memoText)}">${escapeHtml(memoText)}</div>` +
            `<div class="log-side">` +
                `<span class="log-winner ${winnerCls}">▲ ${escapeHtml(winnerName)}</span>` +
                `<span class="log-elo ${eloCls}">${escapeHtml(eloText || '—')}</span>` +
            `</div>`;
        return item;
    };

    pageItems.slice(0, half).forEach(m => leftCol.appendChild(buildItem(m)));
    pageItems.slice(half).forEach(m => rightCol.appendChild(buildItem(m)));
    container.appendChild(leftCol);
    container.appendChild(rightCol);

    // 分页控件
    if (totalPages > 1) {
        const pager = document.createElement('div');
        pager.className = 'log-pager';
        const prev = document.createElement('button');
        prev.className = 'pager-btn';
        prev.textContent = '◀ 上一页';
        prev.disabled = logCurrentPage <= 1;
        prev.addEventListener('click', () => {
            renderRecentLog(recentData, p1, p2, filterKey, logCurrentPage - 1);
        });

        const info = document.createElement('span');
        info.className = 'pager-info mono';
        info.textContent = `${logCurrentPage} / ${totalPages}  ·  第 ${start + 1}-${Math.min(start + LOG_PAGE_SIZE, total)} 条 / 共 ${total} 条`;

        const next = document.createElement('button');
        next.className = 'pager-btn';
        next.textContent = '下一页 ▶';
        next.disabled = logCurrentPage >= totalPages;
        next.addEventListener('click', () => {
            renderRecentLog(recentData, p1, p2, filterKey, logCurrentPage + 1);
        });

        pager.appendChild(prev);
        pager.appendChild(info);
        pager.appendChild(next);
        container.appendChild(pager);
    }
}

// ---- Error ----
function showError(message) {
    errorDiv.textContent = '// ' + message;
    errorDiv.classList.remove('hidden');
    loading.classList.add('hidden');
}

// Start
init();
