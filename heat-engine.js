/* =========================================================================
   heat-engine.js —— 热度算法引擎（纯计算，不发任何网络请求）
   -------------------------------------------------------------------------
   输入：market-snapshot.js 归一化之后的全市场币种数组
   输出：
     · 个币热度分数（0–100）
     · 市场情绪五档（狂热 / 活跃 / 中性 / 低迷 / 恐慌）
     · 赛道冷热（热门赛道 / 冷门赛道）
     · 资金出逃币种
     · 资金轮动方向（大饼 ↔ 小币）
   所有阈值都定义在本文件顶部的常量里，方便后续按真实行情校准。
   ========================================================================= */

window.HeatEngine = (function () {
  'use strict';

  /* =======================================================================
     一、可调参数（全部集中在这里，改参数不用翻代码）
     ======================================================================= */

  /* 个币热度分数的四项权重，合计必须为 1 */
  var HEAT_WEIGHTS = {
    change: 0.30,    /* 24 小时涨跌幅 */
    volume: 0.30,    /* 24 小时成交额（先取对数再排名） */
    turnover: 0.20,  /* 换手强度 = 成交额 ÷ 持仓量 */
    volatility: 0.20 /* 波动幅度 */
  };

  /* 换手强度排名前先做极值裁剪的分位区间，避免个别异常值把分布压扁 */
  var TURNOVER_CLIP = { low: 0.05, high: 0.95 };

  /* 涨跌平盘的死区：涨跌幅在 ±0.1% 以内视为平盘，不计入上涨也不计入下跌 */
  var FLAT_BAND = 0.1;

  /* 情绪指数三项权重的权重（合成后再做避险扣分） */
  var MOOD_WEIGHTS = { breadth: 0.40, change: 0.30, hot: 0.30 };

  /* 「高热度币种」的门槛 */
  var HOT_SCORE_LINE = 70;

  /* 资金过度集中在大饼时的避险扣分 */
  var HAVEN_PENALTY = [
    { share: 60, penalty: 8 },
    { share: 70, penalty: 6 }
  ];

  /* 情绪五档的分档线（分数越高越热） */
  var MOOD_LEVELS = [
    { level: 1, key: 'mania',   name: '狂热', min: 78, color: '#dc2626',
      desc: '多数币种上涨、高热度币种占比较高，市场处于普遍亢奋状态，需要留意过热风险。' },
    { level: 2, key: 'active',  name: '活跃', min: 65, color: '#f97316',
      desc: '上涨家数明显占优，成交与换手同步抬升，市场情绪偏积极。' },
    { level: 3, key: 'neutral', name: '中性', min: 45, color: '#64748b',
      desc: '涨跌家数接近，资金分散在个别方向，整体没有形成一致预期。' },
    { level: 4, key: 'quiet',   name: '低迷', min: 30, color: '#0891b2',
      desc: '下跌家数偏多、成交收缩，市场参与意愿下降，方向尚未明朗。' },
    { level: 5, key: 'panic',   name: '恐慌', min: 0,  color: '#15803d',
      desc: '多数币种下跌且高热度币种稀少，抛压集中释放，需要优先控制风险。' }
  ];

  /* 资金出逃的三条横截面条件 */
  var OUTFLOW_RULE = {
    maxDrop: -4.5,      /* 跌幅不高于 −4.5% */
    minVolRank: 0.60,   /* 成交额排名进全市场前 40% */
    minTurnRank: 0.60,  /* 换手强度排名进全市场前 40% */
    oiDropLine: -3.0    /* 会话内持仓量下降超过 3%（有基线时才参与判断） */
  };

  /* 资金轮动的超额表现阈值（百分点） */
  var ROTATION_LINE = 1.5;

  /* 小币组的成交额排名区间（第 21 名到第 100 名，避开头部大币） */
  var ALT_GROUP = { from: 20, to: 100 };

  /* 参与赛道冷热排名的赛道，至少要有这么多个币种，避免小样本误判 */
  var SECTOR_MIN_COINS = 3;

  /* 热度色阶：冷（蓝）→ 中性（浅灰）→ 热（红） */
  var HEAT_STOPS = [
    { p: 0,   c: [14, 165, 233] },
    { p: 25,  c: [56, 189, 248] },
    { p: 45,  c: [203, 213, 225] },
    { p: 55,  c: [226, 232, 240] },
    { p: 72,  c: [251, 146, 60] },
    { p: 100, c: [220, 38, 38] }
  ];

  /* =======================================================================
     二、通用小工具
     ======================================================================= */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* 把一组数字排序后取分位数（q 取 0–1） */
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q;
    var base = Math.floor(pos);
    var rest = pos - base;
    if (sorted[base + 1] !== undefined) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
  }

  /* 按取值大小给出 0–1 的百分位排名；取不到值的返回 null
     取值相同时按并列处理（相同值得到相同排名） */
  function buildRanks(coins, getter) {
    var pairs = [];
    for (var i = 0; i < coins.length; i++) {
      var v = getter(coins[i]);
      if (isNum(v)) pairs.push({ i: i, v: v });
    }
    pairs.sort(function (a, b) { return a.v - b.v; });

    var ranks = new Array(coins.length);
    for (var k = 0; k < ranks.length; k++) ranks[k] = null;
    var n = pairs.length;
    if (!n) return ranks;
    if (n === 1) { ranks[pairs[0].i] = 0.5; return ranks; }

    var k2 = 0;
    while (k2 < n) {
      var j = k2;
      while (j + 1 < n && pairs[j + 1].v === pairs[k2].v) j++;
      var rank = ((k2 + j) / 2) / (n - 1);
      for (var m = k2; m <= j; m++) ranks[pairs[m].i] = rank;
      k2 = j + 1;
    }
    return ranks;
  }

  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /* 热度分数 → 颜色（用于赛道矩阵方块） */
  function heatColor(score) {
    var p = clamp(isNum(score) ? score : 0, 0, 100);
    var a = HEAT_STOPS[0], b = HEAT_STOPS[HEAT_STOPS.length - 1];
    for (var i = 0; i < HEAT_STOPS.length - 1; i++) {
      if (p >= HEAT_STOPS[i].p && p <= HEAT_STOPS[i + 1].p) {
        a = HEAT_STOPS[i]; b = HEAT_STOPS[i + 1]; break;
      }
    }
    var span = b.p - a.p;
    var t = span > 0 ? (p - a.p) / span : 0;
    var rgb = [0, 1, 2].map(function (idx) {
      return Math.round(a.c[idx] + (b.c[idx] - a.c[idx]) * t);
    });
    /* 用相对亮度判断是否需要改成深色文字 */
    var lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return {
      bg: 'rgb(' + rgb.join(',') + ')',
      lightText: lum > 0.62
    };
  }

  /* 成交额加权涨跌幅的分数映射（分段线性插值） */
  function changeScoreOf(v) {
    if (!isNum(v)) return 50;
    var pts = [[-3, 0], [-1.5, 20], [0, 50], [1.5, 80], [3, 100]];
    if (v <= pts[0][0]) return 0;
    if (v >= pts[pts.length - 1][0]) return 100;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      if (v >= a[0] && v <= b[0]) {
        var t = (v - a[0]) / (b[0] - a[0]);
        return a[1] + t * (b[1] - a[1]);
      }
    }
    return 50;
  }

  function moodOf(score) {
    for (var i = 0; i < MOOD_LEVELS.length; i++) {
      if (score >= MOOD_LEVELS[i].min) return MOOD_LEVELS[i];
    }
    return MOOD_LEVELS[MOOD_LEVELS.length - 1];
  }

  /* =======================================================================
     三、主流程
     ======================================================================= */

  /**
   * @param {Array} coins  归一化后的全市场币种数组
   * @param {Object|null} compare  上一次快照的对比数据：
   *        { btcShare:Number, oiBySymbol:{代码:持仓量美元值} }
   * @returns {Object} 分析结果
   */
  function analyze(coins, compare) {
    var list = Array.isArray(coins) ? coins.slice() : [];
    var cmp = compare || {};
    var oiBase = cmp.oiBySymbol || {};

    /* ---------- 3.1 四项分位排名 ---------- */
    var rankChange = buildRanks(list, function (c) { return c.changePct; });
    var rankVolume = buildRanks(list, function (c) {
      return isNum(c.quoteVolume) ? Math.log10(c.quoteVolume + 1) : null;
    });

    /* 换手强度先裁剪再排名 */
    var turnoverVals = [];
    for (var i = 0; i < list.length; i++) {
      if (isNum(list[i].turnover)) turnoverVals.push(list[i].turnover);
    }
    turnoverVals.sort(function (a, b) { return a - b; });
    var tLow = quantile(turnoverVals, TURNOVER_CLIP.low);
    var tHigh = quantile(turnoverVals, TURNOVER_CLIP.high);
    var turnoverClipped = new Array(list.length);
    for (var j = 0; j < list.length; j++) {
      var tv = list[j].turnover;
      turnoverClipped[j] = isNum(tv) && isNum(tLow) && isNum(tHigh)
        ? clamp(tv, tLow, tHigh)
        : (isNum(tv) ? tv : null);
    }
    var rankTurnover = buildRanks(
      turnoverClipped.map(function (v) { return { v: v }; }),
      function (o) { return o.v; }
    );
    var rankVolatility = buildRanks(list, function (c) { return c.volPct; });

    /* ---------- 3.2 个币热度分数 ---------- */
    var scored = [];
    for (var k = 0; k < list.length; k++) {
      var c = list[k];
      var sector = window.SectorDB.getSector(c.symbol);

      /* 有效分量才参与加权，缺失的分量把权重按比例分给其余分量 */
      var parts = [
        { w: HEAT_WEIGHTS.change, r: rankChange[k] },
        { w: HEAT_WEIGHTS.volume, r: rankVolume[k] },
        { w: HEAT_WEIGHTS.turnover, r: rankTurnover[k] },
        { w: HEAT_WEIGHTS.volatility, r: rankVolatility[k] }
      ];
      var totalW = 0, acc = 0;
      for (var p = 0; p < parts.length; p++) {
        if (isNum(parts[p].r)) { totalW += parts[p].w; acc += parts[p].w * parts[p].r; }
      }
      var heatScore = totalW > 0 ? (acc / totalW) * 100 : null;

      /* 会话内持仓量变化 */
      var oiChangePct = null;
      var baseOi = oiBase[c.symbol];
      if (isNum(baseOi) && baseOi > 0 && isNum(c.oiUsd)) {
        oiChangePct = ((c.oiUsd - baseOi) / baseOi) * 100;
      }

      scored.push({
        symbol: c.symbol,
        raw: c.raw,
        sectorKey: sector.key,
        sectorName: sector.name,
        sectorColor: sector.color,
        last: c.last,
        markPrice: c.markPrice,
        changePct: c.changePct,
        quoteVolume: c.quoteVolume,
        oiUsd: c.oiUsd,
        turnover: c.turnover,
        volPct: c.volPct,
        fundingAnnual: c.fundingAnnual,
        fundingCycle: c.fundingCycle,
        oiChangePct: oiChangePct,
        heatScore: heatScore,
        ranks: {
          change: rankChange[k],
          volume: rankVolume[k],
          turnover: rankTurnover[k],
          volatility: rankVolatility[k]
        }
      });
    }

    /* ---------- 3.3 市场整体统计 ---------- */
    var total = scored.length;
    var advancers = 0, decliners = 0, flats = 0;
    var chgList = [], volSum = 0, chgVolSum = 0, oiSum = 0, oiCount = 0;
    var hotCount = 0;
    var btc = null;

    for (var s = 0; s < scored.length; s++) {
      var it = scored[s];
      if (isNum(it.changePct)) {
        chgList.push(it.changePct);
        if (it.changePct > FLAT_BAND) advancers++;
        else if (it.changePct < -FLAT_BAND) decliners++;
        else flats++;
      } else {
        flats++;
      }
      if (isNum(it.quoteVolume)) {
        volSum += it.quoteVolume;
        if (isNum(it.changePct)) chgVolSum += it.quoteVolume * it.changePct;
      }
      if (isNum(it.oiUsd)) { oiSum += it.oiUsd; oiCount++; }
      if (isNum(it.heatScore) && it.heatScore >= HOT_SCORE_LINE) hotCount++;
      if (it.symbol === 'BTC') btc = it;
    }

    var breadth = total > 0 ? advancers / total : null;
    var wqChg = volSum > 0 ? chgVolSum / volSum : null;
    var medianChg = median(chgList);
    var hotRatio = total > 0 ? hotCount / total : null;
    var btcShare = (btc && isNum(btc.quoteVolume) && volSum > 0)
      ? (btc.quoteVolume / volSum) * 100 : null;

    /* ---------- 3.4 情绪指数与五档 ---------- */
    var breadthScore = isNum(breadth) ? breadth * 100 : 50;
    var chgScore = changeScoreOf(wqChg);
    var hotScore = isNum(hotRatio) ? hotRatio * 100 : 0;

    var penalty = 0, penaltyDetail = [];
    if (isNum(btcShare)) {
      for (var h = 0; h < HAVEN_PENALTY.length; h++) {
        if (btcShare >= HAVEN_PENALTY[h].share) {
          penalty += HAVEN_PENALTY[h].penalty;
          penaltyDetail.push('大饼成交额占比 ≥ ' + HAVEN_PENALTY[h].share + '%，扣 ' + HAVEN_PENALTY[h].penalty + ' 分');
        }
      }
    }

    var moodScore = clamp(
      MOOD_WEIGHTS.breadth * breadthScore +
      MOOD_WEIGHTS.change * chgScore +
      MOOD_WEIGHTS.hot * hotScore -
      penalty,
      0, 100
    );
    var mood = moodOf(moodScore);

    /* ---------- 3.5 赛道聚合 ---------- */
    var sectorBuckets = Object.create(null);
    for (var b = 0; b < scored.length; b++) {
      var coin = scored[b];
      if (!sectorBuckets[coin.sectorKey]) {
        sectorBuckets[coin.sectorKey] = {
          key: coin.sectorKey,
          name: coin.sectorName,
          color: coin.sectorColor,
          coins: [],
          quoteVolume: 0,
          heatVolSum: 0,
          chgVolSum: 0
        };
      }
      var bucket = sectorBuckets[coin.sectorKey];
      bucket.coins.push(coin);
      if (isNum(coin.quoteVolume)) bucket.quoteVolume += coin.quoteVolume;
      if (isNum(coin.heatScore) && isNum(coin.quoteVolume)) {
        bucket.heatVolSum += coin.heatScore * coin.quoteVolume;
        sectorBuckets[coin.sectorKey].chgVolSum += coin.quoteVolume;
      }
    }

    var sectorList = [];
    Object.keys(sectorBuckets).forEach(function (key) {
      var bk = sectorBuckets[key];
      /* 赛道热度 = 赛道内按成交额加权的平均热度分数 */
      var weightedHeat = bk.chgVolSum > 0 ? bk.heatVolSum / bk.chgVolSum : null;
      var simpleHeat = bk.coins.length
        ? bk.coins.reduce(function (a, c2) { return a + (isNum(c2.heatScore) ? c2.heatScore : 0); }, 0) / bk.coins.length
        : null;
      var chgSum = 0, chgCnt = 0;
      bk.coins.forEach(function (c3) {
        if (isNum(c3.changePct)) { chgSum += c3.changePct; chgCnt++; }
      });
      bk.coins.sort(function (x, y) {
        return (isNum(y.heatScore) ? y.heatScore : -1) - (isNum(x.heatScore) ? x.heatScore : -1);
      });
      sectorList.push({
        key: bk.key,
        name: bk.name,
        color: bk.color,
        count: bk.coins.length,
        quoteVolume: bk.quoteVolume,
        weightedHeat: weightedHeat,
        simpleHeat: simpleHeat,
        avgChange: chgCnt ? chgSum / chgCnt : null,
        coins: bk.coins,
        isOther: bk.key === 'other'
      });
    });

    var rankable = sectorList.filter(function (x) {
      return x.count >= SECTOR_MIN_COINS && isNum(x.weightedHeat);
    });
    var descByHeat = rankable.slice().sort(function (a, b2) { return b2.weightedHeat - a.weightedHeat; });
    var hotSectors = descByHeat.slice(0, 3);
    var coldSectors = descByHeat.slice(-3).reverse();

    var otherVolume = 0;
    for (var o = 0; o < sectorList.length; o++) {
      if (sectorList[o].isOther) otherVolume = sectorList[o].quoteVolume;
    }
    var otherShare = volSum > 0 ? (otherVolume / volSum) * 100 : 0;

    /* ---------- 3.6 资金出逃 ---------- */
    var outflow = [];
    for (var f = 0; f < scored.length; f++) {
      var o2 = scored[f];
      if (!isNum(o2.changePct) || o2.changePct > OUTFLOW_RULE.maxDrop) continue;
      if (!isNum(o2.ranks.volume) || o2.ranks.volume < OUTFLOW_RULE.minVolRank) continue;
      if (!isNum(o2.ranks.turnover) || o2.ranks.turnover < OUTFLOW_RULE.minTurnRank) continue;

      /* 有会话基线时，持仓量下降作为增强条件参与评分 */
      var oiOk = isNum(o2.oiChangePct) ? o2.oiChangePct <= OUTFLOW_RULE.oiDropLine : null;
      var dropRank = isNum(o2.changePct) ? 1 - clamp((o2.changePct - OUTFLOW_RULE.maxDrop) / 10, 0, 1) : 0;
      var score = clamp(
        0.5 * (isNum(o2.ranks.turnover) ? o2.ranks.turnover : 0) * 100 +
        0.5 * (50 + dropRank * 50),
        0, 100
      );
      if (oiOk === true) score = clamp(score + 6, 0, 100);

      var reasons = [];
      reasons.push('24 小时跌幅 ' + o2.changePct.toFixed(2) + '%');
      reasons.push('成交额排名全市场前 ' + Math.round((1 - o2.ranks.volume) * 100) + '%');
      reasons.push('换手强度排名全市场前 ' + Math.round((1 - o2.ranks.turnover) * 100) + '%');
      if (oiOk === true) reasons.push('会话内持仓量下降 ' + Math.abs(o2.oiChangePct).toFixed(2) + '%');
      else if (oiOk === null) reasons.push('持仓量变化等待下一次刷新');

      outflow.push({
        symbol: o2.symbol,
        sectorName: o2.sectorName,
        changePct: o2.changePct,
        quoteVolume: o2.quoteVolume,
        turnover: o2.turnover,
        heatScore: o2.heatScore,
        oiChangePct: o2.oiChangePct,
        oiConfirmed: oiOk,
        score: score,
        reasons: reasons
      });
    }
    outflow.sort(function (a, b3) { return b3.score - a.score; });

    /* ---------- 3.7 资金轮动（大饼 ↔ 小币） ---------- */
    var byVolume = scored.filter(function (c4) { return isNum(c4.quoteVolume); })
      .sort(function (a, b4) { return b4.quoteVolume - a.quoteVolume; });
    var altGroup = byVolume.slice(ALT_GROUP.from, ALT_GROUP.to);

    var altVolSum = 0, altChgSum = 0;
    for (var g = 0; g < altGroup.length; g++) {
      if (isNum(altGroup[g].changePct)) {
        altVolSum += altGroup[g].quoteVolume;
        altChgSum += altGroup[g].quoteVolume * altGroup[g].changePct;
      }
    }
    var altPerf = altVolSum > 0 ? altChgSum / altVolSum : null;
    var btcPerf = btc && isNum(btc.changePct) ? btc.changePct : null;

    var rs = (isNum(btcPerf) && isNum(altPerf)) ? btcPerf - altPerf : null;
    var shareDelta = (isNum(btcShare) && isNum(cmp.btcShare)) ? btcShare - cmp.btcShare : null;

    var rotDir = 'flat';
    if (isNum(rs)) {
      if (rs > ROTATION_LINE) rotDir = 'to-btc';
      else if (rs < -ROTATION_LINE) rotDir = 'to-alt';
    }
    /* 占比变化方向是否与超额表现一致（一致才算「已确认」） */
    var rotConfirmed = null;
    if (isNum(shareDelta) && rotDir !== 'flat') {
      rotConfirmed = (rotDir === 'to-btc' && shareDelta > 0) || (rotDir === 'to-alt' && shareDelta < 0);
    }

    var rotLabel;
    if (rotDir === 'to-btc') rotLabel = '资金回流大饼';
    else if (rotDir === 'to-alt') rotLabel = '资金轮动到小币';
    else rotLabel = '轮动平稳 · 方向不明';

    /* 指针位置：rs 为正（大饼更强）→ 指针偏左；为负 → 偏右 */
    var pointerPct = 50;
    if (isNum(rs)) pointerPct = 50 - clamp(rs / 4, -1, 1) * 50;

    var rotation = {
      dir: rotDir,
      label: rotLabel,
      confirmed: rotConfirmed,
      rs: rs,
      btcPerf: btcPerf,
      altPerf: altPerf,
      btcShare: btcShare,
      shareDelta: shareDelta,
      altCount: altGroup.length,
      altScope: altGroup.length
        ? ('成交额第 ' + (ALT_GROUP.from + 1) + '–' + (ALT_GROUP.from + altGroup.length) + ' 名，共 ' + altGroup.length + ' 个')
        : '样本不足',
      pointerPct: pointerPct
    };

    /* ---------- 3.8 汇总返回 ---------- */
    return {
      coins: scored,
      market: {
        total: total,
        advancers: advancers,
        decliners: decliners,
        flats: flats,
        breadth: breadth,
        wqChg: wqChg,
        medianChg: medianChg,
        avgChg: chgList.length ? chgList.reduce(function (a, b5) { return a + b5; }, 0) / chgList.length : null,
        totalQuoteVolume: volSum,
        totalOiUsd: oiCount ? oiSum : null,
        oiCount: oiCount,
        btcShare: btcShare,
        btcChange: btcPerf,
        hotRatio: hotRatio,
        hotCount: hotCount
      },
      mood: {
        level: mood.level,
        key: mood.key,
        name: mood.name,
        color: mood.color,
        desc: mood.desc,
        score: moodScore,
        parts: {
          breadthScore: breadthScore,
          chgScore: chgScore,
          hotScore: hotScore,
          penalty: penalty,
          penaltyDetail: penaltyDetail,
          breadth: breadth,
          wqChg: wqChg,
          hotRatio: hotRatio,
          btcShare: btcShare
        }
      },
      sectors: sectorList,
      hotSectors: hotSectors,
      coldSectors: coldSectors,
      otherShare: otherShare,
      outflow: outflow,
      rotation: rotation,
      rules: {
        heatWeights: HEAT_WEIGHTS,
        outFlow: OUTFLOW_RULE,
        rotationLine: ROTATION_LINE,
        hotLine: HOT_SCORE_LINE,
        flatBand: FLAT_BAND,
        sectorMinCoins: SECTOR_MIN_COINS
      }
    };
  }

  return {
    analyze: analyze,
    heatColor: heatColor,
    moodOf: moodOf,
    changeScoreOf: changeScoreOf,
    MOOD_LEVELS: MOOD_LEVELS,
    HEAT_WEIGHTS: HEAT_WEIGHTS,
    OUTFLOW_RULE: OUTFLOW_RULE,
    HOT_SCORE_LINE: HOT_SCORE_LINE,
    FLAT_BAND: FLAT_BAND
  };
})();
