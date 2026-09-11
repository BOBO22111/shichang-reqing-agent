/* =========================================================================
   functions/_data.cjs —— 云端接口代理的公共取数模块
   -------------------------------------------------------------------------
   说明：本文件是「云端接口代理」通道的取数实现，与浏览器直连用的
   market-snapshot.js / data-source.js 保持完全相同的口径与字段换算。
   两条通道的换算结果有专门的对照测试，确保同一份原始数据在两条通道下
   得到一模一样的结果，不会出现「换个通道数字就变了」的情况。

   为什么这里不直接复用浏览器那份代码：
   云端函数在部署时会被打包成一个独立的压缩包，函数目录之外的文件不保证
   会被一起打包，所以这一层必须自带完整的取数与换算逻辑。
   ========================================================================= */

'use strict';

/* 请求超时（毫秒） */
const TIMEOUT_MS = 15000;

/* 两个数据源的接口地址 */
const CEX_BASE = 'https://api.gateio.ws/api/v4';
const ONCHAIN_BASE = 'https://api.hyperliquid.xyz/info';

/* 成交额低于该值的合约视为僵尸合约，不参与统计（界面上会如实标注） */
const MIN_QUOTE_VOLUME = 200000;

/* 稳定币互兑对没有分析意义，排除 */
const STABLE_BASES = [
  'USDC', 'USDT', 'DAI', 'FDUSD', 'TUSD', 'BUSD', 'PYUSD', 'USDD',
  'USDE', 'USD1', 'USDP', 'GUSD', 'EURT', 'EUR', 'EURS'
];

const PLATFORM_INFO = {
  cex: {
    key: 'cex',
    label: '综合平台',
    marketLabel: 'USDT 永续合约',
    hasVolatility: true
  },
  onchain: {
    key: 'onchain',
    label: '链上平台',
    marketLabel: '链上永续合约',
    hasVolatility: false
  }
};

/* ---------------------------------------------------------------------
   基础工具
   --------------------------------------------------------------------- */

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function parsePair(raw) {
  const s = String(raw || '').trim().toUpperCase();
  const i = s.indexOf('_');
  if (i < 0) return { base: s, quote: '' };
  return { base: s.slice(0, i), quote: s.slice(i + 1) };
}

function isStableBase(base) {
  return STABLE_BASES.indexOf(String(base || '').toUpperCase()) >= 0;
}

function safeDiv(a, b) {
  if (a === null || b === null || !b) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

/* 把接口的英文错误翻译成中文，避免英文错误码直接暴露给用户 */
const ERROR_MAP = {
  CONTRACT_NOT_FOUND: '该合约在交易所不存在',
  CURRENCY_PAIR_NOT_FOUND: '该交易对在交易所不存在',
  INVALID_CURRENCY_PAIR: '交易对名称格式不正确',
  INVALID_PARAM_VALUE: '请求参数不被接口接受',
  TOO_MANY_REQUESTS: '请求过于频繁，请稍等几秒再试',
  FORBIDDEN: '该接口拒绝了本次请求'
};

function describeUpstreamError(status, text) {
  const body = String(text || '');
  const keys = Object.keys(ERROR_MAP);
  for (let i = 0; i < keys.length; i++) {
    if (body.indexOf(keys[i]) >= 0) {
      return '上游接口返回：' + ERROR_MAP[keys[i]] + '（状态码 ' + status + '）';
    }
  }
  if (status === 404) return '上游接口地址不存在（状态码 404）';
  if (status === 429) return '请求过于频繁，被上游接口限流了（状态码 429）';
  if (status >= 500) return '上游接口暂时不可用（状态码 ' + status + '）';
  return '上游接口返回异常（状态码 ' + status + '）';
}

/* ---------------------------------------------------------------------
   带超时的请求（云端运行环境自带 fetch）
   --------------------------------------------------------------------- */

async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(describeUpstreamError(res.status, text));
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('接口返回的内容不是有效的 JSON，可能被网络中间环节改写了');
    }
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new Error('请求超时（超过 ' + Math.round((timeoutMs || TIMEOUT_MS) / 1000) + ' 秒没有响应）');
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------
   换算：综合平台全市场永续合约 tickers
   --------------------------------------------------------------------- */

