#!/usr/bin/env node
/**
 * agent.mjs —— 市场热度情绪智能体的「Agent 命令行入口」
 *
 * 用途：让 AI Agent（Claude Code / OpenClaw 等）或任何脚本，用一行命令拿到
 *       全市场热度排行、赛道冷热、资金出逃与资金轮动的结论，不必打开网页。
 *
 * 四条数据通道（账号与密钥要求都是零）：
 *   ① 官方技能（--skill）：直接调用币安官方技能市场（github.com/binance/binance-skills-hub）
 *      里 `binance` 技能驱动的命令行工具 binance-cli，取全市场现货快照；
 *      官方 CLI 的默认入口（主站域名）在当前网络不可达时，自动改用官方为「仅公开行情」
 *      提供的独立入口，请求仍由官方 CLI 发起；未安装 binance-cli 时回退到 --live
 *      并打印官方安装命令。
 *   ② 官方公开数据（--official，推荐）：读币安官方开源的公开数据仓库
 *      （github.com/binance/binance-public-data → data.binance.vision）里的
 *      合约 K 线 + 合约指标文件，逐币拼出**带持仓量的**全市场快照。
 *      币种名单从实时接口动态获取（接口不可用时退回内置清单，并如实标注）。
 *   ③ 官方公开行情（--live）：读币安官方公开行情接口 data-api.binance.vision 的
 *      全市场现货快照（ticker/24hr 不带 symbol，一次拿全）。
 *   ④ 默认（实时多平台）：综合平台合约全市场快照 + 链上平台快照，与网页版完全一致。
 *
 * 用法：
 *   node agent.mjs                                  实时多平台，一次性出结论
 *   node agent.mjs --official                       官方公开数据（合约口径，含持仓量）
 *   node agent.mjs --official --top 200             分析成交额前 200 个合约
 *   node agent.mjs --official --date 2026-09-11     指定 UTC 日期
 *   node agent.mjs --official --symbols BTC,ETH,SOL 只分析指定币种
 *   node agent.mjs --live                           官方公开行情（现货口径）
 *   node agent.mjs --skill                          官方技能通道（未装 CLI 会自动回退）
 *   node agent.mjs "看看现在市场热不热"              自然语言
 *   node agent.mjs --official --json                输出 JSON（给 Agent 解析）
 *   node agent.mjs --status / --reset               查看 / 清空对比基线
 *
 * 说明：只读取公开数据，不涉及任何交易操作，不需要也不接受 API 密钥。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ============================================================
 * 一、本地状态文件（用于「与上次运行对比」，作用等同于网页里的 localStorage）
 * ============================================================ */

const STATE_FILE = path.join(ROOT, '.src-agent-state.json');

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

const store0 = loadState();

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(store0));
  } catch (e) {
    /* 写不进去不影响本次分析 */
  }
}

/* ============================================================
 * 二、加载与网页完全相同的引擎代码
 *
 * 这三个文件是网页用的同一份代码（sectors.js / market-snapshot.js / heat-engine.js），
 * 所以命令行给出的结论与网页上看到的**完全一致**，不会出现两套口径。
 * heat-engine.js 是纯计算、不发任何网络请求的。
 * ============================================================ */

globalThis.window = globalThis; // 这几个文件按浏览器习惯挂在 window 上，这里给个等价物
['sectors.js', 'market-snapshot.js', 'heat-engine.js'].forEach((f) => {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  new Function(code)(); // eslint-disable-next-line no-new-func
});

const { HeatEngine, SectorDB, MarketSnapshot } = globalThis;
const data = require('./functions/_data.cjs');

/* ============================================================
 * 三、币安官方公开资源地址
 *
 * 说明：币安为「仅需公开行情」的场景提供了 data-api.binance.vision 这个入口 ——
 *       只提供公开市场数据、不需要 API 密钥，也不会返回账户相关信息。
 *       data.binance.vision 则是官方开源的公开数据仓库（历史文件）。
 * ============================================================ */

const BINANCE_PUBLIC_BASE = 'https://data-api.binance.vision/api/v3';
const OFFICIAL_DATA_BASE = 'https://data.binance.vision';

/** 官方技能驱动的命令行工具（binance-cli）安装命令，来自官方技能 SKILL.md */
const BINANCE_CLI_INSTALL_CMD =
  "curl --proto '=https' --tlsv1.2 -LsSf " +
  'https://github.com/binance/binance-cli/releases/latest/download/binance-cli-installer.sh | sh';

/** 官方文件名里的交易对不带下划线：BTC_USDT → BTCUSDT */
const binancePair = (symbol) => String(symbol).replace(/[_/]/g, '').toUpperCase();

/**
 * 综合平台的合约全市场行情地址（与网页版浏览器直连用的地址相同）
 * 说明：这里优先拿注释里的常量，拿不到就退回同一地址，保证与网页版口径一致。
 */
const CEX_TICKERS_URL = (data.CEX_BASE || 'https://api.gateio.ws/api/v4') + '/futures/usdt/tickers';

/** 官方公开数据仓库：合约 K 线文件地址 */
function officialKlineUrl(kind, pair, interval, date) {
  return OFFICIAL_DATA_BASE + '/data/' + kind + '/daily/klines/' +
    pair + '/' + interval + '/' + pair + '-' + interval + '-' + date + '.zip';
}

/** 官方公开数据仓库：合约指标文件地址（5 分钟粒度，含持仓量） */
function officialMetricsUrl(pair, date) {
  return OFFICIAL_DATA_BASE + '/data/futures/um/daily/metrics/' +
    pair + '/' + pair + '-metrics-' + date + '.zip';
}

/* ============================================================
 * 四、通用网络与解压工具
 * ============================================================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带超时与重试的请求；失败时抛出带中文说明的错误 */
async function request(url, options, timeoutMs, tries) {
  const maxTries = tries || 2;
  let lastErr = null;
  for (let i = 0; i < maxTries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
    try {
      const res = await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
      clearTimeout(timer);
      // 5xx 这类临时故障重试一次；4xx（例如 404）直接返回，不浪费请求
      if (res.status >= 500 && i < maxTries - 1) continue;
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i < maxTries - 1) {
        await sleep(400);
        continue;
      }
    }
  }
  if (lastErr && lastErr.name === 'AbortError') {
    throw new Error('请求超时（超过 ' + Math.round((timeoutMs || 20000) / 1000) + ' 秒没有响应）：' + url);
  }
  throw new Error('网络连接失败（可能是网络不通）：' + url);
}

async function requestJson(url, timeoutMs) {
  const res = await request(url, { headers: { Accept: 'application/json', 'User-Agent': 'src-agent' } }, timeoutMs);
  if (!res.ok) throw new Error('接口返回失败：HTTP ' + res.status + '（' + url + '）');
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('接口返回的内容不是有效的 JSON：' + url);
  }
}

/**
 * 解压官方数据文件（ZIP 里只有一个 CSV）
 *
 * 官方文件很小（K 线约 1.5 KB、指标约 30 KB），整包读进内存再解压最简单可靠。
 * 这里按 ZIP 本地文件头里的「压缩方式」字段决定怎么解：
 *   0 = 未压缩（直接取原文）  8 = deflate（走 inflateRaw）
 */
