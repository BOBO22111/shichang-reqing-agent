/* =========================================================================
   functions/market.cjs —— 云端接口：/api/market
   -------------------------------------------------------------------------
   作用：按需返回单个币种的 K 线，供币种详情里的迷你图使用。
   只有用户点开某个币种时才会被调用，不做批量请求。
   带 6 秒服务端缓存。
   ========================================================================= */

'use strict';

const { fetchCandles, jsonResponse } = require('./_data.cjs');

const CACHE_TTL_MS = 6000;
const MAX_LIMIT = 200;

const cache = new Map();

exports.handler = async function (event) {
  const method = event.httpMethod || 'GET';
  if (method !== 'GET') {
    return jsonResponse(405, { ok: false, message: '该接口只支持 GET 请求' });
  }

  const params = event.queryStringParameters || {};
  const platform = params.platform === 'onchain' ? 'onchain' : 'cex';
  const symbol = String(params.symbol || '').trim();
  const interval = String(params.interval || '1h').trim();
  let limit = parseInt(params.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 48;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  if (!symbol) {
    return jsonResponse(400, { ok: false, message: '缺少必要参数：币种代号（symbol）' });
  }

  const key = platform + '|' + symbol + '|' + interval + '|' + limit;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return jsonResponse(200, Object.assign({ ok: true, cached: true }, hit.data), 6);
  }

  try {
    const candles = await fetchCandles(platform, symbol, interval, limit);
    const payload = {
      platform: platform,
      symbol: symbol,
      interval: interval,
      limit: limit,
      fetchedAt: Date.now(),
      candles: candles
    };
    cache.set(key, { ts: Date.now(), data: payload });

    /* 缓存条目过多时清理最早的几条 */
    if (cache.size > 240) {
      const keys = Array.from(cache.keys()).slice(0, 60);
      keys.forEach(function (k) { cache.delete(k); });
    }

    return jsonResponse(200, Object.assign({ ok: true, cached: false }, payload), 6);
  } catch (err) {
    return jsonResponse(502, {
      ok: false,
      message: '云端代理取 K 线失败：' + (err && err.message ? err.message : '未知原因')
    });
  }
};
