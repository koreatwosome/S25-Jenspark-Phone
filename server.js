const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =====================================================
//  캐시 & 히스토리 설정
// =====================================================
const CACHE_TTL_MS      = 60 * 60 * 1000;   // 시장 데이터 캐시 1시간
const NEWS_CACHE_TTL_MS = 60 * 60 * 1000;   // 뉴스 캐시 1시간
const USD_HISTORY_MAX   = 48;               // 최대 48포인트(48시간) 보관

const cache = {
  market: { data: null, updatedAt: 0 },
  news:   { data: null, updatedAt: 0 }
};

// USD/KRW 24시간 이력 (매 갱신마다 push)
// [ { rate: 1459.33, ts: <unix ms> }, ... ]
let usdKrwHistory = [];

// =====================================================
//  유틸: HTTPS GET
// =====================================================
function fetchText(url, timeoutMs = 9000) {
  return new Promise(resolve => {
    try {
      const opts = new URL(url);
      const req = https.get(
        {
          hostname: opts.hostname,
          path: opts.pathname + opts.search,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; MarketBot/2.0)',
            Accept: '*/*'
          }
        },
        res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            resolve(fetchText(res.headers.location, timeoutMs));
            return;
          }
          let body = '';
          res.on('data', c => (body += c));
          res.on('end', () => resolve(body));
        }
      );
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(''); });
      req.on('error', () => resolve(''));
    } catch {
      resolve('');
    }
  });
}

function fetchJson(url, timeoutMs = 9000) {
  return fetchText(url, timeoutMs).then(body => {
    try { return JSON.parse(body); } catch { return null; }
  });
}