function unzipSingleFile(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('不是有效的 ZIP 文件（缺少本地文件头）');
  }
  const method = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  const body = buf.subarray(dataStart);

  if (method === 0) return body.toString('utf8');
  if (method === 8) {
    // finishFlush: Z_SYNC_FLUSH —— 允许结尾带多余的校验/目录字节，不会因为尾部数据报错
    try {
      return zlib.inflateRawSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
    } catch (e) {
      return zlib.inflateRawSync(body).toString('utf8');
    }
  }
  throw new Error('官方文件使用了不支持的压缩方式（' + method + '）');
}

/** 下载一个官方数据文件并解出文本；文件不存在时抛 HTTP 404 错误 */
async function downloadCsv(url, timeoutMs) {
  const res = await request(url, { headers: { 'User-Agent': 'src-agent' } }, timeoutMs || 30000);
  if (!res.ok) {
    const err = new Error('官方数据文件下载失败：HTTP ' + res.status + '（' + url + '）');
    err.status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return unzipSingleFile(buf);
}

/** 并发受限的批量执行：items 逐个交给 fn，同时最多 limit 个在跑 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length) || 1).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ============================================================
 * 五、CSV 解析（官方数据文件都是标准 CSV，第一行是表头）
 * ============================================================ */

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(',');
    // 官方文件第一行是表头：它的第一个字段不是数字
    if (header === null && !/^-?\d/.test(cells[0])) {
      header = cells.map((c) => c.trim());
      continue;
    }
    rows.push(cells);
  }
  return { header, rows };
}

/** 从表头里找到某个字段的下标 */
function colIndex(header, name, fallback) {
  if (Array.isArray(header)) {
    const i = header.indexOf(name);
    if (i >= 0) return i;
  }
  return fallback;
}

/* ============================================================
 * 六、币种宇宙：从实时接口动态取名单（失败才退回内置清单）
 *
 * 为什么需要这一步：官方公开数据仓库只按「币对」存放文件，没有目录列举接口，
 * 所以拿不到完整币种名单。这里的做法是先问实时接口要一份「当前真实在交易的
 * 全市场合约」名单（与官方合约数据同口径），再逐个去官方仓库取对应文件。
 * ============================================================ */

/** 兜底清单：实时接口不可用时使用（会在输出里如实标注「已退回内置清单」） */
const FALLBACK_SYMBOLS = [
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TON',
  'SUI', 'APT', 'ARB', 'OP', 'PEPE', 'WIF', 'SHIB', 'LTC', 'DOT', 'TRX',
  'NEAR', 'ATOM', 'FIL', 'ETC', 'ICP', 'UNI', 'AAVE', 'MKR', 'CRV', 'LDO',
  'INJ', 'SEI', 'TIA', 'STX', 'IMX', 'RUNE', 'FET', 'RENDER', 'TAO', 'WLD',
  'BONK', 'FLOKI', 'ORDI', 'SATS', 'JUP', 'PYTH', 'ONDO', 'ENA', 'ETHFI', 'EIGEN',
  'W', 'ZRO', 'STRK', 'ZK', 'MANTA', 'AXS', 'SAND', 'MANA', 'GALA', 'APE',
  'GMT', 'DYDX', 'GMX', 'SNX', 'COMP', 'SUSHI', 'YFI', 'BAL', '1INCH', 'CAKE',
  'RAY', 'JTO', 'PENDLE', 'MORPHO', 'AERO', 'HYPE', 'BERA', 'MOVE', 'GRASS', 'VIRTUAL',
  'AIXBT', 'GOAT', 'ACT', 'TRUMP', 'FARTCOIN', 'PENGU', 'POPCAT', 'BRETT', 'TURBO', 'BOME',
  'KAS', 'HBAR', 'XLM', 'ALGO', 'VET', 'XTZ', 'EOS', 'FLOW', 'MINA', 'ROSE',
  'KSM', 'ZIL', 'ONE', 'CELO', 'KAVA', 'EGLD', 'CFX', 'ASTR', 'QTUM', 'IOTA',
  'AR', 'STORJ', 'LPT', 'ANKR', 'AXL', 'STG', 'OMNI', 'DASH', 'ZEC', 'XMR',
  'BCH', 'BSV', 'DGB', 'RVN', 'NEO', 'IOTX', 'BLUR', 'WOO', 'MASK', 'ENS'
];

/**
 * 动态获取「有资格参与分析的币种名单」
 * @returns {Promise<{pairs:Array<{base:string,pair:string,volume:number}>, from:string, url:string|null}>}
 */
async function fetchSymbolUniverse() {
  // ① 优先问综合平台要合约全市场快照（与官方合约数据同一口径）
  try {
    const list = await requestJson(CEX_TICKERS_URL, 25000);
    const coins = MarketSnapshot.fromCexTickers(list);
    if (coins.length) {
      coins.sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0));
      return {
        pairs: coins.map((c) => ({ base: c.symbol, pair: binancePair(c.symbol + 'USDT'), volume: c.quoteVolume })),
        from: '实时接口动态取名单（综合平台 USDT 永续合约全市场快照，按 24 小时成交额排序）',
        url: CEX_TICKERS_URL,
      };
    }
  } catch (e) {
    /* 换下一个来源 */
  }

  // ② 退而求其次：官方公开行情接口的现货全市场快照
  try {
    const rows = await requestJson(BINANCE_PUBLIC_BASE + '/ticker/24hr', 25000);
    if (Array.isArray(rows)) {
      const stable = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'EURS', 'EUR', 'AEUR', 'USD1', 'XUSD']);
      const pairs = [];
      rows.forEach((r) => {
        const sym = String(r.symbol || '');
        if (!sym.endsWith('USDT')) return;
        const base = sym.slice(0, -4);
        if (!base || stable.has(base)) return;
        const qv = Number(r.quoteVolume);
        if (!Number.isFinite(qv) || qv < 200000) return;
        pairs.push({ base: base, pair: sym, volume: qv });
      });
      if (pairs.length) {
        pairs.sort((a, b) => b.volume - a.volume);
        return {
          pairs: pairs,
          from: '实时接口动态取名单（官方公开行情接口的现货全市场快照，按 24 小时成交额排序）',
          url: BINANCE_PUBLIC_BASE + '/ticker/24hr',
        };
      }
    }
  } catch (e) {
    /* 落到内置清单 */
  }

  // ③ 两个实时来源都不通 → 退回内置清单（如实标注）
  return {
    pairs: FALLBACK_SYMBOLS.map((s) => ({ base: s, pair: binancePair(s + 'USDT'), volume: null })),
    from: '内置主流币清单（实时接口本次不可用，已如实标注）',
    url: null,
  };
}

/* ============================================================
 * 七、通道一：官方公开数据（合约 K 线 + 合约指标，逐币拼全市场快照）
 * ============================================================ */

/**
 * 确定官方通道要用的 UTC 日期
 *
 * 显式给了日期就用它（不回退，取不到就如实报错）；
 * 没给就往前找最近一个「文件已发布」的日期 —— 官方文件通常有 1 天左右延迟。
 * 探测时会依次试该币的几个候选名（含面值币前缀），避免因为第一个名字
 * 恰好不存在就误判成「官方没有数据」。
 */