function fromCexTickers(list) {
  const out = [];
  if (!Array.isArray(list)) return out;

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t || !t.contract) continue;

    const pair = parsePair(t.contract);
    if (pair.quote !== 'USDT') continue;
    if (isStableBase(pair.base)) continue;

    const markPrice = toNum(t.mark_price);
    const quoteVolume = toNum(t.volume_24h_quote);
    if (markPrice === null || markPrice <= 0) continue;
    if (quoteVolume === null || quoteVolume < MIN_QUOTE_VOLUME) continue;

    const totalSize = toNum(t.total_size);
    const multiplier = toNum(t.quanto_multiplier);
    let oiUsd = null;
    if (totalSize !== null && multiplier !== null) {
      oiUsd = totalSize * multiplier * markPrice;
      if (!Number.isFinite(oiUsd) || oiUsd <= 0) oiUsd = null;
    }

    const high = toNum(t.high_24h);
    const low = toNum(t.low_24h);
    let volPct = null;
    if (high !== null && low !== null && low > 0 && high >= low) {
      volPct = ((high - low) / low) * 100;
    }

    const fundingRate = toNum(t.funding_rate);
    const fundingAnnual = fundingRate === null ? null : fundingRate * 3 * 365 * 100;

    out.push({
      symbol: pair.base,
      raw: t.contract,
      last: toNum(t.last) || markPrice,
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

/* ---------------------------------------------------------------------
   换算：链上平台全市场永续快照
   --------------------------------------------------------------------- */

function fromOnchainSnapshot(raw) {
  const out = [];
  if (!Array.isArray(raw) || raw.length < 2) return out;

  const meta = raw[0] || {};
  const universe = Array.isArray(meta.universe) ? meta.universe : [];
  const ctxs = Array.isArray(raw[1]) ? raw[1] : [];

  for (let i = 0; i < universe.length; i++) {
    const u = universe[i];
    const c = ctxs[i];
    if (!u || !c) continue;
    if (u.isDelisted) continue;
    if (isStableBase(u.name)) continue;

    const markPrice = toNum(c.markPx);
    if (markPrice === null || markPrice <= 0) continue;

    const quoteVolume = toNum(c.dayNtlVlm);
    if (quoteVolume === null || quoteVolume < MIN_QUOTE_VOLUME) continue;

    const prevDayPx = toNum(c.prevDayPx);
    let changePct = null;
    if (prevDayPx !== null && prevDayPx > 0) {
      changePct = ((markPrice - prevDayPx) / prevDayPx) * 100;
    }

    const openInterest = toNum(c.openInterest);
    let oiUsd = openInterest === null ? null : openInterest * markPrice;
    if (oiUsd !== null && (!Number.isFinite(oiUsd) || oiUsd <= 0)) oiUsd = null;

    const fundingRate = toNum(c.funding);
    const fundingAnnual = fundingRate === null ? null : fundingRate * 24 * 365 * 100;

    out.push({
      symbol: String(u.name || '').toUpperCase(),
      raw: u.name,
      last: markPrice,
      markPrice: markPrice,
      changePct: changePct,
      quoteVolume: quoteVolume,
      oiUsd: oiUsd,
      turnover: safeDiv(quoteVolume, oiUsd),
      volPct: null,
      fundingRate: fundingRate,
      fundingAnnual: fundingAnnual,
      fundingCycle: '1 小时'
    });
  }

  return out;
}

/* ---------------------------------------------------------------------
   取全市场快照
   --------------------------------------------------------------------- */

async function fetchSnapshot(platform) {
  if (platform === 'onchain') {
    const raw = await requestJson(ONCHAIN_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' })
    }, 20000);

    const coins = fromOnchainSnapshot(raw);
    if (!coins.length) throw new Error('接口返回成功，但没有解析出任何有效市场数据');
    return {
      platform: 'onchain',
      fetchedAt: Date.now(),
      marketLabel: PLATFORM_INFO.onchain.marketLabel,
      hasVolatility: false,
      coins: coins
    };
  }

  const list = await requestJson(CEX_BASE + '/futures/usdt/tickers', {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  }, 20000);

  const coins = fromCexTickers(list);
  if (!coins.length) throw new Error('接口返回成功，但没有解析出任何有效合约数据');
  return {
    platform: 'cex',
    fetchedAt: Date.now(),
    marketLabel: PLATFORM_INFO.cex.marketLabel,
    hasVolatility: true,
    coins: coins
  };
}

/* ---------------------------------------------------------------------
   取单币 K 线
   --------------------------------------------------------------------- */

function intervalToMs(iv) {
  const map = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '2h': 7200000, '4h': 14400000, '8h': 28800000,
    '12h': 43200000, '1d': 86400000
  };
  return map[iv] || 3600000;
}

