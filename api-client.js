/* =========================================================================
   api-client.js —— 取数通道的选择与自动兜底
   -------------------------------------------------------------------------
   本项目准备了两条取数通道：

     通道一（优先）：云端接口代理
       页面统一向本站的 /api/xxx 发请求，由站点的云端函数再去访问各大平台。
       好处：带服务端短时缓存、统一处理错误与超时、上游地址不暴露在网页代码里。

     通道二（自动兜底）：浏览器直连
       当站点没有部署云端函数时（例如把静态文件直接拖到一个纯静态空间），
       页面会自动检测到这一点，改由浏览器直接访问各大平台的公开接口。

   页面顶部会如实显示当前实际使用的是哪条通道，不会含糊其辞。
   ========================================================================= */

window.ApiClient = (function () {
  'use strict';

  var PROXY_TIMEOUT_MS = 20000;

  /* 最近一次实际使用的通道，供界面显示 */
  var lastVia = null;
  /* 云端通道不可用的原因，便于排查（不直接给用户看） */
  var proxyReason = null;

  /* 请求本站的云端接口，并判断它是不是「可用的」 */
  function requestViaProxy(path) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, PROXY_TIMEOUT_MS);

    return fetch(path, { headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) {
          /* 404 通常说明站点根本没有部署函数（纯静态部署） */
          return { available: false, reason: '云端接口返回状态码 ' + res.status };
        }
        var type = res.headers.get('content-type') || '';
        if (type.indexOf('json') < 0) {
          /* 返回的不是 JSON，说明这个地址被静态站兜底成了网页 */
          return { available: false, reason: '云端接口返回的不是 JSON，站点可能没有部署函数' };
        }
        return res.json().then(function (json) {
          if (!json || json.ok !== true) {
            return { available: false, reason: (json && json.message) ? json.message : '云端接口返回体缺少成功标记' };
          }
          return { available: true, data: json };
        }, function () {
          return { available: false, reason: '云端接口返回的内容无法解析' };
        });
      }, function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') {
          return { available: false, reason: '云端接口响应超时' };
        }
        return { available: false, reason: '无法连接云端接口' };
      });
  }

  /**
   * 取全市场快照
   * @param {String} platform 'cex' 或 'onchain'
   * @returns {Promise<Object>} 快照对象，额外带 via 字段说明走了哪条通道
   */
  function loadSnapshot(platform) {
    return requestViaProxy('/api/heat?platform=' + encodeURIComponent(platform))
      .then(function (r) {
        if (r.available && r.data && Array.isArray(r.data.coins) && r.data.coins.length) {
          lastVia = 'proxy';
          proxyReason = null;
          return {
            platform: r.data.platform || platform,
            fetchedAt: r.data.fetchedAt || Date.now(),
            marketLabel: r.data.marketLabel || '',
            hasVolatility: r.data.hasVolatility !== false,
            coins: r.data.coins,
            via: 'proxy'
          };
        }

        proxyReason = r.reason || '云端接口不可用';

        /* 云端通道不可用 → 自动切换到浏览器直连 */
        return window.DataDirect.fetchSnapshot(platform).then(function (d) {
          lastVia = 'direct';
          d.via = 'direct';
          d.proxyReason = proxyReason;
          return d;
        }, function (err) {
          /* 两条通道都失败时，把两个原因都告诉用户，方便判断是网络问题还是接口问题 */
          var msg = '两条取数通道都没能取到数据。\n' +
            '· 云端接口代理：' + proxyReason + '\n' +
            '· 浏览器直连：' + (err && err.message ? err.message : '未知原因');
          throw new Error(msg);
        });
      });
  }

  /**
   * 取单币 K 线（只在点开币种详情时调用）
   */
  function loadCandles(platform, symbol, interval, limit) {
    var query = '/api/market?platform=' + encodeURIComponent(platform) +
      '&symbol=' + encodeURIComponent(symbol) +
      '&interval=' + encodeURIComponent(interval) +
      '&limit=' + encodeURIComponent(limit);

    return requestViaProxy(query).then(function (r) {
      if (r.available && r.data && Array.isArray(r.data.candles) && r.data.candles.length) {
        lastVia = 'proxy';
        return { candles: r.data.candles, via: 'proxy' };
      }
      return window.DataDirect.fetchCandles(platform, symbol, interval, limit)
        .then(function (candles) {
          lastVia = 'direct';
          return { candles: candles, via: 'direct' };
        }, function (err) {
          throw new Error('K 线数据获取失败：' + (err && err.message ? err.message : '未知原因'));
        });
    });
  }

  function getLastVia() { return lastVia; }
  function getProxyReason() { return proxyReason; }

  /* 给界面用的通道说明文字 */
  function channelText(via) {
    if (via === 'proxy') return '云端接口代理';
    if (via === 'direct') return '浏览器直连';
    return '检测中';
  }

  return {
    loadSnapshot: loadSnapshot,
    loadCandles: loadCandles,
    getLastVia: getLastVia,
    getProxyReason: getProxyReason,
    channelText: channelText
  };
})();
