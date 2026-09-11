/* =========================================================================
   sectors.js —— 内置「币种 → 赛道」映射表
   -------------------------------------------------------------------------
   为什么需要内置一张表：
   公开行情接口只提供价格、成交额、持仓量这类数字，不提供「这个币属于哪个赛道」。
   所以赛道分类由项目自己维护一张映射表，按成交额收录市场主流币种。
   表里没有的币种统一归入「其他」，页面会如实披露「其他」占了多少成交额。
   ========================================================================= */

window.SectorDB = (function () {
  'use strict';

  /* 赛道定义：顺序即为页面上的展示顺序 */
  var SECTORS = [
    { key: 'infra',   name: '公链与基础设施', color: '#4f46e5' },
    { key: 'l2',      name: '二层与扩容',     color: '#7c3aed' },
    { key: 'defi',    name: 'DeFi 协议',      color: '#0891b2' },
    { key: 'oracle',  name: '预言机与中间件', color: '#0d9488' },
    { key: 'meme',    name: 'MEME 文化',      color: '#f59e0b' },
    { key: 'ai',      name: 'AI 与算力',      color: '#db2777' },
    { key: 'game',    name: '游戏与元宇宙',   color: '#8b5cf6' },
    { key: 'storage', name: '存储与数据',     color: '#0284c7' },
    { key: 'bridge',  name: '跨链与桥',       color: '#14b8a6' },
    { key: 'payment', name: '支付与结算',     color: '#2563eb' },
    { key: 'privacy', name: '隐私加固',       color: '#475569' },
    { key: 'fork',    name: '老牌分叉币',     color: '#a16207' }
  ];

  /* 归入「其他」的兜底赛道 */
  var OTHER = { key: 'other', name: '其他', color: '#94a3b8' };

  /* ---------------------------------------------------------------------
     币种清单：一个赛道一组，数组里写币种代码（大写，不带 USDT 后缀）
     说明：同一项目出现多个代码时（改名或新旧并存）都写进来，命中任意一个即可。
     --------------------------------------------------------------------- */
  var GROUPS = {

    /* 公链与基础设施：主链、基础层、通用结算层 */
    infra: [
      'BTC', 'ETH', 'BNB', 'SOL', 'ADA', 'AVAX', 'DOT', 'ATOM', 'NEAR', 'APT',
      'SUI', 'TON', 'TRX', 'ETC', 'ICP', 'EGLD', 'HBAR', 'SEI', 'TIA', 'INJ',
      'KAS', 'XTZ', 'NEO', 'EOS', 'IOTA', 'KAVA', 'CELO', 'ROSE', 'ONE', 'FLOW',
      'ASTR', 'CFX', 'KSM', 'QTUM', 'ZIL', 'S', 'FTM', 'OSMO', 'MINA', 'ALGO',
      'XLM', 'VET', 'XRP', 'GRASS', 'BERA', 'MOVE', 'HYPE'
    ],

    /* 二层与扩容：以太坊二层、模块化扩容方案 */
    l2: [
      'ARB', 'OP', 'POL', 'MATIC', 'STRK', 'ZK', 'MANTA', 'METIS', 'BLAST',
      'IMX', 'LRC', 'BOBA', 'TAIKO', 'LINEA', 'SCROLL', 'CTX', 'CELR'
    ],

    /* DeFi 协议：去中心化交易所、借贷、衍生品、流动性质押 */
    defi: [
      'UNI', 'AAVE', 'MKR', 'CRV', 'LDO', 'COMP', 'SNX', 'SUSHI', '1INCH',
      'BAL', 'YFI', 'CAKE', 'DYDX', 'GMX', 'JUP', 'RAY', 'PENDLE', 'ENA',
      'ETHFI', 'EIGEN', 'ONDO', 'JTO', 'PERP', 'RUNE', 'OM', 'AERO', 'MORPHO',
      'KMNO', 'SYRUP', 'SKY', 'USUAL', 'LISTA', 'BABYLON'
    ],

    /* 预言机与中间件：价格馈送、索引、数据服务 */
    oracle: [
      'LINK', 'PYTH', 'BAND', 'API3', 'TRB', 'GRT', 'DIA', 'UMA', 'RED'
    ],

    /* MEME 文化：社区驱动型代币 */
    meme: [
      'DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'MEME', 'ORDI', 'SATS',
      'RATS', 'MOG', 'POPCAT', 'BRETT', 'TURBO', 'BOME', 'PNUT', 'GOAT', 'ACT',
      'TRUMP', 'FARTCOIN', 'NEIRO', 'BABYDOGE', 'DOGS', 'NOT', '1000SATS',
      'PENGU', 'MOODENG', 'CHILLGUY', 'BAN', 'TST'
    ],

    /* AI 与算力：人工智能、去中心化算力、AI 代理 */
    ai: [
      'FET', 'RENDER', 'RNDR', 'TAO', 'ARKM', 'WLD', 'VIRTUAL', 'AIXBT', 'IO',
      'NOS', 'OLAS', 'AI16Z', 'GRIFFAIN', 'SWARMS', 'ZEREBRO', 'ATH', 'AKT',
      'PHB', 'NMR'
    ],

    /* 游戏与元宇宙：链游、虚拟世界、游戏公链 */
    game: [
      'AXS', 'SAND', 'MANA', 'GALA', 'APE', 'ENJ', 'ILV', 'GODS', 'PRIME',
      'PIXEL', 'BIGTIME', 'ACE', 'MAGIC', 'PORTAL', 'XAI', 'BEAM', 'YGG',
      'GMT', 'SLP', 'ALICE', 'HERO', 'MAVIA'
    ],

    /* 存储与数据：去中心化存储、数据网络 */
    storage: [
      'FIL', 'AR', 'STORJ', 'LPT', 'IOTX', 'SC', 'BLZ', 'ANKR'
    ],

    /* 跨链与桥：跨链消息层、资产桥 */
    bridge: [
      'AXL', 'ZRO', 'STG', 'W', 'SYNC', 'ACH', 'OMNI', 'DEGO'
    ],

    /* 支付与结算：跨境支付、结算网络 */
    payment: [
      'DASH', 'XNO', 'NANO', 'CRO', 'GTN', 'PAY', 'COTI', 'FXS'
    ],

    /* 隐私加固：隐私币与隐私计算 */
    privacy: [
      'XMR', 'ZEC', 'SCRT', 'DUSK', 'NYM', 'PHA', 'OASIS'
    ],

    /* 老牌分叉币：比特币与以太坊的历史分叉 */
    fork: [
      'LTC', 'BCH', 'BSV', 'BTG', 'ETC2', 'DGB', 'RVN', 'XEC', 'BCD'
    ]
  };

  /* 把分组展开成 { 币种代码: 赛道 key } 的查表结构 */
  var MAP = Object.create(null);
  Object.keys(GROUPS).forEach(function (sectorKey) {
    GROUPS[sectorKey].forEach(function (code) {
      MAP[code.toUpperCase()] = sectorKey;
    });
  });

  var SECTOR_BY_KEY = Object.create(null);
  SECTORS.concat([OTHER]).forEach(function (s) {
    SECTOR_BY_KEY[s.key] = s;
  });

  /* 查询某个币种属于哪个赛道；查不到返回 other */
  function getSectorKey(code) {
    if (!code) return OTHER.key;
    var key = MAP[String(code).toUpperCase()];
    return key || OTHER.key;
  }

  function getSector(code) {
    return SECTOR_BY_KEY[getSectorKey(code)] || OTHER;
  }

  function getSectorByKey(key) {
    return SECTOR_BY_KEY[key] || OTHER;
  }

  /* 内置表一共收录了多少个币种代码（用于向用户说明覆盖率） */
  function mappedCount() {
    return Object.keys(MAP).length;
  }

  return {
    SECTORS: SECTORS,
    OTHER: OTHER,
    all: SECTORS.concat([OTHER]),
    map: MAP,
    getSectorKey: getSectorKey,
    getSector: getSector,
    getSectorByKey: getSectorByKey,
    mappedCount: mappedCount
  };
})();