async function resolveOfficialDate(explicitDate, probeCandidates, kind) {
  if (explicitDate) return { date: explicitDate, backed: false, probe: probeCandidates[0] };
  for (let back = 1; back <= 4; back++) {
    const d = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
    for (let i = 0; i < probeCandidates.length; i++) {
      const url = officialKlineUrl(kind, probeCandidates[i], '1h', d);
      try {
        const res = await request(url, { method: 'HEAD', headers: { 'User-Agent': 'src-agent' } }, 15000);
        if (res.ok) return { date: d, backed: back > 1, probe: probeCandidates[i] };
      } catch (e) {
        /* 换下一个候选名 */
      }
    }
  }
  return { date: null, backed: false, probe: probeCandidates[0] };
}

/**
 * 官方仓库的交易对命名「候选列表」
 *
 * 为什么需要这个：交易所对低价币的合约常用「面值币」代码，
 * 例如 PEPE 的合约文件其实叫 1000PEPEUSDT、SHIB 叫 1000SHIBUSDT。
 * 所以精确代码取不到时，依次再试 1000 / 10000 / 1000000 这三个常见倍数前缀，
 * 命中即用（真取不到才算这个币没有官方文件，如实计入失败数）。
 */
function buildOfficialCandidates(pair) {
  const list = [pair];
  if (!/^\d/.test(pair)) {
    list.push('1000' + pair, '10000' + pair, '1000000' + pair);
  }
  return list;
}

/**
 * 取单个币的官方数据，拼成引擎需要的一条币种记录
 * @returns {Promise<Object|null>} 归一化后的币种记录；官方没有该币文件时返回 null
 */
async function fetchOfficialCoin(pair, date, kind) {
  const iv = '1h';

  /* 1) 先确定官方仓库里这个币的真实文件名（可能在前面带面值倍数） */
  let dayText = null;
  let usedPair = null;
  const candidates = buildOfficialCandidates(pair);
  for (let i = 0; i < candidates.length; i++) {
    try {
      dayText = await downloadCsv(officialKlineUrl(kind, candidates[i], iv, date));
      usedPair = candidates[i];
      break;
    } catch (e) {
      if (e.status === 404) { dayText = null; continue; } // 换下一个候选名
      throw e;                                            // 网络类错误直接上报
    }
  }
  if (!dayText) return null;

  /* 2) 前一日文件（用于算跨日涨跌幅）；缺失时降级，不让整体失败 */
  const prevDate = new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const prevText = await downloadCsv(officialKlineUrl(kind, usedPair, iv, prevDate)).catch(() => null);

  const day = parseCsv(dayText);
  if (!day.rows.length) return null;

  const iOpen = colIndex(day.header, 'open', 1);
  const iHigh = colIndex(day.header, 'high', 2);
  const iLow = colIndex(day.header, 'low', 3);
  const iClose = colIndex(day.header, 'close', 4);
  const iQuoteVol = colIndex(day.header, 'quote_volume', 7);

  let high = null;
  let low = null;
  let quoteVolume = 0;
  let last = null;
  for (let i = 0; i < day.rows.length; i++) {
    const r = day.rows[i];
    const h = Number(r[iHigh]);
    const l = Number(r[iLow]);
    const c = Number(r[iClose]);
    const q = Number(r[iQuoteVol]);
    if (Number.isFinite(h)) high = high === null ? h : Math.max(high, h);
    if (Number.isFinite(l) && l > 0) low = low === null ? l : Math.min(low, l);
    if (Number.isFinite(q)) quoteVolume += q;
    if (Number.isFinite(c) && c > 0) last = c;
  }

  /* 涨跌幅基准：优先用前一日最后一根 K 线的收盘价（跨日口径）；
     前一日文件取不到时，退回当日第一根的开盘价，并在输出里标注口径。 */
  let base = null;
  let baseFrom = 'prev-day-close';
  if (prevText) {
    const prev = parseCsv(prevText);
    const iC = colIndex(prev.header, 'close', 4);
    for (let i = prev.rows.length - 1; i >= 0; i--) {
      const c = Number(prev.rows[i][iC]);
      if (Number.isFinite(c) && c > 0) { base = c; break; }
    }
  }
  if (base === null && day.rows.length) {
    const o = Number(day.rows[0][iOpen]);
    if (Number.isFinite(o) && o > 0) { base = o; baseFrom = 'same-day-open'; }
  }

  if (last === null || last <= 0) return null;

  const changePct = base !== null && base > 0 ? ((last - base) / base) * 100 : null;
  const volPct = high !== null && low !== null && low > 0 && high >= low
    ? ((high - low) / low) * 100
    : null;

  /* 合约指标文件（现货没有，只有 futures/um 有） */
  let oiUsd = null;
  let extras = null;
  if (kind === 'futures/um') {
    try {
      const mText = await downloadCsv(officialMetricsUrl(usedPair, date));
      const m = parseCsv(mText);
      if (m.rows.length) {
        const iOi = colIndex(m.header, 'sum_open_interest_value', 3);
        const iTop = colIndex(m.header, 'sum_toptrader_long_short_ratio', 5);
        const iTaker = colIndex(m.header, 'sum_taker_long_short_vol_ratio', 7);
        const lastRow = m.rows[m.rows.length - 1];
        const v = Number(lastRow[iOi]);
        if (Number.isFinite(v) && v > 0) oiUsd = v;
        const top = Number(lastRow[iTop]);
        const taker = Number(lastRow[iTaker]);
        extras = {
          toptraderLongShort: Number.isFinite(top) ? top : null,
          takerLongShort: Number.isFinite(taker) ? taker : null,
        };
      }
    } catch (e) {
      /* 指标文件缺失不影响该币参与分析，只是没有持仓量 */
    }
  }

  const coin = {
    symbol: pair.replace('USDT', ''),
    raw: usedPair,
    last: last,
    markPrice: last,
    changePct: changePct,
    quoteVolume: quoteVolume > 0 ? quoteVolume : null,
    oiUsd: oiUsd,
    turnover: MarketSnapshot.safeDiv(quoteVolume > 0 ? quoteVolume : null, oiUsd),
    volPct: volPct,
    fundingRate: null, // 官方资金费率为月度文件，为控制请求量未纳入
    fundingAnnual: null,
    fundingCycle: null,
    _baseFrom: baseFrom,
  };
  return { coin: coin, extras: extras, officialPair: usedPair, prefixed: usedPair !== pair };
}

/* ============================================================
 * 八、通道二：官方公开行情接口（全市场现货快照）
 * ============================================================ */

