/* =========================================================================
   app.js —— 页面主逻辑：取数、计算、渲染、交互
   -------------------------------------------------------------------------
   数据流：
     ApiClient 取全市场快照
       → HeatEngine 计算热度分数 / 情绪五档 / 赛道冷热 / 出逃 / 轮动
         → 本文件把结果画到页面上
   页面不做任何假数据填充：取不到数据就显示失败原因。
   ========================================================================= */

(function () {
  'use strict';

  var Fmt = window.MarketSnapshot;

  /* 自动刷新间隔（毫秒） */
  var AUTO_REFRESH_MS = 60000;

  /* 赛道矩阵里每个赛道最多画多少个币种，避免方块过多拖慢页面 */
  var MATRIX_MAX_PER_SECTOR = 26;

  /* 气泡图上最多标注多少个代号 */
  var BUBBLE_LABEL_TOP = 6;

  /* ---- 全局状态 ---- */
  var S = {
    platform: 'cex',
    snapshot: null,
    analysis: null,
    compareUsed: null,
    baseline: null,
    rankMode: 'hot',
    search: '',
    bubbleFilter: 'all',
    selected: null,
    loading: false,
    lastFetchAt: null,
    timer: null,
    bubble: null
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined && html !== null) n.innerHTML = html;
    return n;
  }

  /* =======================================================================
     一、启动
     ======================================================================= */

  function init() {
    bindEvents();
    setupBubble();
    S.baseline = window.HistoryTracker.baselineState();
    refresh(true);
    startAutoRefresh();
  }

  /* =======================================================================
     二、取数与计算
     ======================================================================= */

  function refresh(isFirst) {
    if (S.loading) return;
    S.loading = true;
    setBusy(true);

    /* 环比基线：取上一次保存在浏览器里的快照 */
    var compare = window.HistoryTracker.getCompare();
    S.compareUsed = compare;
    S.baseline = window.HistoryTracker.baselineState();

    window.ApiClient.loadSnapshot(S.platform)
      .then(function (snap) {
        S.snapshot = snap;
        var analysis = window.HeatEngine.analyze(snap.coins, compare);
        S.analysis = analysis;
        S.lastFetchAt = snap.fetchedAt || Date.now();

        /* 存下本次快照，供下一次刷新做环比 */
        window.HistoryTracker.save(analysis);

        renderAll();
        hideAlert();
      })
      .catch(function (err) {
        showAlert('数据获取失败', err && err.message ? err.message : '未知原因');
      })
      .then(function () {
        S.loading = false;
        setBusy(false);
      });
  }

  function setBusy(busy) {
    var btn = $('refreshBtn');
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? '刷新中…' : '立即刷新';
    }
    if (busy && !S.analysis) {
      var bubbleEmpty = $('bubbleEmpty');
      if (bubbleEmpty) {
        bubbleEmpty.hidden = false;
        bubbleEmpty.textContent = '正在读取全市场行情快照…';
      }
    }
  }

  /* =======================================================================
     三、错误提示
     ======================================================================= */

  function showAlert(title, msg) {
    var box = $('alertBox');
    if (!box) return;
    $('alertTitle').textContent = title;
    $('alertMsg').innerHTML = String(msg || '').replace(/\n/g, '<br>');
    box.hidden = false;
  }

  function hideAlert() {
    var box = $('alertBox');
    if (box) box.hidden = true;
  }

  /* =======================================================================
     四、统一渲染
     ======================================================================= */

  function renderAll() {
    renderTopbar();
    renderStats();
    renderBubble();
    renderRank();
    renderRotation();
    renderOutflow();
    renderSectorRanks();
    renderMatrix();
  }

  /* ---- 4.1 顶部：情绪档位 + 指数 + 通道 ---- */
  function renderTopbar() {
    var a = S.analysis;
    if (!a) return;

    var badge = $('moodBadge');
    var label = $('moodBadgeLabel');
    if (badge) badge.setAttribute('data-mood', String(a.mood.level));
    if (label) label.textContent = a.mood.name;

    var scoreEl = $('moodScore');
    if (scoreEl) scoreEl.textContent = a.mood.score.toFixed(1);

    var fill = $('moodTrackFill');
    if (fill) fill.style.width = Math.max(2, Math.min(100, a.mood.score)) + '%';

    var descEl = $('moodDesc');
    if (descEl) {
      var p = a.mood.parts;
      descEl.textContent = '上涨家数占比 ' + (p.breadth === null ? '—' : (p.breadth * 100).toFixed(1) + '%') +
        '　成交额加权涨跌 ' + Fmt.fmtPct(p.wqChg) +
        '　高热度币种占比 ' + (p.hotRatio === null ? '—' : (p.hotRatio * 100).toFixed(1) + '%') +
        '　大饼占比 ' + (p.btcShare === null ? '—' : p.btcShare.toFixed(1) + '%');
      descEl.title = a.mood.desc;
    }

    var chip = $('sourceChip');
    if (chip) {
      var via = S.snapshot ? S.snapshot.via : null;
      var txt = window.ApiClient.channelText(via);
      chip.textContent = '取数通道：' + txt;
      chip.className = 'source-chip' + (via === 'proxy' ? ' is-proxy' : via === 'direct' ? ' is-direct' : '');
      chip.setAttribute('title', window.DataDirect.sourceLabel(S.platform, via));
    }

    var timeEl = $('refreshTime');
    if (timeEl) {
      timeEl.textContent = '更新于 ' + Fmt.fmtTime(S.lastFetchAt) +
        '（' + Fmt.fmtAgo(S.lastFetchAt) + '）';
    }
  }

  /* ---- 4.2 总览指标带 ---- */
  function renderStats() {
    var a = S.analysis;
    if (!a) return;
    var m = a.market;

    setStat('statTotalVol', Fmt.fmtMoney(m.totalQuoteVolume));
    setStatText('statTotalVolNote', '覆盖 ' + m.total + ' 个永续合约');

    setStat('statTotalOi', m.totalOiUsd === null ? '—' : Fmt.fmtMoney(m.totalOiUsd));

    setStat('statBreadth', m.breadth === null ? '—' : (m.breadth * 100).toFixed(1) + '%');
    setStatText('statBreadthNote', '上涨 ' + m.advancers + ' / 下跌 ' + m.decliners + ' / 平盘 ' + m.flats);

    var wq = $('statWqChg');
    if (wq) {
      wq.textContent = Fmt.fmtPct(m.wqChg);
      wq.className = 'stat-value ' + dirClass(m.wqChg);
    }

    var md = $('statMedianChg');
    if (md) {
      md.textContent = Fmt.fmtPct(m.medianChg);
      md.className = 'stat-value ' + dirClass(m.medianChg);
    }

    setStat('statBtcShare', m.btcShare === null ? '—' : m.btcShare.toFixed(1) + '%');
  }

  function setStat(id, text) {
    var n = $(id);
    if (n) n.textContent = text;
  }

  function setStatText(id, text) {
    var n = $(id);
    if (n) n.textContent = text;
  }

  function dirClass(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '';
    if (v > 0.005) return 'is-up';
    if (v < -0.005) return 'is-down';
    return '';
  }

  function valClass(v) {
    if (typeof v !== 'number' || !isFinite(v)) return 'val val-flat';
    if (v > 0.005) return 'val val-up';
    if (v < -0.005) return 'val val-down';
    return 'val val-flat';
  }

  /* ---- 4.3 气泡图 ---- */
  function setupBubble() {
    var canvas = $('bubbleCanvas');
    if (!canvas) return;
    if (!canvas.getContext) {
      /* 浏览器拿不到绘图上下文时，隐藏画布但保留其它所有面板 */
      var wrap = canvas.parentNode;
      if (wrap) wrap.style.display = 'none';
      var foot = $('bubbleFoot');
      if (foot) foot.textContent = '当前浏览器无法绘制图表，已隐藏气泡图，其余分析结果照常显示。';
      S.bubble = null;
      return;
    }
    S.bubble = window.HeatChart.createBubble(canvas);
    if (S.bubble) {
      S.bubble.setTooltip($('bubbleTip'));
      S.bubble.onSelect(function (symbol) { openDrawer(symbol); });
    }
  }

  function renderBubble() {
    var a = S.analysis;
    var empty = $('bubbleEmpty');
    if (!a) return;

    /* 出逃嫌疑的币种集合，用于气泡加虚线环 */
    var outflowSet = Object.create(null);
    a.outflow.forEach(function (o) { outflowSet[o.symbol] = true; });

    /* 全市场最大成交额作为气泡大小的统一基准 */
    var maxVol = 0;
    a.coins.forEach(function (c) {
      if (typeof c.quoteVolume === 'number' && c.quoteVolume > maxVol) maxVol = c.quoteVolume;
    });

    /* 热度最高的若干币在图上直接标注代号 */
    var topForLabel = a.coins.slice().sort(function (x, y) {
      return (y.heatScore === null ? -1 : y.heatScore) - (x.heatScore === null ? -1 : x.heatScore);
    }).slice(0, BUBBLE_LABEL_TOP);
    var labelSet = Object.create(null);
    topForLabel.forEach(function (c) { labelSet[c.symbol] = true; });

    var list = a.coins.slice();
    if (S.bubbleFilter === 'top') {
      list = topForLabel.concat(a.coins.slice().sort(function (x, y) {
        return (y.heatScore === null ? -1 : y.heatScore) - (x.heatScore === null ? -1 : x.heatScore);
      }).slice(0, 40));
      list = dedupe(list);
    } else if (S.bubbleFilter === 'outflow') {
      list = a.coins.filter(function (c) { return outflowSet[c.symbol]; });
      if (!list.length) {
        if (empty) { empty.hidden = false; empty.textContent = '当前没有符合出逃条件的币种'; }
        if (S.bubble) S.bubble.setData([], maxVol, S.selected);
        return;
      }
    }

    var items = list.map(function (c) {
      return {
        symbol: c.symbol,
        sectorName: c.sectorName,
        changePct: c.changePct,
        quoteVolume: c.quoteVolume,
        turnover: c.turnover,
        heatScore: c.heatScore,
        isOutflow: !!outflowSet[c.symbol],
        isLabeled: !!labelSet[c.symbol]
      };
    });

    if (empty) {
      if (!items.length) { empty.hidden = false; empty.textContent = '没有可展示的币种'; }
      else empty.hidden = true;
    }
    if (S.bubble) S.bubble.setData(items, maxVol, S.selected);

    var foot = $('bubbleFoot');
    if (foot) {
      var shown = items.length;
      foot.textContent = '当前展示 ' + shown + ' 个币种（全市场共 ' + a.market.total + ' 个）。' +
        '气泡位置越靠右上，说明涨幅越大、换手越活跃；带红色虚线环的是资金出逃嫌疑币种；点击任意气泡可查看详情。';
    }
  }

  function dedupe(list) {
    var seen = Object.create(null);
    var out = [];
    list.forEach(function (c) {
      if (!seen[c.symbol]) { seen[c.symbol] = true; out.push(c); }
    });
    return out;
  }

  /* ---- 4.4 热度排行榜 ---- */
  function renderRank() {
    var a = S.analysis;
    var body = $('rankBody');
    if (!a || !body) return;

    var list = a.coins.slice();

    /* 先按搜索词过滤整个市场，再按模式取子集。
       顺序不能颠倒：否则搜「BTC」时如果大饼不在当前榜单前 20 名里，
       就会出现「明明有这个币却搜不到」的怪现象。 */
    var kw = S.search.trim().toUpperCase();
    if (kw) {
      list = list.filter(function (c) {
        return c.symbol.indexOf(kw) >= 0 || String(c.sectorName).toUpperCase().indexOf(kw) >= 0;
      });
    }

    /* 再按模式排序取子集 */
    if (S.rankMode === 'hot') {
      list.sort(function (x, y) { return num(y.heatScore) - num(x.heatScore); });
      list = list.slice(0, 20);
    } else if (S.rankMode === 'cold') {
      list.sort(function (x, y) { return num(x.heatScore) - num(y.heatScore); });
      list = list.slice(0, 20);
    } else if (S.rankMode === 'turnover') {
      list.sort(function (x, y) { return num(y.turnover) - num(x.turnover); });
      list = list.slice(0, 20);
    } else {
      list.sort(function (x, y) { return num(y.heatScore) - num(x.heatScore); });
    }

    body.innerHTML = '';
    if (!list.length) {
      var tr0 = el('tr', 'row-empty');
      var td0 = el('td', null, kw ? '没有匹配「' + escapeHtml(S.search) + '」的币种' : '没有数据');
      td0.colSpan = 7;
      tr0.appendChild(td0);
      body.appendChild(tr0);
      var foot0 = $('rankFoot');
      if (foot0) {
        foot0.textContent = kw
          ? '搜索范围是全部 ' + a.market.total + ' 个永续合约，不只是当前榜单。'
          : '换手强度 = 24 小时成交额 ÷ 持仓量，用于替代无法计算的换手率。';
      }
      return;
    }

    /* 搜索状态下把命中数量写在标题下方，让用户知道一共找到几个 */
    var sub = $('rankSub');
    if (sub) {
      sub.textContent = kw
        ? '搜索「' + S.search + '」在全部 ' + a.market.total + ' 个合约中命中 ' + list.length + ' 个 · 点击任意一行查看详情'
        : '按热度分数排序 · 点击任意一行查看该币种详情';
    }

    list.forEach(function (c, i) {
      var tr = el('tr');
      tr.setAttribute('data-symbol', c.symbol);

      var tdNo = el('td', 'ta-c');
      tdNo.appendChild(el('span', 'rank-no', String(i + 1)));
      tr.appendChild(tdNo);

      var tdCoin = el('td');
      var cell = el('div', 'coin-cell');
      var dot = el('span', 'coin-dot');
      dot.style.background = c.sectorColor || '#94a3b8';
      cell.appendChild(dot);
      var nameWrap = el('div');
      nameWrap.appendChild(el('span', 'coin-name', escapeHtml(c.symbol)));
      nameWrap.appendChild(el('span', 'coin-pair', ' / ' + (S.platform === 'cex' ? 'USDT' : 'USD') + ' 永续'));
      cell.appendChild(nameWrap);
      tdCoin.appendChild(cell);
      tr.appendChild(tdCoin);

      var tdSector = el('td');
      tdSector.appendChild(el('span', 'sector-tag', escapeHtml(c.sectorName)));
      tr.appendChild(tdSector);

      var tdChg = el('td', 'ta-r');
      tdChg.appendChild(el('span', valClass(c.changePct), Fmt.fmtPct(c.changePct)));
      tr.appendChild(tdChg);

      tr.appendChild(el('td', 'ta-r val', Fmt.fmtMoney(c.quoteVolume)));
      tr.appendChild(el('td', 'ta-r val', Fmt.fmtTurnover(c.turnover)));

      var tdHeat = el('td', 'ta-r');
      var heatWrap = el('div', 'heat-cell');
      var bar = el('span', 'heat-bar');
      var barIn = el('span');
      var hs = num(c.heatScore);
      var col = window.HeatEngine.heatColor(hs);
      barIn.style.width = Math.max(2, Math.min(100, hs)) + '%';
      barIn.style.background = col.bg;
      bar.appendChild(barIn);
      heatWrap.appendChild(bar);
      heatWrap.appendChild(el('span', 'heat-num', hs.toFixed(1)));
      tdHeat.appendChild(heatWrap);
      tr.appendChild(tdHeat);

      if (S.selected === c.symbol) tr.classList.add('is-active');
      tr.addEventListener('click', function () { openDrawer(c.symbol); });
      body.appendChild(tr);
    });
  }

  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : -Infinity;
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---- 4.5 资金轮动 ---- */
  function renderRotation() {
    var a = S.analysis;
    if (!a) return;
    var r = a.rotation;

    var verdict = $('rotationVerdict');
    var vText = $('rotationVerdictText');
    if (verdict) verdict.setAttribute('data-dir', r.dir);

    if (vText) {
      var suffix = '';
      if (r.dir !== 'flat' && r.confirmed === true) suffix = '（大饼占比变化已确认）';
      else if (r.dir !== 'flat' && r.confirmed === false) suffix = '（大饼占比变化尚未确认）';
      vText.textContent = r.label + suffix;
    }

    var btcPerf = $('flowBtcPerf');
    if (btcPerf) {
      btcPerf.textContent = Fmt.fmtPct(r.btcPerf);
      btcPerf.className = 'flow-end-val ' + (r.btcPerf > 0.005 ? 'val-up' : r.btcPerf < -0.005 ? 'val-down' : 'val-flat');
      btcPerf.style.color = '';
    }
    var altPerf = $('flowAltPerf');
    if (altPerf) {
      altPerf.textContent = Fmt.fmtPct(r.altPerf);
      altPerf.className = 'flow-end-val ' + (r.altPerf > 0.005 ? 'val-up' : r.altPerf < -0.005 ? 'val-down' : 'val-flat');
      altPerf.style.color = '';
    }

    var ptr = $('flowPointer');
    if (ptr) {
      ptr.style.left = r.pointerPct + '%';
      ptr.setAttribute('data-dir', r.dir);
    }

    var rsEl = $('rotRs');
    if (rsEl) {
      rsEl.textContent = (r.rs === null ? '—' : (r.rs > 0 ? '+' : '') + r.rs.toFixed(2) + ' 个百分点');
      rsEl.className = 'kv-val ' + (r.rs > 0 ? 'val-up' : r.rs < 0 ? 'val-down' : '');
    }

    var shareEl = $('rotBtcShare');
    if (shareEl) shareEl.textContent = r.btcShare === null ? '—' : r.btcShare.toFixed(2) + '%';

    var deltaEl = $('rotShareDelta');
    if (deltaEl) {
      if (r.shareDelta === null) {
        deltaEl.textContent = '—（等待下一次刷新）';
        deltaEl.className = 'kv-val';
      } else {
        deltaEl.textContent = (r.shareDelta > 0 ? '+' : '') + r.shareDelta.toFixed(2) + ' 个百分点';
        deltaEl.className = 'kv-val ' + (r.shareDelta > 0 ? 'val-up' : r.shareDelta < 0 ? 'val-down' : '');
      }
    }

    var scopeEl = $('rotAltScope');
    if (scopeEl) scopeEl.textContent = r.altScope;

    var foot = $('rotationFoot');
    if (foot) {
      var base = S.baseline;
      foot.textContent = '小币组取成交额排名靠中段的币种，避开头部大币，避免大饼自身把结论带偏。' +
        (base && base.available ? '环比基线：' + base.reason + '。' : '环比状态：' + (base ? base.reason : '未知') + '。');
    }
  }

  /* ---- 4.6 资金出逃 ---- */
  function renderOutflow() {
    var a = S.analysis;
    var list = $('outflowList');
    var cnt = $('outflowCount');
    if (!a || !list) return;

    /* 顶部数字显示合格币种的总数；列表最多画 20 个，超出会明确说明，
       避免出现「数字是 13、列表只有 12」这种看起来像 bug 的不一致 */
    var MAX_SHOW = 20;
    var total = a.outflow.length;
    var shown = a.outflow.slice(0, MAX_SHOW);

    if (cnt) cnt.textContent = String(total);
    list.innerHTML = '';

    if (!total) {
      list.appendChild(el('li', 'outflow-empty', '当前没有同时满足三条条件的币种，市场暂未出现集中的资金出逃迹象。'));
    } else {
      shown.forEach(function (o, i) {
        var li = el('li', 'outflow-item');
        li.appendChild(el('span', 'outflow-rank', '#' + (i + 1)));
        var main = el('div', 'outflow-main');
        main.appendChild(el('div', 'outflow-coin',
          escapeHtml(o.symbol) + '<small>' + escapeHtml(o.sectorName) + '</small>'));
        main.appendChild(el('div', 'outflow-meta',
          '跌幅 ' + Fmt.fmtPct(o.changePct) +
          '　成交额 ' + Fmt.fmtMoney(o.quoteVolume) +
          '　换手 ' + Fmt.fmtTurnover(o.turnover) +
          '　' + (o.oiChangePct === null
            ? '持仓变化待测'
            : '持仓 ' + Fmt.fmtPct(o.oiChangePct))));
        li.appendChild(main);
        var scoreWrap = el('div', 'outflow-score', o.score.toFixed(0) + '<small>出逃强度</small>');
        li.appendChild(scoreWrap);
        li.setAttribute('title', o.reasons.join('\n'));
        li.addEventListener('click', function () { openDrawer(o.symbol); });
        list.appendChild(li);
      });

      if (total > shown.length) {
        list.appendChild(el('li', 'outflow-empty',
          '为保证页面流畅，列表最多显示 ' + MAX_SHOW + ' 个，当前共有 ' + total + ' 个符合条件。'));
      }
    }

    var foot = $('outflowFoot');
    if (foot) {
      var base = S.baseline;
      foot.textContent = '判定条件：跌幅 ≤ −4.5%、成交额排名前 40%、换手强度排名前 40%（三条同时满足）。' +
        (base && base.available
          ? '持仓量下降为增强条件，当前已可用。'
          : '持仓量下降为增强条件，' + (base ? base.reason : '') + '。');
    }
  }

  /* ---- 4.7 赛道冷热排行 ---- */
  function renderSectorRanks() {
    var a = S.analysis;
    if (!a) return;

    fillSectorList($('sectorHotList'), a.hotSectors, true);
    fillSectorList($('sectorColdList'), a.coldSectors, false);
  }

  function fillSectorList(node, sectors, isHot) {
    if (!node) return;
    node.innerHTML = '';
    if (!sectors || !sectors.length) {
      /* 赛道内币种太少时不参与排名，避免用一两个币就下结论 */
      var minCoins = (S.analysis && S.analysis.rules) ? S.analysis.rules.sectorMinCoins : 3;
      node.appendChild(el('li', 'sector-rank-empty',
        '赛道内币种少于 ' + minCoins + ' 个，样本不足，暂不参与排名'));
      return;
    }
    sectors.forEach(function (s) {
      var li = el('li', 'sector-rank-item');
      li.appendChild(el('span', 'sector-rank-name', escapeHtml(s.name)));
      var v = el('span', 'sector-rank-val', (s.weightedHeat === null ? '—' : s.weightedHeat.toFixed(1)));
      v.style.color = window.HeatEngine.heatColor(s.weightedHeat).bg;
      li.appendChild(v);
      li.appendChild(el('span', 'sector-rank-cnt', s.count + ' 币'));
      li.setAttribute('title', s.name + '　成交额加权热度 ' +
        (s.weightedHeat === null ? '—' : s.weightedHeat.toFixed(1)) +
        '　平均涨跌 ' + Fmt.fmtPct(s.avgChange) +
        '　成交额 ' + Fmt.fmtMoney(s.quoteVolume));
      node.appendChild(li);
    });
  }

  /* ---- 4.8 赛道热度矩阵 ---- */
  function renderMatrix() {
    var a = S.analysis;
    var host = $('sectorMatrix');
    if (!a || !host) return;

    host.innerHTML = '';
    var sectors = a.sectors.slice().sort(function (x, y) {
      return num(y.weightedHeat) - num(x.weightedHeat);
    });

    sectors.forEach(function (s) {
      var group = el('div', 'matrix-group');

      var head = el('div', 'matrix-group-head');
      head.appendChild(el('span', 'matrix-group-name', escapeHtml(s.name)));
      head.appendChild(el('span', 'matrix-group-stat',
        (s.weightedHeat === null ? '—' : s.weightedHeat.toFixed(1)) + ' 分' +
        ' · ' + s.count + ' 币 · ' + Fmt.fmtMoney(s.quoteVolume)));
      var bar = el('span', 'matrix-group-bar');
      var barIn = el('span');
      barIn.style.width = Math.max(2, Math.min(100, s.weightedHeat === null ? 0 : s.weightedHeat)) + '%';
      barIn.style.background = s.color;
      bar.appendChild(barIn);
      head.appendChild(bar);
      group.appendChild(head);

      var cells = el('div', 'matrix-cells');
      s.coins.slice(0, MATRIX_MAX_PER_SECTOR).forEach(function (c) {
        var hs = num(c.heatScore);
        var col = window.HeatEngine.heatColor(hs);
        var cell = el('div', 'matrix-cell' + (col.lightText ? ' is-light' : ''));
        cell.style.background = col.bg;
        cell.appendChild(el('span', 'matrix-cell-sym', escapeHtml(c.symbol)));
        cell.appendChild(el('span', 'matrix-cell-score', (hs === -Infinity ? '—' : hs.toFixed(0))));
        cell.setAttribute('title',
          c.symbol + '　' + c.sectorName + '\n' +
          '热度分数：' + (hs === -Infinity ? '—' : hs.toFixed(1)) + '\n' +
          '24h 涨跌：' + Fmt.fmtPct(c.changePct) + '\n' +
          '24h 成交额：' + Fmt.fmtMoney(c.quoteVolume) + '\n' +
          '换手强度：' + Fmt.fmtTurnover(c.turnover) + '\n' +
          '波动幅度：' + (c.volPct === null ? '该数据源不提供' : Fmt.fmtPct(c.volPct)));
        cell.addEventListener('click', function () { openDrawer(c.symbol); });
        cells.appendChild(cell);
      });

      if (s.coins.length > MATRIX_MAX_PER_SECTOR) {
        cells.appendChild(el('div', 'matrix-group-stat',
          '（本赛道另有 ' + (s.coins.length - MATRIX_MAX_PER_SECTOR) + ' 个币种未在矩阵中展示）'));
      }

      group.appendChild(cells);
      host.appendChild(group);
    });

    var foot = $('sectorMatrixFoot');
    if (foot) {
      foot.textContent = '赛道分类来自项目内置映射表，未收录的币种归入「其他」，' +
        '目前「其他」赛道占全市场成交额的 ' + a.otherShare.toFixed(2) + '%。' +
        '每个赛道最多展示热度最高的 ' + MATRIX_MAX_PER_SECTOR + ' 个币种。';
    }
  }

  /* =======================================================================
     五、币种详情抽屉
     ======================================================================= */

  function openDrawer(symbol) {
    var a = S.analysis;
    if (!a) return;
    var coin = null;
    for (var i = 0; i < a.coins.length; i++) {
      if (a.coins[i].symbol === symbol) { coin = a.coins[i]; break; }
    }
    if (!coin) return;

    S.selected = symbol;
    if (S.bubble) S.bubble.setSelected(symbol);
    highlightRankRow(symbol);

    var drawer = $('drawer');
    var mask = $('drawerMask');
    if (!drawer || !mask) return;

    drawer.hidden = false;
    mask.hidden = false;

    $('drawerTitle').textContent = symbol;
    $('drawerSub').textContent = coin.sectorName + '　·　' +
      (S.platform === 'cex' ? 'USDT 永续合约' : '链上永续合约') +
      '　·　热度分数 ' + (num(coin.heatScore) === -Infinity ? '—' : num(coin.heatScore).toFixed(1));

    var body = $('drawerBody');
    body.innerHTML = '';

    /* --- 关键数字 --- */
    var grid = el('div', 'dw-grid');
    grid.appendChild(dwCard('最新价', Fmt.fmtPrice(coin.last), '标记价 ' + Fmt.fmtPrice(coin.markPrice)));
    grid.appendChild(dwCard('24 小时涨跌', Fmt.fmtPct(coin.changePct), null, coin.changePct));
    grid.appendChild(dwCard('24 小时成交额', Fmt.fmtMoney(coin.quoteVolume), '按计价币折算'));
    grid.appendChild(dwCard('持仓量', coin.oiUsd === null ? '—' : Fmt.fmtMoney(coin.oiUsd), '按标记价折算美元'));
    grid.appendChild(dwCard('换手强度', Fmt.fmtTurnover(coin.turnover), '成交额 ÷ 持仓量'));
    grid.appendChild(dwCard('波动幅度', coin.volPct === null ? '—' : Fmt.fmtPct(coin.volPct),
      coin.volPct === null ? '该数据源不提供' : '（24h 最高 − 最低）÷ 最低'));
    grid.appendChild(dwCard('年化资金费率', coin.fundingAnnual === null ? '—' : Fmt.fmtPct(coin.fundingAnnual),
      '原始周期 ' + (coin.fundingCycle || '—')));
    grid.appendChild(dwCard('会话内持仓变化',
      coin.oiChangePct === null ? '—' : Fmt.fmtPct(coin.oiChangePct),
      coin.oiChangePct === null ? '需要下一次刷新' : '相对上一次快照'));
    body.appendChild(section('关键数字', grid));

    /* --- 热度分数构成 --- */
    var bars = el('div');
    var weights = window.HeatEngine.HEAT_WEIGHTS;
    var rankDefs = [
      { name: '涨跌幅排名', rank: coin.ranks.change, w: weights.change },
      { name: '成交额排名', rank: coin.ranks.volume, w: weights.volume },
      { name: '换手强度排名', rank: coin.ranks.turnover, w: weights.turnover },
      { name: '波动幅度排名', rank: coin.ranks.volatility, w: weights.volatility }
    ];
    rankDefs.forEach(function (d) {
      var row = el('div', 'dw-bar-row');
      row.appendChild(el('span', 'dw-bar-name', d.name));
      var track = el('span', 'dw-bar-track');
      var fill = el('span');
      var pct = (d.rank === null || d.rank === undefined) ? 0 : d.rank * 100;
      fill.style.width = Math.max(1, pct) + '%';
      if (d.rank === null || d.rank === undefined) fill.style.background = '#cbd5e1';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'dw-bar-val',
        (d.rank === null || d.rank === undefined) ? '不提供' : (pct).toFixed(0) + '%'));
      row.setAttribute('title', '该指标在全市场中的百分位排名，权重 ' + Math.round(d.w * 100) + '%');
      bars.appendChild(row);
    });
    bars.appendChild(el('p', 'dw-mini-note',
      '热度分数 = 四项百分位排名按权重加总（涨跌幅 30%、成交额 30%、换手强度 20%、波动幅度 20%）。' +
      '成交额先取对数再排名，避免大币与小币量级差距把分布压扁。'));
    body.appendChild(section('热度分数构成', bars));

    /* --- 近 48 根 1 小时 K 线 --- */
    var miniWrap = el('div', 'dw-mini-wrap');
    var miniCanvas = document.createElement('canvas');
    miniWrap.appendChild(miniCanvas);
    var miniNote = el('p', 'dw-mini-note', '正在加载 K 线数据…');
    body.appendChild(section('近 48 根 1 小时 K 线', miniWrap, miniNote));

    window.ApiClient.loadCandles(S.platform, coin.raw, '1h', 48)
      .then(function (res) {
        var ok = window.HeatChart.drawMini(miniCanvas, res.candles);
        var via = window.ApiClient.channelText(res.via);
        if (ok) {
          miniNote.textContent = '共 ' + res.candles.length + ' 根 1 小时 K 线（红涨绿跌），数据经' + via + '获取。';
        } else if (res.candles.length) {
          /* 数据取到了，但当前浏览器环境画不出来（例如禁用了画布）。
             这种时候要说清是「画不了」而不是「没数据」，避免误导。 */
          miniWrap.style.display = 'none';
          miniNote.textContent = '已取到 ' + res.candles.length +
            ' 根 K 线数据，但当前浏览器环境无法绘制图表，已隐藏该图。其余指标不受影响。';
        } else {
          miniNote.textContent = '该币种没有返回 K 线数据。';
        }
      })
      .catch(function (err) {
        miniWrap.style.display = 'none';
        miniNote.textContent = 'K 线加载失败：' + (err && err.message ? err.message : '未知原因') +
          '。其余指标不受影响。';
      });

    /* --- 原始字段 --- */
    var kv = el('div');
    kv.appendChild(kvRow('币种代号', coin.symbol));
    kv.appendChild(kvRow('合约代码', coin.raw));
    kv.appendChild(kvRow('所属赛道', coin.sectorName));
    kv.appendChild(kvRow('数据源类型', S.snapshot ? S.snapshot.marketLabel : '—'));
    kv.appendChild(kvRow('取数通道', window.ApiClient.channelText(S.snapshot ? S.snapshot.via : null)));
    kv.appendChild(kvRow('本条数据来自快照时间', Fmt.fmtTime(S.lastFetchAt)));
    kv.appendChild(kvRow('资金费率结算周期', coin.fundingCycle || '—'));
    body.appendChild(section('数据说明', kv));
  }

  function section(title, content, extra) {
    var sec = el('div', 'dw-section');
    sec.appendChild(el('h3', 'dw-section-title', title));
    sec.appendChild(content);
    if (extra) sec.appendChild(extra);
    return sec;
  }

  function dwCard(label, value, note, dirValue) {
    var card = el('div', 'dw-card');
    card.appendChild(el('div', 'dw-card-label', label));
    var v = el('div', 'dw-card-value', escapeHtml(value));
    if (typeof dirValue === 'number' && isFinite(dirValue)) {
      if (dirValue > 0.005) v.style.color = '#e03131';
      else if (dirValue < -0.005) v.style.color = '#0ca678';
    }
    card.appendChild(v);
    if (note) card.appendChild(el('div', 'dw-card-note', escapeHtml(note)));
    return card;
  }

  function kvRow(key, value) {
    var row = el('div', 'dw-kv');
    row.appendChild(el('span', 'dw-kv-key', escapeHtml(key)));
    row.appendChild(el('span', 'dw-kv-val', escapeHtml(value)));
    return row;
  }

  function highlightRankRow(symbol) {
    var body = $('rankBody');
    if (!body) return;
    var rows = body.querySelectorAll('tr[data-symbol]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('is-active', rows[i].getAttribute('data-symbol') === symbol);
    }
  }

  function closeDrawer() {
    var drawer = $('drawer');
    var mask = $('drawerMask');
    if (drawer) drawer.hidden = true;
    if (mask) mask.hidden = true;
    S.selected = null;
    if (S.bubble) S.bubble.setSelected(null);
    highlightRankRow('');
  }

  /* =======================================================================
     六、事件绑定
     ======================================================================= */

  function bindEvents() {
    var btn = $('refreshBtn');
    if (btn) btn.addEventListener('click', function () { refresh(); });

    var auto = $('autoRefreshChk');
    if (auto) {
      auto.addEventListener('change', function () {
        if (auto.checked) startAutoRefresh();
        else stopAutoRefresh();
      });
    }

    var tabs = $('rankTabs');
    if (tabs) {
      tabs.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.getAttribute) return;
        var mode = t.getAttribute('data-rank');
        if (!mode) return;
        S.rankMode = mode;
        var all = tabs.querySelectorAll('.seg-btn');
        for (var i = 0; i < all.length; i++) all[i].classList.toggle('is-on', all[i] === t);
        renderRank();
      });
    }

    var search = $('rankSearch');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          S.search = search.value || '';
          renderRank();
        }, 160);
      });
    }

    var filters = document.querySelectorAll('[data-bubble-filter]');
    for (var i = 0; i < filters.length; i++) {
      filters[i].addEventListener('click', function (ev) {
        var t = ev.currentTarget;
        S.bubbleFilter = t.getAttribute('data-bubble-filter');
        for (var k = 0; k < filters.length; k++) filters[k].classList.toggle('is-on', filters[k] === t);
        renderBubble();
      });
    }

    var close = $('drawerClose');
    if (close) close.addEventListener('click', closeDrawer);
    var mask = $('drawerMask');
    if (mask) mask.addEventListener('click', closeDrawer);

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeDrawer();
    });

    /* 页面切到后台时暂停自动刷新，回到前台且数据已过期时立即补一次 */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        var auto = $('autoRefreshChk');
        if (auto && auto.checked && S.lastFetchAt && (Date.now() - S.lastFetchAt) > AUTO_REFRESH_MS * 1.5) {
          refresh();
        }
      }
    });
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    S.timer = setInterval(function () {
      if (document.hidden) return;      /* 页面不可见时不空跑请求 */
      refresh();
    }, AUTO_REFRESH_MS);
  }

  function stopAutoRefresh() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
  }

  /* ---- 启动 ---- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
