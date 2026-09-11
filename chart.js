/* =========================================================================
   chart.js —— 自绘图表
   -------------------------------------------------------------------------
   本项目不使用任何第三方图表库，全部用原生 Canvas 手绘，原因有两个：
     ① 不依赖外部 CDN，避免加载失败导致页面空白；
     ② 可以把「热度」这个主题画成更贴合的形态。
   包含两块：
     · 全市场热度气泡图（主视觉）
     · 币种详情里的近 48 根 K 线迷你图
   ========================================================================= */

window.HeatChart = (function () {
  'use strict';

  var Fmt = window.MarketSnapshot;

  /* 颜色 */
  var COL_UP = '#e03131';        /* 上涨：红 */
  var COL_DOWN = '#0ca678';      /* 下跌：绿 */
  var COL_FLAT = '#64748b';
  var COL_GRID = 'rgba(15,23,42,.10)';
  var COL_AXIS = 'rgba(15,23,42,.28)';
  var COL_TEXT = '#94a3b8';
  var COL_ZERO = 'rgba(15,23,42,.30)';

  /* 气泡最大半径（像素） */
  var MAX_R = 17;
  var MIN_R = 2.6;

  function colorOf(changePct) {
    if (typeof changePct !== 'number' || !isFinite(changePct)) return COL_FLAT;
    if (changePct > 0.1) return COL_UP;
    if (changePct < -0.1) return COL_DOWN;
    return COL_FLAT;
  }

  function withAlpha(hex, alpha) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /* 取分位数，用于自动确定坐标范围（避免个别极端值把图压扁） */
  function percentile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q;
    var base = Math.floor(pos);
    var rest = pos - base;
    return sorted[base + 1] !== undefined
      ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
      : sorted[base];
  }

  /* =======================================================================
     一、全市场热度气泡图
     ======================================================================= */

  /**
   * @param {HTMLCanvasElement} canvas
   * @returns {Object|null} 图表控制对象；拿不到绘图上下文时返回 null
   */
  function createBubble(canvas) {
    if (!canvas) return null;
    var ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return null;

    var state = {
      points: [],        /* 每个气泡的屏幕坐标与数据，用于鼠标命中判断 */
      sizeBase: 1,       /* 气泡大小的基准成交额 */
      visible: false,
      selected: null,
      hover: -1
    };

    var tooltipEl = null;   /* 由外部通过 setTooltip 注入 */
    var onSelect = null;
    var plot = { x0: 0, y0: 0, x1: 0, y1: 0 };

    /* ---- 尺寸与高分屏适配 ---- */
    function resizeCanvas() {
      var rect = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      var w = Math.max(120, Math.floor(rect.width));
      var h = Math.max(120, Math.floor(rect.height));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: w, h: h };
    }

    /* ---- 绘制主流程 ---- */
    function draw() {
      var size = resizeCanvas();
      var W = size.w, H = size.h;

      ctx.clearRect(0, 0, W, H);

      var pad = { left: 58, right: 18, top: 20, bottom: 38 };
      plot = {
        x0: pad.left,
        y0: pad.top,
        x1: W - pad.right,
        y1: H - pad.bottom
      };

      var pts = state.points;
      if (!pts.length) return;

      /* --- 确定坐标范围 --- */
      var xs = pts.map(function (p) { return p.changePct; }).sort(function (a, b) { return a - b; });
      var ys = pts.map(function (p) { return p.logTurnover; }).sort(function (a, b) { return a - b; });

      var xLo = percentile(xs, 0.01), xHi = percentile(xs, 0.99);
      var yLo = percentile(ys, 0.01), yHi = percentile(ys, 0.99);

      /* 至少覆盖 ±3% 的涨跌区间，避免行情平静时图形被过度放大 */
      var xSpan = Math.max(3, Math.max(Math.abs(xLo || 0), Math.abs(xHi || 0)));
      xLo = -xSpan; xHi = xSpan;
      if (yHi - yLo < 0.35) { var mid = (yHi + yLo) / 2; yLo = mid - 0.2; yHi = mid + 0.2; }
      var yPad = (yHi - yLo) * 0.06;
      yLo -= yPad; yHi += yPad;

      function sx(v) { return plot.x0 + ((v - xLo) / (xHi - xLo)) * (plot.x1 - plot.x0); }
      function sy(v) { return plot.y1 - ((v - yLo) / (yHi - yLo)) * (plot.y1 - plot.y0); }

      /* --- 背景分区：右上为大涨大换手，左下为大跌低换手 --- */
      ctx.save();
      var g1 = ctx.createLinearGradient(plot.x0, plot.y1, plot.x1, plot.y0);
      g1.addColorStop(0, 'rgba(12,166,120,.055)');
      g1.addColorStop(0.5, 'rgba(255,255,255,0)');
      g1.addColorStop(1, 'rgba(224,49,49,.055)');
      ctx.fillStyle = g1;
      ctx.fillRect(plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);
      ctx.restore();

      /* --- 网格与刻度 --- */
      ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
      ctx.textBaseline = 'middle';

      /* 纵向网格（按涨跌幅刻度） */
      var xTicks = makeTicks(xLo, xHi, 5);
      ctx.strokeStyle = COL_GRID;
      ctx.lineWidth = 1;
      xTicks.forEach(function (t) {
        var x = sx(t);
        ctx.beginPath();
        ctx.moveTo(x, plot.y0);
        ctx.lineTo(x, plot.y1);
        ctx.stroke();
        ctx.fillStyle = COL_TEXT;
        ctx.textAlign = 'center';
        ctx.fillText(Fmt.fmtPct(t, Math.abs(t) >= 10 ? 0 : 1), x, plot.y1 + 14);
      });

      /* 横向网格（按换手强度刻度，纵轴是对数刻度） */
      var yTicks = makeTicks(yLo, yHi, 4);
      yTicks.forEach(function (t) {
        var y = sy(t);
        ctx.beginPath();
        ctx.moveTo(plot.x0, y);
        ctx.lineTo(plot.x1, y);
        ctx.stroke();
        ctx.fillStyle = COL_TEXT;
        ctx.textAlign = 'right';
        var val = Math.pow(10, t);
        ctx.fillText(Fmt.fmtTurnover(val), plot.x0 - 8, y);
      });

      /* --- 零轴（涨跌幅 0）加粗 --- */
      ctx.save();
      ctx.strokeStyle = COL_ZERO;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      var zx = sx(0);
      ctx.beginPath();
      ctx.moveTo(zx, plot.y0);
      ctx.lineTo(zx, plot.y1);
      ctx.stroke();
      ctx.restore();

      /* --- 轴标题 --- */
      ctx.fillStyle = COL_TEXT;
      ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('换手强度（对数刻度）', plot.x0 - 6, plot.y0 - 16);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText('24 小时涨跌幅', plot.x1, plot.y1 + 30);

      /* --- 气泡：成交额小的先画，大的后画（避免被盖住） --- */
      var order = pts.slice().sort(function (a, b) { return a.quoteVolume - b.quoteVolume; });
      var base = state.sizeBase > 0 ? state.sizeBase : 1;

      order.forEach(function (p) {
        /* 半径按成交额的平方根缩放，视觉上更接近「面积代表大小」 */
        var ratio = Math.sqrt(Math.max(0, p.quoteVolume) / base);
        var r = MIN_R + (MAX_R - MIN_R) * Math.min(1, ratio);

        var x = sx(p.changePct);
        var y = sy(p.logTurnover);
        var clampedX = Math.max(plot.x0, Math.min(plot.x1, x));
        var clampedY = Math.max(plot.y0, Math.min(plot.y1, y));

        p._x = clampedX;
        p._y = clampedY;
        p._r = r;

        var col = colorOf(p.changePct);

        ctx.beginPath();
        ctx.arc(clampedX, clampedY, r, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(col, p.outflow ? 0.42 : 0.26);
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = withAlpha(col, 0.95);
        ctx.stroke();

        /* 出逃嫌疑的币加一圈虚线环 */
        if (p.outflow) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(clampedX, clampedY, r + 3.4, 0, Math.PI * 2);
          ctx.setLineDash([2.5, 2.5]);
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = 'rgba(224,49,49,.9)';
          ctx.stroke();
          ctx.restore();
        }

        /* 热度最高的若干币直接标出代号，方便一眼看懂 */
        if (p.labeled && r >= 6) {
          ctx.fillStyle = 'rgba(15,23,42,.72)';
          ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.symbol, clampedX, clampedY + r + 8);
        }
      });

      /* --- 鼠标悬停高亮 --- */
      if (state.hover >= 0 && state.points[state.hover]) {
        var hp = state.points[state.hover];
        if (hp._x !== undefined) {
          ctx.beginPath();
          ctx.arc(hp._x, hp._y, hp._r + 3, 0, Math.PI * 2);
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#4f46e5';
          ctx.stroke();
        }
      }

      /* --- 选中的币种加十字标记 --- */
      if (state.selected) {
        var sel = null;
        for (var i = 0; i < state.points.length; i++) {
          if (state.points[i].symbol === state.selected) { sel = state.points[i]; break; }
        }
        if (sel && sel._x !== undefined) {
          ctx.save();
          ctx.strokeStyle = '#4f46e5';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(plot.x0, sel._y); ctx.lineTo(plot.x1, sel._y);
          ctx.moveTo(sel._x, plot.y0); ctx.lineTo(sel._x, plot.y1);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    /* 生成好看的刻度值 */
    function makeTicks(lo, hi, count) {
      var span = hi - lo;
      if (!isFinite(span) || span <= 0) return [lo];
      var raw = span / count;
      var mag = Math.pow(10, Math.floor(Math.log10(raw)));
      var norm = raw / mag;
      var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
      var start = Math.ceil(lo / step) * step;
      var out = [];
      for (var v = start; v <= hi + step * 0.001; v += step) out.push(v);
      return out;
    }

    /* ---- 命中检测 ---- */
    function hitTest(px, py) {
      var best = -1, bestDist = Infinity;
      for (var i = 0; i < state.points.length; i++) {
        var p = state.points[i];
        if (p._x === undefined) continue;
        var dx = px - p._x, dy = py - p._y;
        var d = Math.sqrt(dx * dx + dy * dy);
        var limit = Math.max(9, p._r + 4);
        if (d <= limit && d < bestDist) { bestDist = d; best = i; }
      }
      return best;
    }

    function localPos(ev) {
      var rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    /* ---- 事件 ---- */
    function handleMove(ev) {
      var pos = localPos(ev);
      var idx = hitTest(pos.x, pos.y);
      if (idx !== state.hover) {
        state.hover = idx;
        draw();
      }
      if (tooltipEl) {
        if (idx >= 0) {
          var p = state.points[idx];
          tooltipEl.innerHTML = tooltipHtml(p);
          tooltipEl.hidden = false;
          var tw = tooltipEl.offsetWidth || 190;
          var th = tooltipEl.offsetHeight || 90;
          var left = pos.x + 16;
          if (left + tw > canvas.clientWidth) left = pos.x - tw - 16;
          var top = pos.y + 14;
          if (top + th > canvas.clientHeight) top = pos.y - th - 14;
          tooltipEl.style.left = Math.max(4, left) + 'px';
          tooltipEl.style.top = Math.max(4, top) + 'px';
        } else {
          tooltipEl.hidden = true;
        }
      }
    }

    function handleLeave() {
      if (state.hover !== -1) { state.hover = -1; draw(); }
      if (tooltipEl) tooltipEl.hidden = true;
    }

    function handleClick(ev) {
      var pos = localPos(ev);
      var idx = hitTest(pos.x, pos.y);
      if (idx >= 0 && typeof onSelect === 'function') {
        onSelect(state.points[idx].symbol);
      }
    }

    function tooltipHtml(p) {
      var col = colorOf(p.changePct);
      var cls = p.changePct > 0.1 ? '#ff8b8b' : (p.changePct < -0.1 ? '#6ee7b7' : '#cbd5e1');
      return '' +
        '<div style="font-weight:700;font-size:12.5px;margin-bottom:3px">' + p.symbol +
        '　<span style="font-weight:400;opacity:.7;font-size:11px">' + p.sectorName + '</span></div>' +
        '<div>24h 涨跌：<b style="color:' + cls + '">' + Fmt.fmtPct(p.changePct) + '</b></div>' +
        '<div>24h 成交额：<b>' + Fmt.fmtMoney(p.quoteVolume) + '</b></div>' +
        '<div>换手强度：<b>' + Fmt.fmtTurnover(p.turnover) + '</b></div>' +
        '<div>热度分数：<b>' + (typeof p.heatScore === 'number' ? p.heatScore.toFixed(1) : '—') + '</b>' +
        (p.outflow ? '　<span style="color:#ffb4b4">出逃嫌疑</span>' : '') + '</div>';
    }

    /* ---- 对外接口 ---- */
    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseleave', handleLeave);
    canvas.addEventListener('click', handleClick);

    var ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () { draw(); });
      ro.observe(canvas);
    } else {
      window.addEventListener('resize', draw);
    }

    return {
      setTooltip: function (el) { tooltipEl = el; },
      onSelect: function (fn) { onSelect = fn; },
      /**
       * @param {Array} items 要画的币种（已按筛选条件过滤好）
       * @param {Number} sizeBase 全市场最大成交额，用于统一气泡大小基准
       * @param {String} selectedSymbol 当前选中的币种
       */
      setData: function (items, sizeBase, selectedSymbol) {
        state.points = (items || []).map(function (c) {
          return {
            symbol: c.symbol,
            sectorName: c.sectorName,
            changePct: typeof c.changePct === 'number' ? c.changePct : 0,
            quoteVolume: typeof c.quoteVolume === 'number' ? c.quoteVolume : 0,
            turnover: c.turnover,
            logTurnover: Math.log10((c.turnover && c.turnover > 0) ? c.turnover : 0.01),
            heatScore: c.heatScore,
            outflow: !!c.isOutflow,
            labeled: !!c.isLabeled
          };
        });
        state.hover = -1;
        state.selected = selectedSymbol || null;
        state.visible = state.points.length > 0;
        state.sizeBase = sizeBase && sizeBase > 0 ? sizeBase : 1;
        if (tooltipEl) tooltipEl.hidden = true;
        draw();
      },
      setSelected: function (symbol) {
        state.selected = symbol || null;
        draw();
      },
      redraw: draw,
      destroy: function () {
        canvas.removeEventListener('mousemove', handleMove);
        canvas.removeEventListener('mouseleave', handleLeave);
        canvas.removeEventListener('click', handleClick);
        if (ro) ro.disconnect();
        else window.removeEventListener('resize', draw);
      }
    };
  }

  /* =======================================================================
     二、币种详情里的迷你 K 线图
     ======================================================================= */

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Array} candles [{ t, o, h, l, c, v }]
   * @returns {Boolean} 是否绘制成功
   */
  function drawMini(canvas, candles) {
    if (!canvas) return false;
    var ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return false;

    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var W = Math.max(80, Math.floor(rect.width));
    var H = Math.max(60, Math.floor(rect.height));
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var list = (candles || []).filter(function (k) {
      return k && isFinite(k.h) && isFinite(k.l) && isFinite(k.c);
    });
    if (!list.length) return false;

    var pad = { left: 6, right: 46, top: 10, bottom: 22 };
    var volH = 22;                                  /* 底部成交量区高度 */
    var priceTop = pad.top;
    var priceBottom = H - pad.bottom - volH - 6;

    var hi = -Infinity, lo = Infinity, maxV = 0;
    list.forEach(function (k) {
      if (k.h > hi) hi = k.h;
      if (k.l < lo) lo = k.l;
      if (k.v > maxV) maxV = k.v;
    });
    if (!isFinite(hi) || !isFinite(lo) || hi === lo) { hi = lo + 1; }
    /* 上下各留一点空间 */
    var padPrice = (hi - lo) * 0.08;
    hi += padPrice; lo -= padPrice;

    var step = (W - pad.left - pad.right) / list.length;
    var bodyW = Math.max(1.6, step * 0.62);

    function py(v) { return priceBottom - ((v - lo) / (hi - lo)) * (priceBottom - priceTop); }

    /* 三条横向参考线 */
    ctx.strokeStyle = COL_GRID;
    ctx.lineWidth = 1;
    for (var i = 0; i <= 3; i++) {
      var y = priceTop + ((priceBottom - priceTop) * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
    }

    /* K 线本体 */
    list.forEach(function (k, idx) {
      var cx = pad.left + step * idx + step / 2;
      var up = k.c >= k.o;
      var col = up ? COL_UP : COL_DOWN;

      /* 影线 */
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, py(k.h));
      ctx.lineTo(cx, py(k.l));
      ctx.stroke();

      /* 实体 */
      var yO = py(k.o), yC = py(k.c);
      var top = Math.min(yO, yC);
      var hgt = Math.max(1, Math.abs(yC - yO));
      ctx.fillStyle = up ? withAlpha(col, 0.85) : col;
      ctx.fillRect(cx - bodyW / 2, top, bodyW, hgt);

      /* 成交量柱 */
      if (maxV > 0) {
        var vh = (k.v / maxV) * volH;
        ctx.fillStyle = withAlpha(col, 0.35);
        ctx.fillRect(cx - bodyW / 2, H - pad.bottom - vh, bodyW, vh);
      }
    });

    /* 最新价标签 */
    var lastC = list[list.length - 1].c;
    var lastY = py(lastC);
    var upLast = lastC >= list[0].c;
    ctx.save();
    ctx.strokeStyle = upLast ? COL_UP : COL_DOWN;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, lastY);
    ctx.lineTo(W - pad.right, lastY);
    ctx.stroke();
    ctx.restore();

    var label = Fmt.fmtPrice(lastC);
    ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    var tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = upLast ? COL_UP : COL_DOWN;
    ctx.beginPath();
    var bx = W - pad.right + 2, by = lastY - 8, bh = 16, br = 3;
    ctx.moveTo(bx + br, by);
    ctx.lineTo(bx + tw - br, by);
    ctx.quadraticCurveTo(bx + tw, by, bx + tw, by + br);
    ctx.lineTo(bx + tw, by + bh - br);
    ctx.quadraticCurveTo(bx + tw, by + bh, bx + tw - br, by + bh);
    ctx.lineTo(bx + br, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - br);
    ctx.lineTo(bx, by + br);
    ctx.quadraticCurveTo(bx, by, bx + br, by);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + 5, by + bh / 2 + 0.5);

    return true;
  }

  return {
    createBubble: createBubble,
    drawMini: drawMini,
    colorOf: colorOf
  };
})();