async function fetchOfficialLiveSnapshot() {
  const rows = await requestJson(BINANCE_PUBLIC_BASE + '/ticker/24hr', 30000);
  if (!Array.isArray(rows)) throw new Error('官方公开行情接口返回结构异常（期望一个数组）');

  const out = [];
  const seen = new Set();
  rows.forEach((t) => {
    const sym = String(t.symbol || '');
    if (!sym.endsWith('USDT')) return;
    const base = sym.slice(0, -4);
    if (!base) return;
    if (seen.has(base)) return;
    const markPrice = Number(t.lastPrice);
    const quoteVolume = Number(t.quoteVolume);
    if (!Number.isFinite(markPrice) || markPrice <= 0) return;
    if (!Number.isFinite(quoteVolume) || quoteVolume < 200000) return;
    const high = Number(t.highPrice);
    const low = Number(t.lowPrice);
    let volPct = null;
    if (Number.isFinite(high) && Number.isFinite(low) && low > 0 && high >= low) {
      volPct = ((high - low) / low) * 100;
    }
    seen.add(base);
    out.push({
      symbol: base,
      raw: sym,
      last: markPrice,
      markPrice: markPrice,
      changePct: Number.isFinite(Number(t.priceChangePercent)) ? Number(t.priceChangePercent) : null,
      quoteVolume: quoteVolume,
      oiUsd: null,       // 现货没有持仓量 → 换手强度留空，引擎会按比例分摊权重
      turnover: null,
      volPct: volPct,
      fundingRate: null,
      fundingAnnual: null,
      fundingCycle: null,
    });
  });

  // 与网页同一套过滤口径：剔除过小的僵尸交易对
  return out.filter((c) => (c.quoteVolume || 0) >= MarketSnapshot.MIN_QUOTE_VOLUME);
}

/* ============================================================
 * 九、通道三：官方技能（binance-cli）
 * ============================================================ */

/**
 * 官方技能驱动的命令行工具的可执行文件
 * 默认从系统 PATH 里找 binance-cli；也可用环境变量 BINANCE_CLI_PATH 指定完整路径
 */
function binanceCliBin() {
  const p = process.env.BINANCE_CLI_PATH;
  return p && String(p).trim() ? String(p).trim() : 'binance-cli';
}

function binanceCliAvailable() {
  try {
    const r = spawnSync(binanceCliBin(), ['--version'], { encoding: 'utf8', timeout: 8000 });
    return !r.error && r.status === 0;
  } catch (e) {
    return false;
  }
}

/** 尝试官方技能的现货全市场行情命令（不同版本命令名略有差异，逐个尝试） */
function binanceCliTickerAll() {
  const candidates = [
    // 官方 CLI 默认入口（官方主站域名）
    { args: ['spot', 'ticker24hr'], via: 'main' },
    { args: ['spot', 'ticker-24hr'], via: 'main' },
    { args: ['spot', 'ticker', '--type', '24hr'], via: 'main' },
    // 备用：官方为「仅需公开行情」提供的独立入口。
    // 仍由官方 CLI 发起请求、返回官方数据，用于官方主站域名在当前网络下不可达的情况。
    { args: ['request', 'GET', BINANCE_PUBLIC_BASE + '/ticker/24hr'], via: 'public' },
  ];
  let lastErr = null;
  for (const c of candidates) {
    const r = spawnSync(binanceCliBin(), c.args, { encoding: 'utf8', timeout: 45000, maxBuffer: 128 * 1024 * 1024 });
    if (r.error) { lastErr = r.error; continue; }
    const out = String(r.stdout || '');
    const s = out.indexOf('[');
    const e = out.lastIndexOf(']');
    if (s < 0 || e <= s) { lastErr = new Error('输出里没有 JSON 数组'); continue; }
    try {
      const rows = JSON.parse(out.slice(s, e + 1));
      if (Array.isArray(rows) && rows.length) {
        return { rows: rows, cmd: 'binance-cli ' + c.args.join(' '), via: c.via };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error('binance-cli 调用失败：' + (lastErr && lastErr.message ? lastErr.message : '未知原因'));
}

/* ============================================================
 * 十、参数解析（支持自然语言）
 * ============================================================ */

function parseArgs(argv) {
  const opts = {
    market: 'perp',
    source: 'realtime',
    top: 120,
    concurrency: 10,
    symbols: null,
    date: null,
    dateExplicit: false,
    json: false,
    status: false,
    reset: false,
    help: false,
  };

  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--reset') opts.reset = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--spot') opts.market = 'spot';
    else if (a === '--perp') opts.market = 'perp';
    else if (a === '--official' || a === '--binance-data') opts.source = 'official';
    else if (a === '--live' || a === '--binance-live') opts.source = 'live';
    else if (a === '--skill' || a === '--binance-cli') opts.source = 'skill';
    else if (a === '--realtime') opts.source = 'realtime';
    else if (a === '--date') {
      const v = String(argv[i + 1] || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { opts.date = v; opts.dateExplicit = true; }
      i += 1;
    } else if (a === '--top') {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) opts.top = Math.min(Math.round(v), 400);
      i += 1;
    } else if (a === '--concurrency') {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) opts.concurrency = Math.min(Math.round(v), 32);
      i += 1;
    } else if (a === '--symbols') {
      const v = String(argv[i + 1] || '');
      const list = v.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (list.length) opts.symbols = list;
      i += 1;
    } else rest.push(a);
  }

  // 剩余参数当成一句自然语言来解析
  const text = rest.join(' ');
  if (text) {
    if (/官方技能|技能包|binance-cli/i.test(text)) opts.source = 'skill';
    else if (/官方公开数据|官方数据|历史|公开数据仓库/i.test(text)) opts.source = 'official';
    else if (/官方公开行情|官方实时|官方接口/i.test(text)) opts.source = 'live';
    if (/现货|spot/i.test(text)) opts.market = 'spot';
    if (/永续|合约|perp/i.test(text)) opts.market = 'perp';
  }

  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`
市场热度情绪智能体 · 命令行入口

四条数据通道（都不需要 API 密钥、都不涉及交易操作）：
  官方技能    ：调用官方技能市场（Skills Hub）binance 技能驱动的 binance-cli 取全市场现货行情
  官方公开数据：读币安官方开源的公开数据仓库（data.binance.vision）的合约 K 线 + 合约指标
  官方公开行情：读币安官方公开行情接口（data-api.binance.vision）的全市场现货快照
  实时多平台  ：读综合平台合约与链上平台的公开行情（与网页版完全一致）

用法：
  node agent.mjs                                    实时多平台，一次性出结论
  node agent.mjs --official                         官方公开数据（合约口径，含持仓量）
  node agent.mjs --official --top 200               分析成交额前 200 个合约
  node agent.mjs --official --symbols BTC,ETH,SOL   只分析指定币种
  node agent.mjs --official --date 2026-09-11       指定 UTC 日期（默认最近已发布日）
  node agent.mjs --live                             官方公开行情接口（现货口径）
  node agent.mjs --skill                            官方技能通道（未装 binance-cli 会自动回退）
  node agent.mjs "看看现在市场热不热"                 自然语言
  node agent.mjs --json                             输出 JSON，便于 Agent 解析
  node agent.mjs --status / --reset                 查看 / 清空对比基线

参数：
  --official        官方公开数据通道（推荐：可复现、带持仓量）
  --top N           官方通道参与分析的合约数量上限，默认 120，最大 400
  --symbols A,B,C   官方通道只分析这些币种（优先于动态取名单）
  --date YYYY-MM-DD 官方通道的 UTC 日期，默认自动取最近一个已发布文件的日期
  --live            官方公开行情接口（全市场现货快照，一次拿全）
  --skill           官方技能通道（binance-cli；未安装或主站不可达时自动换用官方公开入口）
  --concurrency N   官方通道的并发下载数，默认 10
  --spot / --perp   现货 / 永续合约（默认永续）
  --json            输出 JSON（进度信息写到 stderr，stdout 只有 JSON）

提示：与上次运行的对比基线存放在 ${path.basename(STATE_FILE)}，用于计算持仓量与占比的变化。
`);
  process.exit(0);
}

