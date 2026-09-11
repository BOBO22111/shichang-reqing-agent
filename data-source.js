/* =========================================================================
   data-source.js —— 浏览器直连取数
   -------------------------------------------------------------------------
   作用：在不依赖任何服务器的情况下，由浏览器直接向各大平台的公开行情接口
   取数据。这是「浏览器直连」通道的实现（另一条通道是站点自带的云端接口代理）。
   两个接口都允许跨域访问，所以直连在技术上是可行的。

   本模块只负责「取回来并整理成统一结构」，不算任何指标。
   ========================================================================= */

window.DataDirect = (function () {
  'use strict';

  /* 请求超时时间（毫秒）。超过就直接判定为失败，不让页面一直转圈。 */
  var TIMEOUT_MS = 15000;

  /* 两个数据源的接口地址（仅出现在代码里，界面上一律使用中性称呼） */
  var CEX_BASE = 'https://api.gateio.ws/api/v4';
  var ONCHAIN_BASE = 'https://api.hyperliquid.xyz/info';

  /* 对照表：界面用中性称呼描述平台类型与市场类型 */
  var PLATFORM_INFO = {
    cex: {
      key: 'cex',
      label: '综合平台',
      marketLabel: 'USDT 永续合约',
      hasVolatility: true,
      /* 该源提供 24 小时最高/最低价，因此可以计算波动幅度 */
      quote: 'USDT'
    },
    onchain: {
      key: 'onchain',
      label: '链上平台',
      marketLabel: '链上永续合约',
      hasVolatility: false,
      /* 该源不提供 24 小时最高/最低价，波动幅度列为空 */
      quote: 'USD'
    }
  };

  /* =======================================================================
     一、通用请求封装
     ======================================================================= */

  function fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || TIMEOUT_MS);
    var opts = Object.assign({}, options || {}, { signal: controller.signal });
    return fetch(url, opts).then(
      function (res) { clearTimeout(timer); return res; },
      function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') {
          throw new Error('请求超时（超过 ' + Math.round((timeoutMs || TIMEOUT_MS) / 1000) + ' 秒没有响应）');
        }
        throw new Error('网络连接失败，可能是网络不通或浏览器拦截了跨域请求');
      }
    );
  }

  function getJson(url, timeoutMs) {
    return fetchWithTimeout(url, { method: 'GET', headers: { 'Accept': 'application/json' } }, timeoutMs)
      .then(readJson);
  }

  function postJson(url, body, timeoutMs) {
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    }, timeoutMs).then(readJson);
  }

  function readJson(res) {
    if (!res.ok) {
      return res.text().then(function (text) {
        throw new Error(describeUpstreamError(res.status, text));
      }, function () {
        throw new Error(describeUpstreamError(res.status, ''));
      });
    }
    return res.json().catch(function () {
      throw new Error('接口返回的内容不是有效的 JSON，可能被网络中间环节改写了');
    });
  }

  /* =======================================================================
     二、把接口的英文错误翻译成中文，避免英文错误码直接暴露给用户
     ======================================================================= */

  var ERROR_MAP = {
    CONTRACT_NOT_FOUND: '该合约在交易所不存在',
    CURRENCY_PAIR_NOT_FOUND: '该交易对在交易所不存在',
    INVALID_CURRENCY_PAIR: '交易对名称格式不正确',
    INVALID_PARAM_VALUE: '请求参数不被接口接受',
    TOO_MANY_REQUESTS: '请求过于频繁，请稍等几秒再试',
    FORBIDDEN: '该接口拒绝了本次请求'
  };

  function describeUpstreamError(status, text) {
    var body = String(text || '');
    var keys = Object.keys(ERROR_MAP);
    for (var i = 0; i < keys.length; i++) {
      if (body.indexOf(keys[i]) >= 0) {
        return '上游接口返回：' + ERROR_MAP[keys[i]] + '（状态码 ' + status + '）';
      }
    }
    if (status === 404) return '上游接口地址不存在（状态码 404）';
    if (status === 429) return '请求过于频繁，被上游接口限流了（状态码 429）';
    if (status >= 500) return '上游接口暂时不可用（状态码 ' + status + '）';
    return '上游接口返回异常（状态码 ' + status + '）';
  }

  /* =======================================================================
     三、全市场快照
     ======================================================================= */

  /**
   * 取全市场快照
   * @param {String} platform 'cex' 或 'onchain'
   * @returns {Promise<Object>} { platform, fetchedAt, coins, marketLabel }
   */
  function fetchSnapshot(platform) {
    if (platform === 'onchain') {
      return postJson(ONCHAIN_BASE, { type: 'metaAndAssetCtxs' }, 20000).then(function (raw) {
        var coins = window.MarketSnapshot.fromOnchainSnapshot(raw);
        if (!coins.length) throw new Error('接口返回成功，但没有解析出任何有效市场数据');
        return {
          platform: 'onchain',
          fetchedAt: Date.now(),
          marketLabel: PLATFORM_INFO.onchain.marketLabel,
          hasVolatility: false,
          coins: coins
        };
      });
    }

    return getJson(CEX_BASE + '/futures/usdt/tickers', 20000).then(function (list) {
      var coins = window.MarketSnapshot.fromCexTickers(list);
      if (!coins.length) throw new Error('接口返回成功，但没有解析出任何有效合约数据');
      return {
        platform: 'cex',
        fetchedAt: Date.now(),
        marketLabel: PLATFORM_INFO.cex.marketLabel,
        hasVolatility: true,
        coins: coins
      };
    });
  }

  /* =======================================================================
     四、单币 K 线（只在用户点开币种详情时才请求一次）
     ======================================================================= */

  function fetchCandles(platform, symbol, interval, limit) {
    var iv = interval || '1h';
    var n = limit || 48;

    if (platform === 'onchain') {
      /* 链上平台需要给定时间范围，这里按周期反推起始时间 */
      var stepMs = intervalToMs(iv);
      var end = Date.now();
      var start = end - stepMs * (n + 2);
      return postJson(ONCHAIN_BASE, {
        type: 'candleSnapshot',
        req: { coin: symbol, interval: iv, startTime: start, endTime: end }
      }, 20000).then(function (raw) {
        return normalizeCandles(raw);
      });
    }

    var url = CEX_BASE + '/futures/usdt/candlesticks?contract=' +
      encodeURIComponent(symbol) + '&interval=' + encodeURIComponent(iv) + '&limit=' + n;
    return getJson(url, 15000).then(function (raw) {
      return normalizeCandles(raw);
    });
  }

  function intervalToMs(iv) {
    var map = {
      '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
      '1h': 3600000, '2h': 7200000, '4h': 14400000, '8h': 28800000,
      '12h': 43200000, '1d': 86400000
    };
    return map[iv] || 3600000;
  }

  /* 把两个数据源的 K 线统一成 [{ t, o, h, l, c, v }]，时间戳统一用毫秒 */
  function normalizeCandles(raw) {
    var out = [];
    if (!Array.isArray(raw)) return out;

    for (var i = 0; i < raw.length; i++) {
      var k = raw[i];
      var t, o, h, l, c, v;

      if (Array.isArray(k)) {
        /* 数组形态：第 0 位是时间戳，第 1 位成交额（保留但不用），
           第 2–6 位依次是收盘、最高、最低、开盘、成交量 */
        t = Number(k[0]);
        c = Number(k[2]);
        h = Number(k[3]);
        l = Number(k[4]);
        o = Number(k[5]);
        v = Number(k[6]);
      } else if (k && typeof k === 'object') {
        /* 对象形态 */
        t = Number(k.t);
        o = Number(k.o);
        h = Number(k.h);
        l = Number(k.l);
        c = Number(k.c);
        v = Number(k.v);
      } else {
        continue;
      }

      /* 时间戳口径统一成毫秒：10 位数字按「秒」处理，13 位按「毫秒」处理。
         两个数据源给的精度不一样，这里必须统一，否则图上时间轴会错。 */
      if (isFinite(t) && t < 1e11) t = t * 1000;

      if (!isFinite(t) || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
      out.push({ t: t, o: o, h: h, l: l, c: c, v: isFinite(v) ? v : 0 });
    }

    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  /* 供界面显示的统一来源描述（不出现具体平台品牌名） */
  function sourceLabel(platform, via) {
    var info = PLATFORM_INFO[platform] || PLATFORM_INFO.cex;
    var channel = via === 'proxy' ? '云端接口代理' : '浏览器直连';
    return '各大平台公开行情接口（' + info.marketLabel + '） · ' + channel;
  }

  return {
    TIMEOUT_MS: TIMEOUT_MS,
    PLATFORM_INFO: PLATFORM_INFO,
    fetchSnapshot: fetchSnapshot,
    fetchCandles: fetchCandles,
    normalizeCandles: normalizeCandles,
    describeUpstreamError: describeUpstreamError,
    sourceLabel: sourceLabel
  };
})();
