/* =========================================================================
   history-tracker.js —— 会话内快照留存与环比
   -------------------------------------------------------------------------
   有些结论需要「两个时间点」才能算出来，例如：
     · 持仓量是在增加还是在减少
     · 大饼成交额占比是在上升还是在下降
   公开行情接口只给「当前值」，没有历史序列，所以本项目把上一次快照
   记在浏览器本地（localStorage），下次刷新时就能算出变化。
   数据只存在你自己的浏览器里，不会上传到任何服务器。
   ========================================================================= */

window.HistoryTracker = (function () {
  'use strict';

  var STORAGE_KEY = 'market-heat-agent:last-snapshot:v1';

  /* 超过这个时间就算「过期」，不再拿来做环比，避免用过夜数据误导判断 */
  var MAX_AGE_MS = 6 * 60 * 60 * 1000;

  /* 检查浏览器是否允许使用本地存储（隐私模式下可能被禁用） */
  function storageAvailable() {
    try {
      var k = '__mha_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  var canStore = storageAvailable();

  /**
   * 读取上一次快照
   * @returns {Object|null} { ts, btcShare, totalQuoteVolume, oiBySymbol, ageMs, expired }
   */
  function load() {
    if (!canStore) return null;
    var raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;

    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!data || !data.ts) return null;

    var ageMs = Date.now() - data.ts;
    return {
      ts: data.ts,
      btcShare: typeof data.btcShare === 'number' ? data.btcShare : null,
      totalQuoteVolume: typeof data.totalQuoteVolume === 'number' ? data.totalQuoteVolume : null,
      oiBySymbol: data.oiBySymbol || {},
      ageMs: ageMs,
      expired: ageMs > MAX_AGE_MS
    };
  }

  /**
   * 由上一步的分析结果生成可供下次使用的对比数据
   * @param {Object} analysis HeatEngine.analyze 的返回值
   * @returns {Object} { btcShare, oiBySymbol }
   */
  function buildCompare(analysis) {
    var oiBySymbol = Object.create(null);
    if (analysis && Array.isArray(analysis.coins)) {
      for (var i = 0; i < analysis.coins.length; i++) {
        var c = analysis.coins[i];
        if (typeof c.oiUsd === 'number' && isFinite(c.oiUsd) && c.oiUsd > 0) {
          oiBySymbol[c.symbol] = c.oiUsd;
        }
      }
    }
    return {
      btcShare: analysis && analysis.market ? analysis.market.btcShare : null,
      totalQuoteVolume: analysis && analysis.market ? analysis.market.totalQuoteVolume : null,
      oiBySymbol: oiBySymbol
    };
  }

  /**
   * 保存当前快照，供下一次刷新时做对比
   * @param {Object} analysis HeatEngine.analyze 的返回值
   * @returns {Boolean} 是否保存成功
   */
  function save(analysis) {
    if (!canStore) return false;
    var compare = buildCompare(analysis);
    var payload = {
      ts: Date.now(),
      btcShare: compare.btcShare,
      totalQuoteVolume: compare.totalQuoteVolume,
      oiBySymbol: compare.oiBySymbol
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (e) {
      /* 本地存储写满或被禁用时静默失败，页面照常工作，只是没有环比 */
      return false;
    }
  }

  /**
   * 取出可用于本轮分析的对比数据
   * 过期或不存在时返回 null，页面会显示「等待下一次刷新」
   */
  function getCompare() {
    var prev = load();
    if (!prev || prev.expired) return null;
    return {
      btcShare: prev.btcShare,
      oiBySymbol: prev.oiBySymbol
    };
  }

  /**
   * 说明当前有没有可用的基线，供页面显示提示文字
   */
  function baselineState() {
    if (!canStore) {
      return { available: false, reason: '浏览器禁用了本地存储，本次无法计算环比变化' };
    }
    var prev = load();
    if (!prev) {
      return { available: false, reason: '这是本次会话的第一次快照，环比变化需要下次刷新才有' };
    }
    if (prev.expired) {
      return { available: false, reason: '上一次快照已超过 6 小时，不再用于环比，请稍等下一次刷新' };
    }
    return {
      available: true,
      reason: '基线取自 ' + Math.round(prev.ageMs / 1000) + ' 秒前的快照',
      ts: prev.ts
    };
  }

  function clear() {
    if (!canStore) return;
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 忽略 */ }
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    canStore: canStore,
    load: load,
    save: save,
    getCompare: getCompare,
    buildCompare: buildCompare,
    baselineState: baselineState,
    clear: clear
  };
})();