/* 输出 helper：JSON 模式下所有进度/说明必须走 stderr，否则会污染 stdout 的 JSON */
const say = (s = '') => (opts.json ? process.stderr.write(String(s) + '\n') : console.log(s));
const progressInline = (s) => (opts.json ? process.stderr.write(s) : process.stdout.write(s));

if (opts.reset) {
  fs.writeFileSync(STATE_FILE, '{}');
  console.log('已清空对比基线：' + STATE_FILE);
  process.exit(0);
}

if (opts.status) {
  console.log('本地对比基线（用于计算持仓量与占比的变化）');
  const keys = Object.keys(store0);
  if (!keys.length) {
    console.log('  （还没有基线，先跑一次：node agent.mjs）');
  }
  keys.forEach((k) => {
    let v = null;
    try { v = JSON.parse(store0[k]); } catch (e) { v = null; }
    console.log('  · ' + k +
      (v ? '　保存于 ' + new Date(v.at).toLocaleString('zh-CN') +
        '　大饼占比 ' + (Number.isFinite(v.btcShare) ? v.btcShare.toFixed(2) + '%' : '—') +
        '　持仓量币数 ' + Object.keys(v.oiBySymbol || {}).length : '　（内容无法解析）'));
  });
  console.log('');
  process.exit(0);
}

/* ============================================================
 * 十一、主线：取数 → 用与网页相同的引擎分析
 * ============================================================ */

let coins = [];
let sourceInfo = null;
let extrasList = [];       // 官方通道独有维度（多空比），不参与热度分数
let officialMeta = null;   // 官方通道的日期、名单来源、失败数等
let warnings = [];

if (opts.source === 'skill' && !binanceCliAvailable()) {
  say('提示：未检测到 binance-cli（官方 binance 技能驱动的命令行工具）。');
  say('      官方安装命令（来自官方技能 SKILL.md）：');
  say('        ' + BINANCE_CLI_INSTALL_CMD);
  say('      本次自动回退到等价通道：官方公开行情接口 /api/v3/ticker/24hr');
  say('      （与官方技能的市场行情命令是同一个 REST 端点，官方文档认可的行情专用域名）。');
  say('');
  opts.requestedSource = 'skill';
  opts.source = 'live';
  opts.skillFallback = true;
}

