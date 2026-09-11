/* =========================================================================
   market-snapshot.js —— 把两个数据源返回的原始行情，转换成统一的内部结构
   -------------------------------------------------------------------------
   本项目会用到两个数据源的「全市场快照」：
     ① 综合平台（合约口径）：一次请求返回全部 USDT 永续合约
     ② 链上平台（永续口径）：一次请求返回全部链上永续市场
   两者的字段名和单位都不一样，所以在这一层统一换算成同一种结构，
   上层算法（heat-engine.js）就不用关心数据是从哪来的了。
   ========================================================================= */

window.MarketSnapshot = (function () {
  'use strict';

  /* 少于这个成交额的合约视为「长期无成交的僵尸合约」，不参与市场广度统计。
     页面上会如实标注这个筛选口径，不做隐藏处理。 */
  var MIN_QUOTE_VOLUME = 200000;

  /* 稳定币互兑对（例如 USDC/USDT）的涨跌没有分析意义，直接排除 */
  var STABLE_BASES = [
    'USDC', 'USDT', 'DAI', 'FDUSD', 'TUSD', 'BUSD', 'PYUSD', 'USDD',
    'USDE', 'USD1', 'USDP', 'GUSD', 'EURT', 'EUR', 'EURS'
  ];

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }

  /* 把 "BTC_USDT" 解析成 { base:'BTC', quote:'USDT' } */
  function parsePair(raw) {
    var s = String(raw || '').trim().toUpperCase();
    var i = s.indexOf('_');
    if (i < 0) return { base: s, quote: '' };
    return { base: s.slice(0, i), quote: s.slice(i + 1) };
  }

  function isStableBase(base) {
    return STABLE_BASES.indexOf(String(base || '').toUpperCase()) >= 0;
  }

  /* 安全除法：分母无效时返回 null，绝不返回 NaN 或 Infinity */
  function safeDiv(a, b) {
    if (a === null || b === null || !b) return null;
    var r = a / b;
    return isFinite(r) ? r : null;
  }

  /* =======================================================================
     数据源一：综合平台全市场永续合约 tickers
     每个元素形如：
     { contract, last, mark_price, index_price, change_percentage,
       high_24h, low_24h, volume_24h_quote, volume_24h_base,
       total_size, quanto_multiplier, funding_rate }
     全部字段都是字符串，需要逐个转数字。
     ======================================================================= */
  function fromCexTickers(list) {
    var out = [];
    if (!Array.isArray(list)) return out;

    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || !t.contract) continue;

      var pair = parsePair(t.contract);
      if (pair.quote !== 'USDT') continue;      // 只分析 USDT 计价合约
      if (isStableBase(pair.base)) continue;    // 排除稳定币互兑对

      var markPrice = toNum(t.mark_price);
      var last = toNum(t.last) || markPrice;
      var quoteVolume = toNum(t.volume_24h_quote);

      if (markPrice === null || markPrice <= 0) continue;
      if (quoteVolume === null || quoteVolume < MIN_QUOTE_VOLUME) continue;

      /* 持仓量美元值 = 张数 × 每张乘数 × 标记价 */
      var totalSize = toNum(t.total_size);
      var multiplier = toNum(t.quanto_multiplier);
      var oiUsd = null;
      if (totalSize !== null && multiplier !== null) {
        oiUsd = totalSize * multiplier * markPrice;
        if (!isFinite(oiUsd) || oiUsd <= 0) oiUsd = null;
      }

      /* 24 小时波动幅度 =（最高 − 最低）÷ 最低；两个价格都必须有效才算 */
      var high = toNum(t.high_24h);
      var low = toNum(t.low_24h);
      var volPct = null;
      if (high !== null && low !== null && low > 0 && high >= low) {
        volPct = ((high - low) / low) * 100;
      }

      /* 该源资金费率按 8 小时结算，换算成年化：× 3 次/天 × 365 天 */
      var fundingRate = toNum(t.funding_rate);
      var fundingAnnual = fundingRate === null ? null : fundingRate * 3 * 365 * 100;

      out.push({
        symbol: pair.base,
        raw: t.contract,          /* 保留原始合约代码，供后续按需请求 K 线时使用 */
        last: last,
        markPrice: markPrice,
        changePct: toNum(t.change_percentage),
        quoteVolume: quoteVolume,
        oiUsd: oiUsd,
        turnover: safeDiv(quoteVolume, oiUsd),
        volPct: volPct,
        fundingRate: fundingRate,
        fundingAnnual: fundingAnnual,
        fundingCycle: '8 小时'
      });
    }

    return out;
  }

  /* =======================================================================
     数据源二：链上平台全市场永续快照
     返回结构是长度 2 的数组：
       [0] = { universe: [ { name, isDelisted, maxLeverage }, ... ] }
       [1] = [ { markPx, oraclePx, midPx, prevDayPx, dayBaseVlm,
                 dayNtlVlm, openInterest, premium, funding }, ... ]
     两个数组按下标一一对应。
     注意：该源不提供 24 小时最高价与最低价，所以波动幅度只能留空。
     ======================================================================= */
  function fromOnchainSnapshot(raw) {
    var out = [];
    if (!Array.isArray(raw) || raw.length < 2) return out;

    var meta = raw[0] || {};
    var universe = Array.isArray(meta.universe) ? meta.universe : [];
    var ctxs = Array.isArray(raw[1]) ? raw[1] : [];

    for (var i = 0; i < universe.length; i++) {
      var u = universe[i];
      var c = ctxs[i];
      if (!u || !c) continue;
      if (u.isDelisted) continue;                       // 已下架的市场跳过
      if (isStableBase(u.name)) continue;

      var markPrice = toNum(c.markPx);
      if (markPrice === null || markPrice <= 0) continue;

      var quoteVolume = toNum(c.dayNtlVlm);
      if (quoteVolume === null || quoteVolume < MIN_QUOTE_VOLUME) continue;

      /* 该源不直接给涨跌幅，用「标记价 ÷ 前日参考价 − 1」自己算 */
      var prevDayPx = toNum(c.prevDayPx);
      var changePct = null;
      if (prevDayPx !== null && prevDayPx > 0) {
        changePct = ((markPrice - prevDayPx) / prevDayPx) * 100;
      }

      /* 持仓量美元值 = 持仓量币数 × 标记价 */
      var openInterest = toNum(c.openInterest);
      var oiUsd = openInterest === null ? null : openInterest * markPrice;
      if (oiUsd !== null && (!isFinite(oiUsd) || oiUsd <= 0)) oiUsd = null;

      /* 该源资金费率按 1 小时结算，换算成年化：× 24 小时 × 365 天 */
      var fundingRate = toNum(c.funding);
      var fundingAnnual = fundingRate === null ? null : fundingRate * 24 * 365 * 100;

      out.push({
        symbol: String(u.name || '').toUpperCase(),
        raw: u.name,
        last: markPrice,
        markPrice: markPrice,
        changePct: changePct,
        quoteVolume: quoteVolume,
        oiUsd: oiUsd,
        turnover: safeDiv(quoteVolume, oiUsd),
        volPct: null,               // 该数据源不提供 24 小时最高/最低价
        fundingRate: fundingRate,
        fundingAnnual: fundingAnnual,
        fundingCycle: '1 小时'
      });
    }

    return out;
  }

  /* =======================================================================
     数值格式化（页面各处共用）
     ======================================================================= */

  /* 美元金额：按中文习惯用「万 / 亿」 */
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e8) return '$' + (n / 1e8).toFixed(2) + ' 亿';
    if (abs >= 1e4) return '$' + (n / 1e4).toFixed(1) + ' 万';
    if (abs >= 1) return '$' + n.toFixed(0);
    return '$' + n.toFixed(2);
  }

  /* 价格：按数量级自动决定小数位 */
  function fmtPrice(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1000) return n.toFixed(2);
    if (abs >= 1) return n.toFixed(3);
    if (abs >= 0.01) return n.toFixed(5);
    if (abs >= 0.0001) return n.toFixed(7);
    return n.toFixed(9);
  }

  /* 百分比：带正负号 */
  function fmtPct(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var d = digits === undefined ? 2 : digits;
    return (n > 0 ? '+' : '') + n.toFixed(d) + '%';
  }

  /* 换手强度：倍数形式 */
  function fmtTurnover(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    if (n >= 100) return n.toFixed(0) + '×';
    return n.toFixed(2) + '×';
  }

  /* 时间：HH:MM:SS */
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    function pad(v) { return v < 10 ? '0' + v : String(v); }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* 相对时间：例如「12 秒前」 */
  function fmtAgo(ts) {
    if (!ts) return '—';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    return Math.round(s / 3600) + ' 小时前';
  }

  function fmtInt(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('zh-CN');
  }

  return {
    MIN_QUOTE_VOLUME: MIN_QUOTE_VOLUME,
    toNum: toNum,
    parsePair: parsePair,
    safeDiv: safeDiv,
    fromCexTickers: fromCexTickers,
    fromOnchainSnapshot: fromOnchainSnapshot,
    fmtMoney: fmtMoney,
    fmtPrice: fmtPrice,
    fmtPct: fmtPct,
    fmtTurnover: fmtTurnover,
    fmtTime: fmtTime,
    fmtAgo: fmtAgo,
    fmtInt: fmtInt
  };
})();