// =====================================================
//  Yahoo Finance 시세
// =====================================================
async function fetchYahooQuote(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=2d`;
  const data = await fetchJson(url);
  if (!data?.chart?.result?.[0]) return null;
  const meta = data.chart.result[0].meta;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose;
  const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
  return {
    price: parseFloat(price.toFixed(2)),
    prevClose: parseFloat((prevClose || price).toFixed(2)),
    changePercent: parseFloat(change.toFixed(2))
  };
}

// =====================================================
//  USD/KRW 환율
// =====================================================
async function fetchUsdKrw() {
  const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
  if (data?.result === 'success' && data.rates?.KRW) {
    return { rate: parseFloat(data.rates.KRW.toFixed(2)), updatedUtc: data.time_last_update_utc || '' };
  }
  const yahoo = await fetchYahooQuote('KRW=X');
  if (yahoo) return { rate: yahoo.price, updatedUtc: '' };
  return null;
}

// =====================================================
//  USD/KRW 24시간 이력 관리
// =====================================================
function recordUsdKrwHistory(rate) {
  const now = Date.now();
  usdKrwHistory.push({ rate, ts: now });
  // 48시간 이상 된 데이터 삭제
  const cutoff = now - 48 * 60 * 60 * 1000;
  usdKrwHistory = usdKrwHistory.filter(h => h.ts >= cutoff);
  // 최대 포인트 수 제한
  if (usdKrwHistory.length > USD_HISTORY_MAX) {
    usdKrwHistory = usdKrwHistory.slice(-USD_HISTORY_MAX);
  }
}

/**
 * 24시간 전 환율 대비 현재 환율 하락 여부 판단
 * returns: { isDown: bool, current: number, ref24h: number, changePct: number, dataPoints: number }
 */
function calcUsdKrw24hTrend(currentRate) {
  const now = Date.now();
  const target = now - 24 * 60 * 60 * 1000; // 24시간 전

  if (usdKrwHistory.length < 2) {
    return { isDown: false, current: currentRate, ref24h: null, changePct: null, dataPoints: usdKrwHistory.length, note: '데이터 누적 중' };
  }

  // 24시간 전에 가장 가까운 포인트 찾기
  let closest = usdKrwHistory[0];
  let minDiff = Math.abs(usdKrwHistory[0].ts - target);
  for (const h of usdKrwHistory) {
    const diff = Math.abs(h.ts - target);
    if (diff < minDiff) { minDiff = diff; closest = h; }
  }

  const ref24h = closest.rate;
  const changePct = parseFloat(((currentRate - ref24h) / ref24h * 100).toFixed(3));
  const isDown = changePct < 0; // 환율 하락 = 원화 강세

  return {
    isDown,
    current: currentRate,
    ref24h,
    changePct,
    dataPoints: usdKrwHistory.length,
    refAge: Math.round((now - closest.ts) / 60000), // 분 단위
    note: isDown ? `24h 대비 ${Math.abs(changePct).toFixed(2)}% 하락 (원화 강세)` : `24h 대비 ${changePct.toFixed(2)}% 상승 (원화 약세)`
  };
}

// =====================================================
//  실시간 시장 데이터 수집
// =====================================================
async function fetchLiveMarketData() {
  console.log('[Market] 실시간 데이터 수집 시작...');

  const [sp500, nasdaq, kospi, usdKrwFx, usdKrwYahoo] = await Promise.all([
    fetchYahooQuote('^GSPC'),
    fetchYahooQuote('^IXIC'),
    fetchYahooQuote('^KS11'),
    fetchUsdKrw(),
    fetchYahooQuote('KRW=X')
  ]);

  let usdKrwRate = 1450.0;
  let usdKrwChange = 0;

  if (usdKrwFx?.rate) usdKrwRate = usdKrwFx.rate;
  else if (usdKrwYahoo?.price) usdKrwRate = usdKrwYahoo.price;

  if (usdKrwYahoo?.changePercent !== undefined) {
    usdKrwChange = parseFloat((usdKrwRate * (usdKrwYahoo.changePercent / 100)).toFixed(2));
  }

  // 이력 기록
  recordUsdKrwHistory(usdKrwRate);
  const usdKrw24h = calcUsdKrw24hTrend(usdKrwRate);

  const now = new Date();
  const result = {
    timestamp: now.toISOString(),
    usdKrw: usdKrwRate,
    usdKrwChange,
    usdKrwChangePercent: usdKrwYahoo?.changePercent ?? 0,
    usdKrwPrevClose: usdKrwYahoo?.prevClose ?? usdKrwRate,
    usdKrw24hTrend: usdKrw24h,  // ★ 24시간 추세
    sp500: sp500?.price ?? 5923.45,
    sp500Change: sp500?.changePercent ?? 0,
    sp500PrevClose: sp500?.prevClose ?? 5923.45,
    nasdaq: nasdaq?.price ?? 18842.31,
    nasdaqChange: nasdaq?.changePercent ?? 0,
    nasdaqPrevClose: nasdaq?.prevClose ?? 18842.31,
    kospi: kospi?.price ?? 2612.40,
    kospiChange: kospi?.changePercent ?? 0,
    kospiPrevClose: kospi?.prevClose ?? 2612.40,
    source: (sp500 || nasdaq || kospi || usdKrwFx) ? 'live' : 'fallback',
    sources: {
      sp500: sp500 ? 'yahoo_finance' : 'fallback',
      nasdaq: nasdaq ? 'yahoo_finance' : 'fallback',
      kospi: kospi ? 'yahoo_finance' : 'fallback',
      usdKrw: usdKrwFx ? 'open_er_api' : (usdKrwYahoo ? 'yahoo_finance' : 'fallback')
    }
  };

  console.log(
    `[Market] 완료 | USD/KRW=${result.usdKrw}(24h:${usdKrw24h.changePct ?? 'n/a'}%) | ` +
    `SP500=${result.sp500}(${result.sp500Change}%) | NASDAQ=${result.nasdaq}(${result.nasdaqChange}%) | ` +
    `KOSPI=${result.kospi}(${result.kospiChange}%)`
  );

  return result;
}

// =====================================================
//  전쟁 뉴스 카운트 (Google News RSS - 키 불필요)
// =====================================================
/**
 * Google News RSS에서 미국-이란 전쟁 관련 뉴스를 수집하고
 * 오늘(0~24h) vs 어제(24~48h) 기사 수를 비교합니다.
 */
async function fetchWarNewsCount() {
  const queries = [
    'US+Iran+war+military+attack',
    'United+States+Iran+strike+conflict'
  ];

  let todayTotal = 0;
  let yesterdayTotal = 0;
  const headlines = [];

  for (const q of queries) {
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const rssText = await fetchText(url);
    if (!rssText) continue;

    const itemMatches = rssText.match(/<item>([\s\S]*?)<\/item>/g) || [];
    const now = Date.now();
    const h24 = now - 24 * 60 * 60 * 1000;
    const h48 = now - 48 * 60 * 60 * 1000;

    itemMatches.forEach(item => {
      const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/);
      if (!dateMatch) return;

      const pubDate = new Date(dateMatch[1]);
      const ts = pubDate.getTime();
      const title = titleMatch
        ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g,'&').trim()
        : '';

      if (ts >= h24) {
        todayTotal++;
        if (headlines.length < 5) headlines.push({ title: title.slice(0, 120), date: pubDate.toISOString().slice(0, 16) });
      } else if (ts >= h48) {
        yesterdayTotal++;
      }
    });
  }

  // 중복 제거를 위해 절반으로 나눔 (2개 쿼리가 겹치는 기사 있음)
  // 실제로는 각 쿼리가 다른 키워드라 그대로 사용
  const changePct = yesterdayTotal > 0
    ? parseFloat(((todayTotal - yesterdayTotal) / yesterdayTotal * 100).toFixed(1))
    : (todayTotal > 0 ? 100 : 0);

  // 5~10% 이상 증가 시 자동 체크 ON 조건
  const isIncreased = changePct >= 5;

  return {
    todayCount: todayTotal,
    yesterdayCount: yesterdayTotal,
    changePct,
    isIncreased,
    threshold: 5,  // 5% 이상 증가 시 체크
    headlines,
    note: yesterdayTotal === 0
      ? `어제 뉴스 없음, 오늘 ${todayTotal}건`
      : `어제 ${yesterdayTotal}건 → 오늘 ${todayTotal}건 (${changePct > 0 ? '+' : ''}${changePct}%)`,
    source: 'google_news_rss'
  };
}

async function getWarNewsData() {
  const now = Date.now();
  if (cache.news.data && now - cache.news.updatedAt < NEWS_CACHE_TTL_MS) {
    return cache.news.data;
  }
  const data = await fetchWarNewsCount();
  cache.news.data = data;
  cache.news.updatedAt = now;
  console.log(`[News] 전쟁뉴스 업데이트: ${data.note}`);
  return data;
}

// =====================================================
//  자동 체크 판단 통합 API  /api/auto-check
// =====================================================
async function calcAutoCheck() {
  const [market, warNews] = await Promise.all([
    getMarketData(),
    getWarNewsData()
  ]);

  // ── 1. USD/KRW 24시간 하락 여부 ──
  const usdKrwTrend = market.usdKrw24hTrend || calcUsdKrw24hTrend(market.usdKrw);
  const check1 = {
    id: 1,
    label: 'USD/KRW 환율',
    autoOn: usdKrwTrend.isDown,
    reason: usdKrwTrend.note || '데이터 누적 중',
    detail: {
      current: market.usdKrw,
      ref24h: usdKrwTrend.ref24h,
      changePct: usdKrwTrend.changePct,
      dataPoints: usdKrwTrend.dataPoints
    }
  };

  // ── 2. NASDAQ 전날 대비 상승 여부 ──
  const nasdaqUp = market.nasdaqChange > 0;
  const check2 = {
    id: 2,
    label: '전날 미국장 동향',
    autoOn: nasdaqUp,
    reason: nasdaqUp
      ? `NASDAQ 전일 대비 +${market.nasdaqChange.toFixed(2)}% 상승`
      : `NASDAQ 전일 대비 ${market.nasdaqChange.toFixed(2)}% (상승 아님)`,
    detail: {
      nasdaq: market.nasdaq,
      nasdaqPrevClose: market.nasdaqPrevClose,
      nasdaqChange: market.nasdaqChange
    }
  };

  // ── 10. 전쟁/지정학적 리스크 뉴스 증가 여부 ──
  // 전쟁 뉴스가 5% 이상 증가 → 위험 증가 → 체크 ON (투자 자제 신호)
  // ※ 전쟁 뉴스 급증은 '부정' 시나리오이나, 체크리스트 ON = 승률 계산에 반영
  //    (사용자 정의: 전쟁 뉴스 증가 → 항목 ON)
  const check10 = {
    id: 10,
    label: '전쟁/지정학적 리스크',
    autoOn: warNews.isIncreased,
    reason: warNews.note,
    detail: {
      todayCount: warNews.todayCount,
      yesterdayCount: warNews.yesterdayCount,
      changePct: warNews.changePct,
      threshold: warNews.threshold,
      headlines: warNews.headlines
    }
  };

  return {
    timestamp: new Date().toISOString(),
    checks: { 1: check1, 2: check2, 10: check10 },
    summary: {
      usdKrwDown: check1.autoOn,
      nasdaqUp: check2.autoOn,
      warNewsUp: check10.autoOn,
      autoOnCount: [check1, check2, check10].filter(c => c.autoOn).length
    }
  };
}

// =====================================================
//  캐시 갱신 헬퍼
// =====================================================
async function getMarketData() {
  const now = Date.now();
  if (cache.market.data && now - cache.market.updatedAt < CACHE_TTL_MS) {
    return cache.market.data;
  }
  const data = await fetchLiveMarketData();
  cache.market.data = data;
  cache.market.updatedAt = now;
  return data;
}

// =====================================================
//  API 엔드포인트
// =====================================================

// 시장 데이터
app.get('/api/market', async (req, res) => {
  try {
    if (req.query.force === 'true') cache.market.updatedAt = 0;
    const data = await getMarketData();
    const cacheAge = Math.floor((Date.now() - cache.market.updatedAt) / 1000);
    res.setHeader('X-Cache-Age', cacheAge);
    res.setHeader('X-Cache-TTL', Math.floor(CACHE_TTL_MS / 1000));
    res.setHeader('X-Next-Update', new Date(cache.market.updatedAt + CACHE_TTL_MS).toISOString());
    res.json(data);
  } catch (err) {
    console.error('[Market API Error]', err);
    res.json({
      timestamp: new Date().toISOString(),
      usdKrw: 1450.0, usdKrwChange: 0, usdKrwChangePercent: 0,
      usdKrw24hTrend: { isDown: false, note: '오류', dataPoints: 0 },
      sp500: 5923.45, sp500Change: 0,
      nasdaq: 18842.31, nasdaqChange: 0,
      kospi: 2612.40, kospiChange: 0,
      source: 'error_fallback'
    });
  }
});

// ★ 자동 체크 판단 API
app.get('/api/auto-check', async (req, res) => {
  try {
    if (req.query.force === 'true') {
      cache.market.updatedAt = 0;
      cache.news.updatedAt = 0;
    }
    const result = await calcAutoCheck();
    res.json(result);
  } catch (err) {
    console.error('[AutoCheck API Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// USD/KRW 24시간 이력 조회
app.get('/api/market/usdkrw-history', (req, res) => {
  res.json({
    history: usdKrwHistory,
    count: usdKrwHistory.length,
    oldest: usdKrwHistory.length > 0 ? new Date(usdKrwHistory[0].ts).toISOString() : null,
    latest: usdKrwHistory.length > 0 ? new Date(usdKrwHistory[usdKrwHistory.length - 1].ts).toISOString() : null
  });
});

// 전쟁 뉴스 API
app.get('/api/war-news', async (req, res) => {
  try {
    if (req.query.force === 'true') cache.news.updatedAt = 0;
    const data = await getWarNewsData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 캐시 상태
app.get('/api/market/status', (req, res) => {
  const now = Date.now();
  const age = cache.market.updatedAt ? Math.floor((now - cache.market.updatedAt) / 1000) : null;
  res.json({
    cached: !!cache.market.data,
    cacheAgeSeconds: age,
    cacheTTLSeconds: Math.floor(CACHE_TTL_MS / 1000),
    nextScheduledUpdate: cache.market.updatedAt ? new Date(cache.market.updatedAt + CACHE_TTL_MS).toISOString() : null,
    lastUpdateAt: cache.market.updatedAt ? new Date(cache.market.updatedAt).toISOString() : null,
    source: cache.market.data?.source ?? 'none',
    usdKrwHistoryPoints: usdKrwHistory.length
  });
});

// 강제 갱신
app.post('/api/market/refresh', async (req, res) => {
  cache.market.updatedAt = 0;
  cache.news.updatedAt = 0;
  try {
    const data = await getMarketData();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// D램 가격 API (시뮬레이션 유지)
app.get('/api/dram', (req, res) => {
  const now = new Date();
  const seed = now.getDate() + now.getMonth() * 31;
  const pseudoRand = (base, range, s) => {
    const x = Math.sin(s * 9301 + seed * 49297) * 0.5 + 0.5;
    return parseFloat((base + (x - 0.5) * range).toFixed(3));
  };
  const dramPrices = [
    { id: 'ddr5-16', name: 'DDR5 16GB', spec: 'PC5-38400', type: 'spot', price: pseudoRand(3.20, 0.40, 1), prev: 3.12 },
    { id: 'ddr5-32', name: 'DDR5 32GB', spec: 'PC5-51200', type: 'spot', price: pseudoRand(6.80, 0.60, 2), prev: 6.65 },
    { id: 'ddr4-8',  name: 'DDR4 8GB',  spec: 'PC4-25600', type: 'spot', price: pseudoRand(1.45, 0.20, 3), prev: 1.47 },
    { id: 'ddr4-16', name: 'DDR4 16GB', spec: 'PC4-25600', type: 'spot', price: pseudoRand(2.90, 0.30, 4), prev: 2.88 },
    { id: 'lpddr5-8',  name: 'LPDDR5 8GB',  spec: 'Mobile',     type: 'spot',     price: pseudoRand(2.80, 0.35, 5), prev: 2.85 },
    { id: 'lpddr5x-16',name: 'LPDDR5X 16GB',spec: 'Mobile',     type: 'spot',     price: pseudoRand(5.60, 0.50, 6), prev: 5.52 },
    { id: 'hbm3',    name: 'HBM3 8GB Stack',  spec: 'AI/HPC',     type: 'contract', price: pseudoRand(28.00, 2.0, 7), prev: 26.60 },
    { id: 'hbm3e',   name: 'HBM3E 24GB Stack',spec: 'AI Server',  type: 'contract', price: pseudoRand(48.00, 4.0, 8), prev: 45.50 }
  ];
  res.json({ timestamp: now.toISOString(), currency: 'USD', data: dramPrices, source: 'simulated' });
});

// 투자 이력 API
let serverHistory = [];
app.get('/api/history', (req, res) => res.json(serverHistory));
app.post('/api/history', (req, res) => {
  const record = req.body;
  if (!record?.date) return res.status(400).json({ error: 'Invalid data' });
  const idx = serverHistory.findIndex(h => h.date === record.date);
  if (idx >= 0) serverHistory[idx] = record; else serverHistory.unshift(record);
  res.json({ success: true, record });
});
app.delete('/api/history/:date', (req, res) => {
  serverHistory = serverHistory.filter(h => h.date !== req.params.date);
  res.json({ success: true });
});

// 기본 라우트
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// =====================================================
//  서버 시작
// =====================================================
app.listen(PORT, '0.0.0.0', async () => {
  console.log('🚀 주식 투자 승률 시스템 서버 시작!');
  console.log(`📊 서버: http://0.0.0.0:${PORT}`);
  console.log(`💹 시장 데이터:    /api/market`);
  console.log(`🤖 자동 체크 판단: /api/auto-check`);
  console.log(`📰 전쟁뉴스:       /api/war-news`);
  console.log(`📈 USD/KRW 이력:   /api/market/usdkrw-history`);

  try {
    await getMarketData();
    console.log('✅ 초기 시장 데이터 수집 완료 (USD/KRW 이력 기록 시작)');
    // 전쟁 뉴스도 백그라운드에서 선로드
    getWarNewsData().then(d => console.log(`✅ 초기 전쟁뉴스 수집 완료: ${d.note}`));
  } catch (e) {
    console.warn('⚠️ 초기 데이터 수집 실패:', e.message);
  }
});