if (opts.source === 'official') {
  /* ---------- 通道：官方公开数据（历史文件，可复现） ---------- */
  const kind = opts.market === 'spot' ? 'spot' : 'futures/um';
  const marketLabel = opts.market === 'spot' ? '现货' : 'USDT 永续合约';

  say('通道：币安官方公开数据仓库（data.binance.vision · 无需密钥）');
  say('说明：官方开源仓库的历史文件，结论可复现；合约口径附带持仓量（5 分钟粒度的指标文件）。');
  say('');

  /* 1) 币种名单：优先 --symbols，否则动态从实时接口取 */
  let universe;
  if (opts.symbols) {
    universe = {
      pairs: opts.symbols.map((s) => ({ base: s, pair: binancePair(s + 'USDT'), volume: null })),
      from: '命令行显式指定的币种清单（--symbols）',
      url: null,
    };
  } else {
    progressInline('正在获取当前在交易的全市场币种名单…');
    universe = await fetchSymbolUniverse();
    progressInline(' 完成\n');
  }
  const picked = universe.pairs.slice(0, opts.top);
  say('币种名单：' + universe.from);
  say('          可用 ' + universe.pairs.length + ' 个，本次分析前 ' + picked.length + ' 个');
  if (universe.url) say('          名单来源：' + universe.url);
  say('');

  /* 2) 日期：显式指定不回退；否则自动往前找最近已发布的日期 */
  const probe = picked[0] ? picked[0].pair : 'BTCUSDT';
  const dateInfo = await resolveOfficialDate(opts.date, buildOfficialCandidates(probe), kind);
  if (!dateInfo.date) {
    console.error('找不到可用的官方数据文件（已往前试了 4 天）：' +
      '请检查网络，或改用 --date 指定一个确定的日期。');
    process.exit(1);
  }
  const date = dateInfo.date;
  if (dateInfo.backed) say('（当天的文件还没发布，已自动改用 ' + date + '）');
  if (dateInfo.probe && dateInfo.probe !== probe) {
    say('（该币在官方仓库的代码是 ' + dateInfo.probe + '，已自动对应）');
  }
  say('日期：' + date + '（UTC）');
  say('');

  /* 3) 逐币下载（并发受限），拼出全市场快照 */
  const totalTasks = picked.length;
  let doneCount = 0;
  let prefixedCount = 0;
  const failed = [];

  progressInline('正在下载并解析官方数据文件：0 / ' + totalTasks);
  const got = await mapLimit(picked, opts.concurrency, async (item) => {
    const r = await fetchOfficialCoin(item.pair, date, kind).catch(() => null);
    doneCount += 1;
    progressInline('\r  正在下载并解析官方数据文件：' + doneCount + ' / ' + totalTasks +
      '（每个币 2–3 个文件）');
    if (!r || !r.coin) { failed.push(item.base); return null; }
    return { coin: r.coin, extras: r.extras, base: item.base };
  });
  progressInline('\n');

  got.forEach((r) => {
    if (!r) return;
    coins.push(r.coin);
    if (r.prefixed) prefixedCount += 1;
    if (r.extras && (Number.isFinite(r.extras.takerLongShort) || Number.isFinite(r.extras.toptraderLongShort))) {
      extrasList.push({
        symbol: r.coin.symbol,
        takerLongShort: r.extras.takerLongShort,
        toptraderLongShort: r.extras.toptraderLongShort,
      });
    }
  });

  /* 4) 与网页一致的僵尸合约过滤（成交额低于 20 万美元） */
  const beforeFilter = coins.length;
  coins = coins.filter((c) => Number.isFinite(c.quoteVolume) && c.quoteVolume >= MarketSnapshot.MIN_QUOTE_VOLUME);

  const withOi = coins.filter((c) => Number.isFinite(c.oiUsd)).length;
  const fallbackBase = coins.filter((c) => c._baseFrom === 'same-day-open').length;

  coins.forEach((c) => { delete c._baseFrom; });

  officialMeta = {
    date: date,
    universeFrom: universe.from,
    universeUrl: universe.url,
    requested: picked.length,
    parsed: beforeFilter,
    failed: failed.length,
    failedSample: failed.slice(0, 12),
    filteredOut: beforeFilter - coins.length,
    withOi: withOi,
    changeBaseFallback: fallbackBase,
    prefixedPairs: prefixedCount,
  };

  sourceInfo = {
    kind: 'official',
    label: '币安官方公开数据仓库（' + (kind === 'spot' ? '现货' : '合约') + ' K 线 + 指标，无需密钥）',
    url: officialKlineUrl(kind, probe, '1h', date),
  };

  if (!coins.length) {
    console.error('官方数据一个币都没解析成功：请检查网络，或换一个日期（--date）。');
    process.exit(1);
  }
} else if (opts.source === 'live' || opts.source === 'skill') {
  /* ---------- 通道：官方公开行情接口 / 官方技能（全市场现货快照） ---------- */

  /* 官方公开行情入口只提供现货市场：选了永续就自动切到现货，并如实说明 */
  if (opts.market !== 'spot') {
    opts.market = 'spot';
    opts.liveForcedSpot = true;
    say('说明：官方公开行情入口只提供现货市场，本次已自动切换到现货口径（与网页的永续口径不同）。');
    warnings.push('本通道为现货口径（官方公开行情入口只提供现货）；持仓量、换手强度这两个字段在现货里不存在，' +
      '引擎已按比例分摊权重，不是填了假数。');
  }

  let rows = null;
  let cmd = null;

  if (opts.source === 'skill') {
    say('通道：官方技能（Binance Skills Hub · binance 技能 → binance-cli）');
    say('说明：官方技能的市场行情命令无需鉴权；本通道只读行情，不涉及账户与交易。');
    try {
      const r = binanceCliTickerAll();
      rows = r.rows;
      cmd = r.cmd;
      say('命令：' + r.cmd);
      if (r.via === 'public') {
        say('说明：官方 CLI 的默认入口在本机网络下不可达，已改用官方为「仅公开行情」提供的独立入口（请求仍由官方 CLI 发起）。');
      }
    } catch (e) {
      say('binance-cli 调用失败（' + (e.message || e) + '），回退到官方公开行情接口。');
      opts.source = 'live';
      opts.skillFallback = true;
      opts.requestedSource = 'skill';
    }
  }

  /* 官方技能通道成功取到数据时（opts.source 仍为 skill），也要走同一套归一化 */
  if (opts.source === 'live' || (rows && rows.length)) {
    if (!rows) {
      say('通道：币安官方公开行情接口（data-api.binance.vision · 现货 · 无需密钥）');
      say('说明：该入口是币安为「仅需公开行情」场景提供的公开地址，不涉及账户信息；仅提供现货市场。');
      progressInline('正在拉取全市场现货快照…');
      coins = await fetchOfficialLiveSnapshot();
      progressInline(' 完成（' + coins.length + ' 个交易对）\n');
      sourceInfo = {
        kind: 'live',
        label: '币安官方公开行情接口（全市场现货快照）',
        url: BINANCE_PUBLIC_BASE + '/ticker/24hr',
      };
    } else {
      /* binance-cli 成功返回：按同一套口径归一化 */
      const out = [];
      const seen = new Set();
      rows.forEach((t) => {
        if (!t || !t.symbol) return;
        const sym = String(t.symbol);
        if (!sym.endsWith('USDT')) return;
        const base = sym.slice(0, -4);
        if (!base || seen.has(base)) return;
        const markPrice = Number(t.lastPrice);
        const quoteVolume = Number(t.quoteVolume);
        if (!Number.isFinite(markPrice) || markPrice <= 0) return;
        if (!Number.isFinite(quoteVolume) || quoteVolume < MarketSnapshot.MIN_QUOTE_VOLUME) return;
        const high = Number(t.highPrice);
        const low = Number(t.lowPrice);
        let volPct = null;
        if (Number.isFinite(high) && Number.isFinite(low) && low > 0 && high >= low) {
          volPct = ((high - low) / low) * 100;
        }
        seen.add(base);
        out.push({
          symbol: base,
          raw: sym,
          last: markPrice,
          markPrice: markPrice,
          changePct: Number.isFinite(Number(t.priceChangePercent)) ? Number(t.priceChangePercent) : null,
          quoteVolume: quoteVolume,
          oiUsd: null,
          turnover: null,
          volPct: volPct,
          fundingRate: null,
          fundingAnnual: null,
          fundingCycle: null,
        });
      });
      coins = out;
      sourceInfo = {
        kind: 'skill',
        label: '官方技能 binance-cli（Skills Hub · ' + cmd + '）',
        url: cmd.startsWith('binance-cli request')
          ? BINANCE_PUBLIC_BASE + '/ticker/24hr'
          : 'https://api.binance.com/api/v3/ticker/24hr',
      };
    }
  }
} else {
  /* ---------- 默认通道：实时多平台（与网页版完全一致） ---------- */
  say('通道：实时多平台公开行情（综合平台 USDT 永续合约 + 链上平台，与网页版完全一致）');

  let snap = null;
  let lastErr = null;
  progressInline('正在拉取全市场快照…');
  try {
    snap = await data.fetchSnapshot('cex');
  } catch (e) {
    lastErr = e;
    try {
      snap = await data.fetchSnapshot('onchain');
      warnings.push('综合平台接口本次不可用，已改用链上平台快照（波动幅度列会留空）。');
    } catch (e2) {
      progressInline('\n');
      console.error('取数失败：' + (lastErr && lastErr.message ? lastErr.message : '未知原因'));
      process.exit(1);
    }
  }
  progressInline(' 完成（' + snap.coins.length + ' 个合约）\n');
  coins = snap.coins;
  sourceInfo = {
    kind: 'realtime',
    label: '各大平台公开行情接口（' + snap.marketLabel + '）· 浏览器直连',
    url: null,
  };
}

/* ============================================================
 * 十二、与上次运行对比（持仓量变化、大饼占比变化）
 * ============================================================ */

const stateKey = 'src:v1:' + sourceInfo.kind + ':' + opts.market + ':' +
  (opts.source === 'official' ? (officialMeta ? officialMeta.date : 'date') : 'live');

let compare = null;
try {
  const raw = store0[stateKey];
  if (raw) {
    const prev = JSON.parse(raw);
    if (prev && (prev.oiBySymbol || Number.isFinite(prev.btcShare))) {
      compare = { btcShare: prev.btcShare, oiBySymbol: prev.oiBySymbol || {} };
    }
  }
} catch (e) {
  compare = null;
}

/* ============================================================
 * 十三、用与网页相同的引擎出结论
 * ============================================================ */

const res = HeatEngine.analyze(coins, compare);

/* 保存本次基线，供下次运行对比 */
const oiBySymbol = {};
coins.forEach((c) => {
  if (Number.isFinite(c.oiUsd) && c.oiUsd > 0) oiBySymbol[c.symbol] = c.oiUsd;
});
store0[stateKey] = JSON.stringify({
  at: Date.now(),
  btcShare: res.market.btcShare,
  oiBySymbol: oiBySymbol,
});
saveState();

/* ============================================================
 * 十四、输出
 * ============================================================ */

const sorted = res.coins.slice().sort((a, b) => {
  const x = Number.isFinite(a.heatScore) ? a.heatScore : -1;
  const y = Number.isFinite(b.heatScore) ? b.heatScore : -1;
  return y - x;
});
const HOT_N = 10;

const brief = (c) => ({
  symbol: c.symbol,
  sector: c.sectorName,
  heatScore: Number.isFinite(c.heatScore) ? Number(c.heatScore.toFixed(1)) : null,
  changePct: Number.isFinite(c.changePct) ? Number(c.changePct.toFixed(2)) : null,
  quoteVolume: Number.isFinite(c.quoteVolume) ? Math.round(c.quoteVolume) : null,
  oiUsd: Number.isFinite(c.oiUsd) ? Math.round(c.oiUsd) : null,
  turnover: Number.isFinite(c.turnover) ? Number(c.turnover.toFixed(3)) : null,
  volPct: Number.isFinite(c.volPct) ? Number(c.volPct.toFixed(2)) : null,
  oiChangePct: Number.isFinite(c.oiChangePct) ? Number(c.oiChangePct.toFixed(2)) : null,
});