function normalizeCandles(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;

  for (let i = 0; i < raw.length; i++) {
    const k = raw[i];
    let t, o, h, l, c, v;

    if (Array.isArray(k)) {
      /* 数组形态：第 0 位时间戳，第 2–6 位依次是收、高、低、开、量 */
      t = Number(k[0]);
      c = Number(k[2]);
      h = Number(k[3]);
      l = Number(k[4]);
      o = Number(k[5]);
      v = Number(k[6]);
    } else if (k && typeof k === 'object') {
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
       两个数据源给的精度不一样，必须统一，否则时间轴会错。 */
    if (Number.isFinite(t) && t < 1e11) t = t * 1000;

    if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) ||
        !Number.isFinite(l) || !Number.isFinite(c)) continue;
    out.push({ t: t, o: o, h: h, l: l, c: c, v: Number.isFinite(v) ? v : 0 });
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}

async function fetchCandles(platform, symbol, interval, limit) {
  const iv = interval || '1h';
  const n = limit || 48;

  if (platform === 'onchain') {
    const stepMs = intervalToMs(iv);
    const end = Date.now();
    const start = end - stepMs * (n + 2);
    const raw = await requestJson(ONCHAIN_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: { coin: symbol, interval: iv, startTime: start, endTime: end }
      })
    }, 20000);
    return normalizeCandles(raw);
  }

  const url = CEX_BASE + '/futures/usdt/candlesticks?contract=' +
    encodeURIComponent(symbol) + '&interval=' + encodeURIComponent(iv) + '&limit=' + n;
  const raw = await requestJson(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  }, 15000);
  return normalizeCandles(raw);
}

/* ---------------------------------------------------------------------
   统一的 JSON 响应（带浏览器缓存头）
   --------------------------------------------------------------------- */

function jsonResponse(statusCode, body, maxAgeSeconds) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=' + (maxAgeSeconds || 0) +
        ', s-maxage=' + (maxAgeSeconds || 0)
    },
    body: JSON.stringify(body)
  };
}

module.exports = {
  TIMEOUT_MS: TIMEOUT_MS,
  MIN_QUOTE_VOLUME: MIN_QUOTE_VOLUME,
  PLATFORM_INFO: PLATFORM_INFO,
  toNum: toNum,
  parsePair: parsePair,
  safeDiv: safeDiv,
  fromCexTickers: fromCexTickers,
  fromOnchainSnapshot: fromOnchainSnapshot,
  normalizeCandles: normalizeCandles,
  fetchSnapshot: fetchSnapshot,
  fetchCandles: fetchCandles,
  describeUpstreamError: describeUpstreamError,
  jsonResponse: jsonResponse
};
