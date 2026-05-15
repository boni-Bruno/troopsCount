/*
 * Script Name: Troop Counter
 * Version: v1.0.0
 * Descrição: Contagem de tropas por grupo e aldeia com tabela dinâmica
 *            (totalizador → grupo → aldeia), reordenável e expansível.
 *
 * USO: javascript: $.getScript('SUA_URL_RAW');
 */

(function () {
    'use strict';

    /* ─── Config ──────────────────────────────────────────────────────── */
    const SCRIPT  = 'Troop Counter';
    const KEY_ORD = 'tc2_groupOrder';
    const KEY_EXP = 'tc2_expanded';
    const DELAY   = 200;
    const MAX_PG  = 100;

    const ROW_KEYS = ['suas_proprias', 'na_aldeia', 'fora', 'em_transito', 'total'];
    const ROW_LBLS = {
        suas_proprias : 'suas próprias',
        na_aldeia     : 'Na Aldeia',
        fora          : 'fora',
        em_transito   : 'em trânsito',
        total         : 'total',
    };

    /* ─── Estado global ───────────────────────────────────────────────── */
    let unitTypes  = [];   // ['spear','sword','axe', ...]  sem militia
    let groups     = [];   // [{group_id, name}, ...]
    let groupData  = {};   // { gid: { name, villages:{ vid:{ id,name,coord,rows:{} } } } }
    let groupOrder = [];   // [gid, gid, ...]  — ordem exibida
    let expanded   = {};   // { gid: bool, 'v_'+vid: bool }

    /* ─── Entry ───────────────────────────────────────────────────────── */
    init();

    async function init() {
        unitTypes = game_data.units.filter(u => u !== 'militia');
        expanded  = JSON.parse(localStorage.getItem(KEY_EXP) || '{}');

        showLoading();

        try {
            groups     = await fetchGroups();
            groupOrder = rebuildOrder(groups.map(g => String(g.group_id)));

            for (const gid of groupOrder) {
                const g = groups.find(x => String(x.group_id) === gid);
                if (!g) continue;
                groupData[gid] = { name: g.name, villages: {} };
                updateLoading(`Carregando grupo: <strong>${g.name}</strong>...`);
                await fetchGroupUnits(gid);
            }

            renderDialog();
        } catch (err) {
            // Mostra o erro dentro do Dialog para fácil diagnóstico
            const msg = err?.message || String(err);
            Dialog.show('tc', `
                <style>#popup_box_tc{width:760px !important;}</style>
                <h3>🪖 ${SCRIPT} — Erro</h3>
                <p style="color:red;padding:10px;"><strong>Erro:</strong> ${msg}</p>
                <p style="font-size:11px;color:#888;">Veja o Console (F12) para detalhes.</p>`);
            console.error(`[${SCRIPT}]`, err);
        }
    }

    /* ─── Data fetching ───────────────────────────────────────────────── */

    /** URL builder manual — funciona em qualquer tela do TW */
    function twURL(screen, mode, params) {
        let url = `game.php?village=${game_data.village.id}&screen=${screen}`;
        if (mode) url += `&mode=${mode}`;
        for (const [k, v] of Object.entries(params || {})) url += `&${k}=${encodeURIComponent(v)}`;
        if (game_data.player.sitter > 0) url += `&t=${game_data.player.id}`;
        return url;
    }

    function fetchGroups() {
        return $.get(twURL('groups', null, { ajax: 'load_group_menu' }))
            .then(d => (d.result || []).filter(g => g.type !== 'separator'));
    }

    async function fetchGroupUnits(gid) {
        for (let page = 0; page <= MAX_PG; page++) {
            const html  = await $.get(twURL('overview_villages', 'units', {
                group: gid, page,
            }));
            parseUnitsPage($(html), gid);
            const hasNext = $(html).find(`.paged-nav-item[href*="page=${page + 1}"]`).length > 0;
            if (!hasNext) break;
            await sleep(DELAY);
        }
    }

    /**
     * Parseia a página overview_villages?mode=units.
     *
     * Estrutura esperada: #units_table com um <tbody> por aldeia,
     * cada tbody com até 5 <tr> (suas próprias / Na Aldeia / fora /
     * em trânsito / total). A primeira <tr> de cada tbody contém o
     * nome e coordenada da aldeia.
     */
    function parseUnitsPage($html, gid) {
        const $tbl = $html.find('#units_table');
        if (!$tbl.length) return;

        $tbl.children('tbody').each(function () {
            const $tbody = $(this);
            let vid = null, name = '', coord = '';

            // Detecta village pela primeira tr (tem .quickedit-vn)
            const $firstTr = $tbody.find('tr').first();
            const $qvn     = $firstTr.find('[data-id]').first();
            if ($qvn.length) {
                vid   = String($qvn.data('id'));
                name  = $firstTr.find('.quickedit-label').data('text')
                     || $firstTr.find('.quickedit-label').text().trim();
                coord = ($firstTr.find('.quickedit-label').text().match(/\d{1,3}\|\d{1,3}/) || [''])[0];
            }

            if (!vid) return; // tbody sem village

            if (!groupData[gid].villages[vid]) {
                groupData[gid].villages[vid] = {
                    id: vid, name, coord,
                    suas_proprias: null,
                    na_aldeia    : null,
                    fora         : null,
                    em_transito  : null,
                    total        : null,
                };
            }

            const village = groupData[gid].villages[vid];

            // Percorre todas as <tr> do tbody para capturar as linhas de tropas
            $tbody.find('tr').each(function () {
                const $tr   = $(this);
                const units = parseUnitCounts($tr);
                if (!units) return;

                // Determina a categoria pela label presente na linha
                const rowKey = detectRowKey($tr);
                if (rowKey && !village[rowKey]) {
                    village[rowKey] = padUnits(units);
                }
            });
        });
    }

    /** Lê os números das células com classe unit-item (ou .s1 genérico) */
    function parseUnitCounts($tr) {
        const cells = $tr.find('.unit-item');
        if (!cells.length) return null;
        return cells.map((_, el) => {
            return parseInt($(el).text().replace(/[^\d]/g, '')) || 0;
        }).get();
    }

    /** Detecta a categoria da linha pelo texto de algum <td> da row */
    function detectRowKey($tr) {
        let found = null;
        $tr.find('td').each(function () {
            const t = $(this).text().trim().toLowerCase();
            if (!t) return;
            if (t.includes('suas'))                     { found = 'suas_proprias'; return false; }
            if (t === 'na aldeia')                       { found = 'na_aldeia';     return false; }
            if (t === 'fora')                            { found = 'fora';          return false; }
            if (t.includes('nsito') || t.includes('nsi')) { found = 'em_transito'; return false; }
            if (t === 'total')                           { found = 'total';         return false; }
        });
        return found;
    }

    /** Garante array com tamanho igual a unitTypes */
    function padUnits(arr) {
        const out = arr.slice(0, unitTypes.length);
        while (out.length < unitTypes.length) out.push(0);
        return out;
    }

    /* ─── Cálculos ────────────────────────────────────────────────────── */

    function zero()       { return new Array(unitTypes.length).fill(0); }
    function add(a, b)    { return (a || zero()).map((v, i) => v + ((b || zero())[i] || 0)); }

    function villageRow(village, rk) { return village[rk] || zero(); }

    function groupRow(gid, rk) {
        return Object.values(groupData[gid]?.villages || {})
            .reduce((acc, v) => add(acc, villageRow(v, rk)), zero());
    }

    function grandRow(rk) {
        // Deduplica por village ID — aldeia em múltiplos grupos conta apenas 1x
        const seen = {}, unique = {};
        for (const gid of groupOrder) {
            const vils = groupData[gid]?.villages || {};
            for (const vid in vils) {
                if (!seen[vid]) { seen[vid] = true; unique[vid] = vils[vid]; }
            }
        }
        return Object.values(unique).reduce((acc, v) => add(acc, villageRow(v, rk)), zero());
    }

    /* ─── Rendering ───────────────────────────────────────────────────── */

    function showLoading() {
        Dialog.show('tc', `
            <style>#popup_box_tc{width:760px !important;}</style>
            <h3>🪖 ${SCRIPT}</h3>
            <p id="tc-load-msg" style="text-align:center;padding:30px;">
                Carregando tropas de todos os grupos...
            </p>`);
    }

    function updateLoading(msg) {
        const el = document.getElementById('tc-load-msg');
        if (el) el.innerHTML = msg;
    }

    function renderDialog() {
        const KEY_SIZE = 'tc2_size';
        const saved    = JSON.parse(localStorage.getItem(KEY_SIZE) || '{"w":900,"h":500}');

        const unitHeaders = unitTypes.map(u =>
            `<th class="tc-col-unit" title="${u}">
                <img src="/graphic/unit/unit_${u}.png" style="width:21px;display:block;margin:auto;">
             </th>`
        ).join('');

        const html = `
        <style>
            #popup_box_tc      { overflow:hidden !important; box-sizing:border-box !important; }
            .tc-wrap           { font-size:12px; display:flex; flex-direction:column; }
            .tc-titlebar       { display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap; }
            .tc-title          { font-size:14px;font-weight:bold;color:#6b3a10;margin-right:auto; }
            .tc-size-label     { font-size:11px;color:#888; }
            .tc-size-input     { width:52px;padding:1px 3px;font-size:11px;border:1px solid #aaa;border-radius:2px; }
            .tc-scroll         { overflow:auto;flex:1; }
            .tc-table          { border-collapse:collapse;table-layout:auto; }
            .tc-table th,
            .tc-table td       { border:1px solid #c9a56a;padding:2px 4px;white-space:nowrap; }
            .tc-table thead th { background:#c1a264;color:#3d1c00;position:sticky;top:0;z-index:2; }
            .tc-col-label      { min-width:150px;text-align:left; }
            .tc-col-rowtype    { min-width:85px;text-align:left; }
            .tc-col-unit       { min-width:28px;text-align:center; }
            .tc-col-actions    { min-width:48px;text-align:center; }
            .tc-grand-hdr td   { background:#a67c2f;color:#fff;font-weight:bold;cursor:pointer; }
            .tc-grand-row td   { background:#e8d4a0; }
            .tc-grand-sum td   { background:#d9c07a;font-weight:bold;border-top:2px solid #a67c2f; }
            .tc-group-hdr td   { background:#d4a84b;color:#3d1c00;font-weight:bold;cursor:pointer; }
            .tc-group-hdr:hover td { background:#ddb95c; }
            .tc-group-row td   { background:#fff5da; }
            .tc-group-sum td   { background:#f0e2be;font-weight:bold;border-top:2px solid #c9a56a; }
            .tc-vil-hdr td     { background:#faf3e0;cursor:pointer; }
            .tc-vil-hdr:hover td { background:#f0e8cc; }
            .tc-vil-row td     { background:#fffdf5;font-size:11px; }
            .tc-vil-sum td     { background:#f5edcc;font-size:11px;font-weight:bold;border-top:1px solid #c9a56a; }
            .tc-num            { text-align:right; }
            .tc-zero           { color:#ccc;text-align:right; }
            .tc-exp            { margin-right:5px;font-size:10px;color:#666; }
            .tc-btn            { cursor:pointer;padding:1px 5px;font-size:11px;border:1px solid #aaa;
                                 border-radius:2px;background:#f4e4bc;line-height:1.4; }
            .tc-btn:hover      { background:#e0c88a; }
        </style>
        <div class="tc-wrap" id="tc-wrap">
            <div class="tc-titlebar">
                <span class="tc-title">🪖 ${SCRIPT}</span>
                <span class="tc-size-label">Largura:</span>
                <input class="tc-size-input" id="tc-inp-w" type="number" min="400" max="2000" value="${saved.w}">
                <span class="tc-size-label">Altura:</span>
                <input class="tc-size-input" id="tc-inp-h" type="number" min="200" max="1200" value="${saved.h}">
                <button class="tc-btn" id="tc-btn-apply">✔ Aplicar</button>
            </div>
            <div class="tc-scroll" id="tc-scroll">
                <table class="vis tc-table" id="tc-tbl">
                    <thead>
                        <tr>
                            <th class="tc-col-label">Grupo / Aldeia</th>
                            <th class="tc-col-rowtype">Linha</th>
                            ${unitHeaders}
                            <th class="tc-col-actions"></th>
                        </tr>
                    </thead>
                    <tbody id="tc-body"></tbody>
                </table>
            </div>
        </div>`;

        Dialog.show('tc', html);
        applySize(saved.w, saved.h);
        rebuildBody();
        bindEvents();

        $('#tc-btn-apply').on('click', function () {
            const w = parseInt($('#tc-inp-w').val()) || 900;
            const h = parseInt($('#tc-inp-h').val()) || 500;
            localStorage.setItem(KEY_SIZE, JSON.stringify({ w, h }));
            applySize(w, h);
        });
    }

    function applySize(w, h) {
        const TITLEBAR_H = 40; // px aproximados da barra de título + inputs
        $('#popup_box_tc').css({ width: w + 'px', maxWidth: 'none', height: h + 'px', maxHeight: 'none' });
        $('#tc-scroll').css({ height: (h - TITLEBAR_H) + 'px', maxHeight: 'none' });
    }

    function applyDynamicHeight() { /* não usado */ }
    function makeResizable()      { /* não usado */ }

    /** Reconstrói somente o <tbody> sem recriar o Dialog inteiro */
    function rebuildBody() {
        const $body = $('#tc-body');
        if (!$body.length) return;
        $body.empty();

        // ── Grand Total ──────────────────────────────────────────────────
        const grandExp = !!expanded['__grand__'];
        $body.append(buildSummaryRow(
            '__grand__', 'TOTAL GERAL', grandExp, 'tc-grand-hdr',
            'tc-grand-row', 'tc-grand-sum', null
        ));

        // ── Grupos ───────────────────────────────────────────────────────
        groupOrder.forEach((gid, idx) => {
            const g = groupData[gid];
            if (!g) return;
            const gExp = !!expanded[gid];

            $body.append(buildSummaryRow(
                gid, g.name, gExp, 'tc-group-hdr',
                'tc-group-row', 'tc-group-sum',
                buildReorderBtns(gid, idx)
            ));

            // Aldeias (só renderiza se o grupo estiver expandido)
            Object.values(g.villages).forEach(village => {
                const vkey = 'v_' + village.id;
                const vExp = !!(gExp && expanded[vkey]);
                $body.append(buildVillageRows(gid, village, gExp, vExp));
            });
        });
    }

    /**
     * Cria as linhas de um bloco totalizador (Grand Total ou Grupo).
     * Linha 0: header clicável (toggle expand)
     * Linhas 1-3: suas próprias / Na Aldeia / fora / em trânsito  (visível se expandido)
     * Linha 4: total (sempre visível junto ao header)
     */
    function buildSummaryRow(key, label, isExp, hdrCls, rowCls, sumCls, extra) {
        const isGrand  = key === '__grand__';
        const getValue = rk => isGrand ? grandRow(rk) : groupRow(key, rk);
        const $frag    = $('<tbody class="tc-dummy">'); // container temporário

        // ── Header row (com expand icon + label) ──────────────────────
        const $hdr = $('<tr>').addClass(hdrCls)
            .attr('data-toggle', isGrand ? 'grand' : 'group')
            .attr('data-key', key);

        const expIcon = isExp ? '▼' : '▶';
        $hdr.append(
            $('<td class="tc-col-label">').html(
                `<span class="tc-exp">${expIcon}</span><strong>${esc(label)}</strong>`
            ),
            $('<td class="tc-col-rowtype">').html('<em>—</em>'),
            ...numCells(getValue('total')),
            $('<td class="tc-col-actions">').html(extra || '')
        );
        $frag.append($hdr);

        // ── Detail rows (suas próprias / Na Aldeia / fora / em trânsito) ──
        ['suas_proprias', 'na_aldeia', 'fora', 'em_transito'].forEach(rk => {
            const $row = $('<tr>').addClass(rowCls)
                .attr('data-under', isGrand ? 'grand' : 'group')
                .attr('data-key', key)
                .css('display', isExp ? '' : 'none');
            $row.append(
                $('<td class="tc-col-label">'),
                $('<td class="tc-col-rowtype">').text(ROW_LBLS[rk]),
                ...numCells(getValue(rk)),
                $('<td class="tc-col-actions">')
            );
            $frag.append($row);
        });

        // ── Total row (sempre visível com o header) ───────────────────
        const $sum = $('<tr>').addClass(sumCls)
            .attr('data-under', isGrand ? 'grand' : 'group')
            .attr('data-key', key)
            .css('display', isExp ? '' : 'none');
        $sum.append(
            $('<td class="tc-col-label">'),
            $('<td class="tc-col-rowtype" style="font-weight:bold;">').text(ROW_LBLS.total),
            ...numCells(getValue('total')),
            $('<td class="tc-col-actions">')
        );
        $frag.append($sum);

        return $frag.children();
    }

    /** Linhas de uma aldeia dentro de um grupo */
    function buildVillageRows(gid, village, gExp, vExp) {
        const $frag   = $('<tbody class="tc-dummy">');
        const vkey    = 'v_' + village.id;
        const display = gExp ? '' : 'none';
        const vDisplay = vExp ? '' : 'none';

        // Header da aldeia
        const $vhdr = $('<tr>').addClass('tc-vil-hdr')
            .attr('data-toggle', 'village')
            .attr('data-gid', gid)
            .attr('data-vid', village.id)
            .css('display', display);
        $vhdr.append(
            $('<td class="tc-col-label" style="padding-left:22px;">').html(
                `<span class="tc-exp">${vExp ? '▼' : '▶'}</span>
                 <a href="${game_data.link_base_pure}info_village&id=${village.id}" target="_blank">
                    ${esc(village.name)} <small>(${village.coord})</small>
                 </a>`
            ),
            $('<td class="tc-col-rowtype">').html('<em>—</em>'),
            ...numCells(villageRow(village, 'total')),
            $('<td class="tc-col-actions">')
        );
        $frag.append($vhdr);

        // Detail rows da aldeia
        ROW_KEYS.slice(0, 4).forEach(rk => {
            const $row = $('<tr>').addClass('tc-vil-row')
                .attr('data-under', 'village')
                .attr('data-gid', gid)
                .attr('data-vid', village.id)
                .css('display', vDisplay);
            $row.append(
                $('<td class="tc-col-label">'),
                $('<td class="tc-col-rowtype" style="padding-left:30px;">').text(ROW_LBLS[rk]),
                ...numCells(villageRow(village, rk)),
                $('<td class="tc-col-actions">')
            );
            $frag.append($row);
        });

        // Total da aldeia
        const $vsum = $('<tr>').addClass('tc-vil-sum')
            .attr('data-under', 'village')
            .attr('data-gid', gid)
            .attr('data-vid', village.id)
            .css('display', vDisplay);
        $vsum.append(
            $('<td class="tc-col-label">'),
            $('<td class="tc-col-rowtype" style="padding-left:30px;">').text(ROW_LBLS.total),
            ...numCells(villageRow(village, 'total')),
            $('<td class="tc-col-actions">')
        );
        $frag.append($vsum);

        return $frag.children();
    }

    function buildReorderBtns(gid, idx) {
        const up = idx > 0
            ? `<button class="tc-btn tc-up" data-gid="${gid}">↑</button>`
            : `<button class="tc-btn" style="visibility:hidden;">↑</button>`;
        const dn = idx < groupOrder.length - 1
            ? `<button class="tc-btn tc-dn" data-gid="${gid}">↓</button>`
            : `<button class="tc-btn" style="visibility:hidden;">↓</button>`;
        return up + ' ' + dn;
    }

    /** Gera células de número para cada unidade */
    function numCells(arr) {
        return (arr || zero()).slice(0, unitTypes.length).map(v =>
            v === 0
                ? $('<td class="tc-zero">').text('0')
                : $('<td class="tc-num">').text(v.toLocaleString('de'))
        );
    }

    /* ─── Eventos ─────────────────────────────────────────────────────── */

    function bindEvents() {
        // Toggle TOTAL GERAL
        $(document).off('click.tc').on('click.tc', '[data-toggle="grand"]', function () {
            expanded['__grand__'] = !expanded['__grand__'];
            saveExpanded();
            const isExp = expanded['__grand__'];
            $('[data-under="grand"]').toggle(isExp);
            $(this).find('.tc-exp').text(isExp ? '▼' : '▶');
        });

        // Toggle grupo
        $(document).on('click.tc', '[data-toggle="group"]', function () {
            const gid   = String($(this).data('key'));
            expanded[gid] = !expanded[gid];
            saveExpanded();
            const isExp = expanded[gid];
            $(`[data-under="group"][data-key="${gid}"]`).toggle(isExp);
            // colapsa aldeias ao fechar grupo
            if (!isExp) {
                $(`[data-toggle="village"][data-gid="${gid}"]`).hide();
                $(`[data-under="village"][data-gid="${gid}"]`).hide();
                Object.keys(expanded).forEach(k => { if (k.startsWith('v_')) delete expanded[k]; });
            } else {
                $(`[data-toggle="village"][data-gid="${gid}"]`).show();
                // Não abre aldeias automaticamente — deixa o usuário clicar
            }
            $(this).find('.tc-exp').text(isExp ? '▼' : '▶');
        });

        // Toggle aldeia
        $(document).on('click.tc', '[data-toggle="village"]', function (e) {
            e.stopPropagation();
            const gid  = String($(this).data('gid'));
            const vid  = String($(this).data('vid'));
            const vkey = 'v_' + vid;
            expanded[vkey] = !expanded[vkey];
            saveExpanded();
            const isExp = expanded[vkey];
            $(`[data-under="village"][data-gid="${gid}"][data-vid="${vid}"]`).toggle(isExp);
            $(this).find('.tc-exp').text(isExp ? '▼' : '▶');
        });

        // Reordenar ↑
        $(document).on('click.tc', '.tc-up', function (e) {
            e.stopPropagation();
            const gid = String($(this).data('gid'));
            const idx = groupOrder.indexOf(gid);
            if (idx > 0) {
                [groupOrder[idx - 1], groupOrder[idx]] = [groupOrder[idx], groupOrder[idx - 1]];
                saveOrder();
                rebuildBody();
            }
        });

        // Reordenar ↓
        $(document).on('click.tc', '.tc-dn', function (e) {
            e.stopPropagation();
            const gid = String($(this).data('gid'));
            const idx = groupOrder.indexOf(gid);
            if (idx < groupOrder.length - 1) {
                [groupOrder[idx], groupOrder[idx + 1]] = [groupOrder[idx + 1], groupOrder[idx]];
                saveOrder();
                rebuildBody();
            }
        });
    }

    /* ─── Persistência ────────────────────────────────────────────────── */

    function rebuildOrder(ids) {
        const saved   = JSON.parse(localStorage.getItem(KEY_ORD) || '[]');
        const valid   = saved.filter(id => ids.includes(id));
        const missing = ids.filter(id => !valid.includes(id));
        return [...valid, ...missing];
    }

    function saveOrder()    { localStorage.setItem(KEY_ORD, JSON.stringify(groupOrder)); }
    function saveExpanded() { localStorage.setItem(KEY_EXP, JSON.stringify(expanded));  }

    /* ─── Utils ───────────────────────────────────────────────────────── */

    function zero()     { return new Array(unitTypes.length).fill(0); }
    function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }
    function esc(s)     { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

})();