const sectorBrief = (s) => ({
  key: s.key,
  name: s.name,
  count: s.count,
  weightedHeat: Number.isFinite(s.weightedHeat) ? Number(s.weightedHeat.toFixed(1)) : null,
  avgChange: Number.isFinite(s.avgChange) ? Number(s.avgChange.toFixed(2)) : null,
  quoteVolume: Math.round(s.quoteVolume || 0),
});

const payload = {
  ok: true,
  tool: '市场热度情绪智能体',
  source: sourceInfo.kind,
  requestedSource: opts.requestedSource || null,
  sourceLabel: sourceInfo.label,
  dataUrl: sourceInfo.url,
  market: opts.market,
  marketLabel: opts.market === 'spot' ? '现货' : 'USDT 永续合约',
  fetchedAt: Date.now(),
  official: officialMeta,
  coverage: {
    coinsAnalyzed: res.market.total,
    withOpenInterest: opts.source === 'official'
      ? (officialMeta ? officialMeta.withOi : null)
      : res.market.oiCount,
    withVolatility: res.coins.filter((c) => Number.isFinite(c.volPct)).length,
  },
  compareWithPrevious: compare
    ? { available: true, previousAt: (function () { try { return JSON.parse(store0[stateKey]).at; } catch (e) { return null; } })() }
    : { available: false, note: '首次运行或基线已清空：持仓量变化与占比变化需要两次运行' },
  mood: {
    level: res.mood.level,
    key: res.mood.key,
    name: res.mood.name,
    score: Number(res.mood.score.toFixed(1)),
    desc: res.mood.desc,
    parts: {
      breadthScore: Number(res.mood.parts.breadthScore.toFixed(1)),
      chgScore: Number(res.mood.parts.chgScore.toFixed(1)),
      hotScore: Number(res.mood.parts.hotScore.toFixed(1)),
      penalty: res.mood.parts.penalty,
      penaltyDetail: res.mood.parts.penaltyDetail,
    },
  },
  market: {
    total: res.market.total,
    advancers: res.market.advancers,
    decliners: res.market.decliners,
    flats: res.market.flats,
    breadth: Number.isFinite(res.market.breadth) ? Number(res.market.breadth.toFixed(4)) : null,
    wqChg: Number.isFinite(res.market.wqChg) ? Number(res.market.wqChg.toFixed(3)) : null,
    medianChg: Number.isFinite(res.market.medianChg) ? Number(res.market.medianChg.toFixed(3)) : null,
    totalQuoteVolume: Math.round(res.market.totalQuoteVolume || 0),
    totalOiUsd: res.market.totalOiUsd === null ? null : Math.round(res.market.totalOiUsd),
    btcShare: Number.isFinite(res.market.btcShare) ? Number(res.market.btcShare.toFixed(2)) : null,
    btcChange: Number.isFinite(res.market.btcChange) ? Number(res.market.btcChange.toFixed(2)) : null,
    hotRatio: Number.isFinite(res.market.hotRatio) ? Number(res.market.hotRatio.toFixed(4)) : null,
  },
  topHeat: sorted.slice(0, HOT_N).map(brief),
  bottomHeat: sorted.slice(-HOT_N).reverse().map(brief),
  sectors: {
    hot: res.hotSectors.map(sectorBrief),
    cold: res.coldSectors.map(sectorBrief),
    otherShare: Number.isFinite(res.otherShare) ? Number(res.otherShare.toFixed(2)) : null,
    total: res.sectors.length,
  },
  outflow: res.outflow.slice(0, 10).map((o) => ({
    symbol: o.symbol,
    sector: o.sectorName,
    changePct: Number(o.changePct.toFixed(2)),
    heatScore: Number.isFinite(o.heatScore) ? Number(o.heatScore.toFixed(1)) : null,
    score: Number(o.score.toFixed(1)),
    oiConfirmed: o.oiConfirmed,
    reasons: o.reasons,
  })),
  rotation: {
    dir: res.rotation.dir,
    label: res.rotation.label,
    confirmed: res.rotation.confirmed,
    rs: Number.isFinite(res.rotation.rs) ? Number(res.rotation.rs.toFixed(2)) : null,
    btcPerf: Number.isFinite(res.rotation.btcPerf) ? Number(res.rotation.btcPerf.toFixed(2)) : null,
    altPerf: Number.isFinite(res.rotation.altPerf) ? Number(res.rotation.altPerf.toFixed(2)) : null,
    btcShare: Number.isFinite(res.rotation.btcShare) ? Number(res.rotation.btcShare.toFixed(2)) : null,
    shareDelta: Number.isFinite(res.rotation.shareDelta) ? Number(res.rotation.shareDelta.toFixed(2)) : null,
    altScope: res.rotation.altScope,
  },
  officialExtras: extrasList.length
    ? {
        note: '官方合约指标文件附带的资金方向维度（主动买卖量比、大户多空比）。' +
          '这些维度不参与热度分数与情绪档位的计算，与网页版口径保持一致；仅作参考。',
        count: extrasList.length,
        items: extrasList.slice(0, 15),
      }
    : null,
  rules: res.rules,
  warnings: warnings,
  note: '本结果基于公开行情数据的程序化统计，仅用于市场风险观测与数据分析，不构成任何投资建议。',
};

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

/* ---------- 文本报告 ---------- */
const fmtMoney = MarketSnapshot.fmtMoney;
const fmtPct = MarketSnapshot.fmtPct;
const fmtTurnover = MarketSnapshot.fmtTurnover;
const line = '─'.repeat(60);

console.log('');
console.log(line);
console.log('  市场热度情绪智能体 · ' +
  (opts.market === 'spot' ? '现货' : 'USDT 永续合约') + ' 全市场横截面');
console.log(line);
console.log('  数据通道：' + sourceInfo.label);
if (officialMeta) {
  console.log('  数据日期：' + officialMeta.date + '（UTC）');
  console.log('  币种名单：' + officialMeta.universeFrom);
}
console.log('');
console.log('  市场情绪    ' + res.mood.name + '　（情绪指数 ' + res.mood.score.toFixed(1) + ' / 100）');
console.log('  ' + res.mood.desc);
console.log('');
console.log('  全市场概览');
console.log('    参与统计合约    ' + res.market.total + ' 个' +
  (res.market.oiCount ? '（其中 ' + res.market.oiCount + ' 个带持仓量）' : '（本通道不含持仓量）'));
console.log('    全市场成交额    ' + fmtMoney(res.market.totalQuoteVolume) + '（24h）');
if (res.market.totalOiUsd !== null) {
  console.log('    全市场持仓量    ' + fmtMoney(res.market.totalOiUsd));
}
console.log('    上涨 / 下跌     ' + res.market.advancers + ' / ' + res.market.decliners +
  '（上涨占比 ' + (Number.isFinite(res.market.breadth) ? (res.market.breadth * 100).toFixed(1) + '%' : '—') + '）');
