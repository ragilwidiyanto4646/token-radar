// Token Launch Radar's plain dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, a filterable table, a per-protocol detail view with the model's own
// inputs and the protocol's farm plan, and the live-token set beside it. No network: every byte it
// shows is in data.js. No external links: addresses are shown as plain text, never as hrefs.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var ROWS = DATA.rows || [];
  var LIVE = DATA.live || [];
  var state = { q: '', category: '', chain: '', tier: '', sort: 'rank', tab: 'board', watchlistOnly: false };

  function fmt(v) {
    if (v === null || v === undefined || !isFinite(v)) return 'n/a';
    if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }
  function pct(v) {
    if (v === null || v === undefined || !isFinite(v)) return 'n/a';
    return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  }
  function num2(v) {
    if (v === null || v === undefined || !isFinite(v)) return 'n/a';
    return String(v);
  }
  function like(v) {
    if (v === null || v === undefined || !isFinite(v)) return 'n/a';
    return Math.round(v * 100) + '%';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function $(id) { return document.getElementById(id); }

  function fillOptions(select, values) {
    var first = select.options[0];
    select.innerHTML = '';
    select.appendChild(first);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      select.appendChild(o);
    });
  }

  function init() {
    var cats = [], chains = [];
    ROWS.forEach(function (r) {
      if (cats.indexOf(r.category) < 0) cats.push(r.category);
      (r.chains || []).forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
    });
    cats.sort();
    chains.sort();
    fillOptions($('cat'), cats);
    fillOptions($('chain'), chains);

    var totalTvl = ROWS.reduce(function (a, r) { return a + r.tvlUsd; }, 0);
    var totalEv = ROWS.reduce(function (a, r) { return a + r.expectedValueUsd; }, 0);
    $('stats').innerHTML =
      '<div class="stat"><b>' + ROWS.length + '</b><span>protocols on the board</span></div>' +
      '<div class="stat"><b>' + fmt(totalTvl) + '</b><span>combined TVL</span></div>' +
      '<div class="stat"><b>' + fmt(totalEv) + '</b><span>total expected launch value</span></div>' +
      '<div class="stat"><b>' + DATA.watchlist_size + '</b><span>protocols on the watchlist</span></div>' +
      '<div class="stat"><b>' + esc(DATA.as_of) + '</b><span>snapshot date (UTC)</span></div>';
    $('accounting').textContent =
      'Snapshot ' + DATA.as_of + ' (' + DATA.source + '): ' + ROWS.length + ' rows on the board — the whole ' +
      DATA.watchlist_size + '-protocol watchlist (floor ' + fmt(DATA.floor_usd) + ') plus ' + DATA.early_size +
      ' early protocols below the floor. The live-token view beside the board shows the ' + DATA.live_size +
      ' largest protocols that already trade, at the market\'s own values — never mixed into the ranking.';

    $('tab-board').addEventListener('click', function () { setTab('board'); });
    $('tab-live').addEventListener('click', function () { setTab('live'); });
    ['q', 'cat', 'chain', 'tier', 'sort', 'watch'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        state.q = $('q').value.toLowerCase();
        state.category = $('cat').value;
        state.chain = $('chain').value;
        state.tier = $('tier').value;
        state.sort = $('sort').value;
        state.watchlistOnly = $('watch').checked;
        render();
      });
    });
    render();
    if (location.hash) show(location.hash.slice(1));
    else if (ROWS[0]) show(ROWS[0].slug);
  }

  function setTab(tab) {
    state.tab = tab;
    $('tab-board').setAttribute('aria-selected', tab === 'board' ? 'true' : 'false');
    $('tab-live').setAttribute('aria-selected', tab === 'live' ? 'true' : 'false');
    $('filters').style.display = tab === 'board' ? '' : 'none';
    $('board-table').hidden = tab !== 'board';
    $('live-table').hidden = tab !== 'live';
    render();
  }

  function render() {
    if (state.tab === 'live') { renderLive(); return; }
    var list = ROWS.filter(function (r) {
      return (!state.q || (r.name + ' ' + r.category + ' ' + (r.chains || []).join(' ')).toLowerCase().indexOf(state.q) >= 0) &&
        (!state.category || r.category === state.category) &&
        (!state.chain || (r.chains || []).indexOf(state.chain) >= 0) &&
        (!state.tier || r.valueTier === state.tier) &&
        (!state.watchlistOnly || r.onWatchlist);
    });
    var key = { rank: 'rank', score: 'score', tvl: 'tvlUsd', expected: 'expectedValueUsd', growth: 'change7dPct', likelihood: 'launchLikelihood' }[state.sort] || 'rank';
    var dir = key === 'rank' ? 1 : -1;
    // A missing 7d figure sorts as the lowest value, never as NaN.
    var val = function (r) { var v = r[key]; return (v === null || v === undefined || !isFinite(v)) ? -1e9 : v; };
    list = list.slice().sort(function (a, b) { return (val(a) - val(b)) * dir || (a.slug < b.slug ? -1 : 1); });
    $('count').textContent = list.length + ' of ' + ROWS.length + ' protocols shown';
    $('rows').innerHTML = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"><td><span class="tier ' + r.valueTier + '">' + r.valueTier + '</span> ' + r.rank +
        (r.onWatchlist ? ' <span class="star" title="On the house watchlist">★</span>' : '') + '</td><td><b>' + esc(r.name) + '</b></td><td>' + esc(r.category) + '</td><td>' +
        (r.chains || []).slice(0, 3).map(esc).join(', ') + ((r.chains || []).length > 3 ? ' +' + ((r.chains || []).length - 3) : '') + '</td>' +
        '<td class="num">' + fmt(r.tvlUsd) + '</td><td class="num">' + pct(r.change7dPct) + '</td><td class="num">' + fmt(r.implied_value_usd) + '</td>' +
        '<td class="num">' + Math.round(r.launchLikelihood * 100) + '%</td><td class="num"><b>' + r.score + '</b></td></tr>';
    }).join('') || '<tr><td colspan="9">No protocols match this filter.</td></tr>';
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () { show(tr.getAttribute('data-slug')); });
    });
  }

  function renderLive() {
    $('count').textContent = LIVE.length + ' protocols that already trade (market values, not a ranking)';
    $('live-rows').innerHTML = LIVE.map(function (r) {
      return '<tr><td><b>' + esc(r.name) + '</b></td><td>' + esc(r.category || '') + '</td><td>' +
        (r.chains || []).slice(0, 3).map(esc).join(', ') + '</td>' +
        '<td class="num">' + fmt(r.tvl_usd) + '</td><td class="num">' + fmt(r.mcap_usd) + '</td><td class="num">' + pct(r.change_7d) + '</td></tr>';
    }).join('');
  }

  function show(slug) {
    var r = null;
    ROWS.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    location.hash = slug;
    // When the category has fewer than 3 tokenised peers the multiple is
    // the snapshot's global median — say so, instead of "median of 0".
    var multText = r.categoryPeers > 0
      ? 'median mcap/TVL of ' + r.categoryPeers + ' tokenised ' + esc(r.category) + ' peers'
      : 'global median mcap/TVL (fewer than 3 tokenised ' + esc(r.category) + ' peers in the snapshot)';
    var comp = (r.comparables || []).map(function (c) {
      return esc(c.name) + ' (' + fmt(c.mcapUsd) + ' mcap / ' + fmt(c.tvlUsd) + ' TVL = ' + c.multiple.toFixed(2) + '×)';
    }).join(', ');
    $('detail').innerHTML =
      '<h2>' + esc(r.name) + ' <span style="color:#93a4bb;font-size:16px">#' + r.rank + ' · ' + esc(r.category) + ' · Tier ' + r.valueTier +
      (r.onWatchlist ? ' · <span class="star">★ watchlist</span>' : '') + '</span></h2>' +
      '<p>' + (r.chains || []).map(function (c) { return '<span class="pill">' + esc(c) + '</span>'; }).join('') + '</p>' +
      '<p><b>TVL:</b> ' + fmt(r.tvlUsd) + ' &nbsp; <b>Implied FDV:</b> ' + fmt(r.implied_value_usd) + ' (' + num2(r.categoryMultiple) + '× TVL, ' + multText + ') &nbsp; <b>Launch likelihood:</b> ' + like(r.launchLikelihood) + ' &nbsp; <b>Expected value:</b> ' + fmt(r.expectedValueUsd) +
      ' &nbsp; <b>Radar score:</b> ' + r.score + '/100 &nbsp; <b>7d:</b> ' + pct(r.change7dPct) + '</p>' +
      '<p class="method"><b>How the value was estimated:</b> TVL ' + fmt(r.tvlUsd) + ' × ' + num2(r.categoryMultiple) + '× (' + multText + ') × ' + num2(r.growthMultiplier) + ' (7d growth ' + pct(r.change7dPct) + ') × ' + num2(r.maturityMultiplier) +
      ' (maturity: ' + (r.ageDays === null ? 'age unreported, modelled as 365 days' : r.ageDays + ' days since first tracked') + ') = ' + fmt(r.implied_value_usd) + ' implied FDV.</p>' +
      '<table class="factors"><thead><tr><th>Factor</th><th class="num">Value</th><th>What it is</th></tr></thead><tbody>' +
      '<tr><td>TVL</td><td class="num">' + fmt(r.tvlUsd) + '</td><td>snapshot TVL, whole USD</td></tr>' +
      '<tr><td>Category multiple</td><td class="num">' + num2(r.categoryMultiple) + '×</td><td>' + multText + '</td></tr>' +
      '<tr><td>Growth multiplier</td><td class="num">' + num2(r.growthMultiplier) + '×</td><td>7d TVL change ' + pct(r.change7dPct) + '</td></tr>' +
      '<tr><td>Maturity multiplier</td><td class="num">' + num2(r.maturityMultiplier) + '×</td><td>' + (r.ageDays === null ? 'age unreported, modelled as 365 days' : r.ageDays + ' days since first tracked') + '</td></tr>' +
      '<tr><td><b>Implied FDV</b></td><td class="num"><b>' + fmt(r.implied_value_usd) + '</b></td><td>TVL × multiple × growth × maturity</td></tr>' +
      '<tr><td>Launch likelihood</td><td class="num">' + like(r.launchLikelihood) + '</td><td>category base rate from the snapshot, adjusted (see Methodology §4)</td></tr>' +
      '<tr><td><b>Expected value</b></td><td class="num"><b>' + fmt(r.expectedValueUsd) + '</b></td><td>implied FDV × launch likelihood</td></tr></tbody></table>' +
      '<p><b>DefiLlama:</b> defillama.com/protocol/' + esc(r.slug) + (r.twitter ? ' &nbsp; <b>X:</b> @' + esc(r.twitter) : '') + '</p>' +
      '<p class="method"><b>Token check:</b> ' + esc(r.evidence.tokenCheck) + (r.evidence.variantsMerged > 1 ? ' (' + r.evidence.variantsMerged + ' variants merged)' : '') + '.</p>' +
      (comp ? '<p><b>Tokenised comparables:</b> ' + comp + '</p>' : '') +
      '<h3>Farm plan — ' + esc(r.farmPlan.summary) + '</h3><ol>' +
      (r.farm_steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p><b>Time:</b> ' + esc(r.farmPlan.timeCommitment) + '</p><p><b>Risks:</b></p><ul>' +
      r.farmPlan.risks.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  init();
})();
