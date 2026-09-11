/* =========================================================================
   functions/heat.cjs —— 云端接口：/api/heat
   -------------------------------------------------------------------------
   作用：一次返回全市场（永续合约口径）的行情快照，供页面计算热度。
   带 30 秒服务端缓存：同一时间内多个访问者共用一份结果，减少对上游的请求。
   ========================================================================= */

'use strict';

const { fetchSnapshot, jsonResponse } = require('./_data.cjs');

/* 服务端缓存时长（毫秒） */
const CACHE_TTL_MS = 30000;

/* 简单的内存缓存：{ 平台: { ts, data } } */
const cache = new Map();

exports.handler = async function (event) {
  /* 只允许 GET */
  const method = event.httpMethod || 'GET';
  if (method !== 'GET') {
    return jsonResponse(405, { ok: false, message: '该接口只支持 GET 请求' });
  }

  const params = event.queryStringParameters || {};
  const platform = params.platform === 'onchain' ? 'onchain' : 'cex';

  /* 命中缓存就直接返回 */
  const hit = cache.get(platform);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return jsonResponse(200, Object.assign({ ok: true, cached: true }, hit.data), 30);
  }

  try {
    const snap = await fetchSnapshot(platform);
    cache.set(platform, { ts: Date.now(), data: snap });

    /* 缓存条目太多时做一次简单清理 */
    if (cache.size > 12) {
      const oldest = Array.from(cache.keys())[0];
      cache.delete(oldest);
    }

    return jsonResponse(200, Object.assign({ ok: true, cached: false }, snap), 30);
  } catch (err) {
    return jsonResponse(502, {
      ok: false,
      message: '云端代理取数失败：' + (err && err.message ? err.message : '未知原因')
    });
  }
};