console.log('    成交额加权涨跌  ' + fmtPct(res.market.wqChg));
console.log('    涨跌中位数      ' + fmtPct(res.market.medianChg));
console.log('    大饼成交额占比  ' + (Number.isFinite(res.market.btcShare) ? res.market.btcShare.toFixed(2) + '%' : '—'));
console.log('    高热度币种占比  ' + (Number.isFinite(res.market.hotRatio) ? (res.market.hotRatio * 100).toFixed(1) + '%' : '—') +
  '（热度 ≥ ' + HeatEngine.HOT_SCORE_LINE + ' 记为一个）');
if (res.mood.parts.penaltyDetail.length) {
  res.mood.parts.penaltyDetail.forEach((d) => console.log('    避险扣分        ' + d));
}
console.log('');

const padName = (s, n) => {
  const str = String(s);
  let w = 0;
  for (let i = 0; i < str.length; i++) w += str.charCodeAt(i) > 255 ? 2 : 1;
  return str + ' '.repeat(Math.max(0, n - w));
};

function printRank(title, list) {
  console.log('  ' + title);
  console.log('    ' + padName('#', 4) + padName('币种', 10) + padName('赛道', 20) +
    padName('热度', 7) + padName('24h 涨跌', 11) + padName('24h 成交额', 14) + '换手强度');
  list.forEach((c, i) => {
    console.log('    ' + padName(String(i + 1), 4) + padName(c.symbol, 10) +
      padName(c.sectorName, 20) +
      padName(Number.isFinite(c.heatScore) ? c.heatScore.toFixed(1) : '—', 7) +
      padName(fmtPct(c.changePct), 11) +
      padName(fmtMoney(c.quoteVolume), 14) +
      fmtTurnover(c.turnover));
  });
  console.log('');
}

printRank('热度最高的 10 个币', sorted.slice(0, HOT_N));
printRank('热度最低的 10 个币', sorted.slice(-HOT_N).reverse());

console.log('  资金出逃警示（跌幅 ≤ −4.5% ＋ 成交额排名前 40% ＋ 换手强度排名前 40%）');
if (!res.outflow.length) {
  console.log('    本次快照没有币种同时满足三条条件。');
} else {
  console.log('    ' + padName('币种', 10) + padName('赛道', 20) + padName('24h 涨跌', 11) +
    padName('成交额', 14) + padName('换手', 9) + padName('评分', 8) + '持仓量确认');
  res.outflow.slice(0, 10).forEach((o) => {
    const oiTxt = o.oiConfirmed === true ? '持仓量下降（已确认）'
      : o.oiConfirmed === null ? '待下一次运行确认' : '持仓量未下降';
    console.log('    ' + padName(o.symbol, 10) + padName(o.sectorName, 20) +
      padName(fmtPct(o.changePct), 11) + padName(fmtMoney(o.quoteVolume), 14) +
      padName(fmtTurnover(o.turnover), 9) + padName(o.score.toFixed(1), 8) + oiTxt);
  });
}
console.log('');

const rot = res.rotation;
console.log('  资金轮动');
console.log('    结论：' + rot.label +
  (rot.confirmed === true ? '（占比变化与超额表现一致，已确认）'
    : rot.confirmed === false ? '（占比变化与超额表现不一致，未确认）'
      : rot.confirmed === null && Number.isFinite(rot.shareDelta) ? '（占比变化方向与超额表现不一致，未确认）'
        : '（占比变化需要两次运行才能得出）'));
console.log('    大饼表现        ' + fmtPct(rot.btcPerf));
console.log('    小币组表现      ' + fmtPct(rot.altPerf) + '　' + rot.altScope);
console.log('    超额表现        ' + (Number.isFinite(rot.rs) ? (rot.rs > 0 ? '+' : '') + rot.rs.toFixed(2) + ' 个百分点（大饼 − 小币组）' : '—'));
console.log('    大饼成交额占比  ' + (Number.isFinite(rot.btcShare) ? rot.btcShare.toFixed(2) + '%' : '—') +
  (Number.isFinite(rot.shareDelta) ? '　（本次会话变化 ' + (rot.shareDelta > 0 ? '+' : '') + rot.shareDelta.toFixed(2) + ' 个百分点）' : '　（需要两次运行才能得出变化）'));
console.log('');

console.log('  赛道冷热（按赛道内成交额加权的平均热度）');
const secTxt = (list) => list.length
  ? list.map((s) => s.name + '（' + (Number.isFinite(s.weightedHeat) ? s.weightedHeat.toFixed(1) : '—') + '）').join(' · ')
  : '样本不足';
console.log('    热门：' + secTxt(res.hotSectors));
console.log('    冷门：' + secTxt(res.coldSectors));
if (Number.isFinite(res.otherShare)) {
  console.log('    未收录归入「其他」的成交额占比：' + res.otherShare.toFixed(2) +
    '%（内置赛道表收录 ' + SectorDB.mappedCount() + ' 个币种）');
}
console.log('');

if (extrasList.length) {
  console.log('  官方通道独有维度（不参与热度分数与情绪档位，仅作参考）');
  console.log('    ' + padName('币种', 10) + padName('主动买卖量比', 16) + '大户多空比');
  extrasList.slice(0, 10).forEach((e) => {
    console.log('    ' + padName(e.symbol, 10) +
      padName(Number.isFinite(e.takerLongShort) ? e.takerLongShort.toFixed(3) : '—', 16) +
      (Number.isFinite(e.toptraderLongShort) ? e.toptraderLongShort.toFixed(3) : '—'));
  });
  console.log('    说明：来自官方合约指标文件的最后一条（5 分钟粒度）。');
  console.log('          主动买卖量比 > 1 表示主动买量占优；大户多空比 > 1 表示大户偏多。');
  console.log('');
}

if (officialMeta) {
  console.log('  数据质量（官方通道）');
  console.log('    官方文件解析成功：' + officialMeta.parsed + ' 个' +
    '（请求名单 ' + officialMeta.requested + ' 个）');
  console.log('    纳入统计：' + res.market.total + ' 个' +
    '（剔除成交额低于 20 万美元的僵尸合约 ' + officialMeta.filteredOut + ' 个，与网页同一口径）');
  if (officialMeta.prefixedPairs > 0) {
    console.log('    使用官方「面值币」代码对应：' + officialMeta.prefixedPairs +
      ' 个（例如 PEPE 的官方合约文件实际是 1000PEPEUSDT，已自动对应）');
  }
  if (officialMeta.failed > 0) {
    console.log('    官方仓库无对应文件（未纳入）：' + officialMeta.failed + ' 个' +
      (officialMeta.failedSample.length ? '，例如 ' + officialMeta.failedSample.join('、') : ''));
  }
  if (officialMeta.changeBaseFallback > 0) {
    console.log('    涨跌幅基准退回当日开盘价：' + officialMeta.changeBaseFallback +
      ' 个（前一日文件缺失，已在口径上如实降级）');
  }
  console.log('');
}

warnings.forEach((w) => console.log('  提醒：' + w));

console.log(line);
console.log('  说明：本结果基于公开行情数据的程序化统计，仅用于市场风险观测与数据分析，');
console.log('        不构成任何投资建议。热度分数衡量的是当期资金参与程度，不是价格预测。');
console.log(line);
console.log('');
process.exit(0);
