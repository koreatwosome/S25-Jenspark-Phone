const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== 캐시 설정 =====
// 실시간 API 호출 빈도를 줄이기 위해 서버 측 캐싱 사용
const CACHE_TTL_MS = 60 * 60 * 1000; // 1시간 캐시
const cache = {
  market: { data: null, updatedAt: 0 },
  dram:   { data: null, updatedAt: 0 }
};

// ===== 유틸: HTTPS GET 요청 =====
function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = https.get(
      {
        hostname: opts.hostname,
        path: opts.pathname + opts.search,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json,text/html,*/*'
        }
      },
      res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

// ===== Yahoo Finance 시세 조회 =====
// 심볼 예: ^GSPC (S&P500), ^IXIC (NASDAQ), ^KS11 (KOSPI)
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

// ===== USD/KRW 환율 조회 (ExchangeRate-API 무료) =====
// 무료 엔드포인트: 매일 00:00 UTC 1회 업데이트
async function fetchUsdKrw() {
  // 방법 1: open.er-api.com (무료, 일 1회 업데이트)
  const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
  if (data?.result === 'success' && data.rates?.KRW) {
    return {
      rate: parseFloat(data.rates.KRW.toFixed(2)),
      updatedUtc: data.time_last_update_utc || ''
    };
  }
  // 방법 2: Yahoo Finance USD/KRW=X (fallback)
  const yahoo = await fetchYahooQuote('KRW=X');
  if (yahoo) {
    return { rate: yahoo.price, updatedUtc: '' };
  }
  return null;
}

// ===== 실시간 시장 데이터 수집 =====
async function fetchLiveMarketData() {
  console.log('[Market] 실시간 데이터 수집 시작...');

  const [sp500, nasdaq, kospi, usdKrwFx, usdKrwYahoo] = await Promise.all([
    fetchYahooQuote('^GSPC'),
    fetchYahooQuote('^IXIC'),
    fetchYahooQuote('^KS11'),
    fetchUsdKrw(),
    fetchYahooQuote('KRW=X') // USD/KRW Yahoo 직접 조회 (변화율 포함)
  ]);

  // USD/KRW: 환율 변화율은 Yahoo에서, 실제 환율은 ExchangeRate API 우선
  let usdKrwRate = 1450.0;
  let usdKrwChange = 0;

  if (usdKrwFx?.rate) {
    usdKrwRate = usdKrwFx.rate;
  } else if (usdKrwYahoo?.price) {
    usdKrwRate = usdKrwYahoo.price;
  }

  if (usdKrwYahoo?.changePercent !== undefined) {
    // Yahoo KRW=X는 USD 기준 → KRW 강세면 환율 하락
    // changePercent가 양수면 달러 강세(환율 상승), 음수면 원화 강세(환율 하락)
    usdKrwChange = parseFloat((usdKrwRate * (usdKrwYahoo.changePercent / 100)).toFixed(2));
  }

  const now = new Date();
  const result = {
    timestamp: now.toISOString(),
    // USD/KRW
    usdKrw: usdKrwRate,
    usdKrwChange: usdKrwChange,
    usdKrwChangePercent: usdKrwYahoo?.changePercent ?? 0,
    usdKrwPrevClose: usdKrwYahoo?.prevClose ?? usdKrwRate,
    // S&P 500
    sp500: sp500?.price ?? 5923.45,
    sp500Change: sp500?.changePercent ?? 0,
    sp500PrevClose: sp500?.prevClose ?? 5923.45,
    // NASDAQ
    nasdaq: nasdaq?.price ?? 18842.31,
    nasdaqChange: nasdaq?.changePercent ?? 0,
    nasdaqPrevClose: nasdaq?.prevClose ?? 18842.31,
    // KOSPI
    kospi: kospi?.price ?? 2612.40,
    kospiChange: kospi?.changePercent ?? 0,
    kospiPrevClose: kospi?.prevClose ?? 2612.40,
    // 메타
    source: (sp500 || nasdaq || kospi || usdKrwFx) ? 'live' : 'fallback',
    sources: {
      sp500: sp500 ? 'yahoo_finance' : 'fallback',
      nasdaq: nasdaq ? 'yahoo_finance' : 'fallback',
      kospi: kospi ? 'yahoo_finance' : 'fallback',
      usdKrw: usdKrwFx ? 'open_er_api' : (usdKrwYahoo ? 'yahoo_finance' : 'fallback')
    }
  };

  console.log(
    `[Market] 수집 완료 | source=${result.source} | ` +
    `USD/KRW=${result.usdKrw} | SP500=${result.sp500}(${result.sp500Change}%) | ` +
    `NASDAQ=${result.nasdaq}(${result.nasdaqChange}%) | KOSPI=${result.kospi}(${result.kospiChange}%)`
  );

  return result;
}

// ===== 캐시 갱신 헬퍼 =====
async function getMarketData() {
  const now = Date.now();
  if (cache.market.data && now - cache.market.updatedAt < CACHE_TTL_MS) {
    return cache.market.data; // 캐시 유효
  }
  // 새로 수집
  const data = await fetchLiveMarketData();
  cache.market.data = data;
  cache.market.updatedAt = now;
  return data;
}

// ===== 시장 데이터 API =====
app.get('/api/market', async (req, res) => {
  try {
    // force=true 쿼리 파라미터로 강제 갱신 가능
    if (req.query.force === 'true') {
      cache.market.updatedAt = 0;
    }
    const data = await getMarketData();
    // 캐시 잔여 시간 헤더 추가
    const cacheAge = Math.floor((Date.now() - cache.market.updatedAt) / 1000);
    const cacheMax = Math.floor(CACHE_TTL_MS / 1000);
    res.setHeader('X-Cache-Age', cacheAge);
    res.setHeader('X-Cache-TTL', cacheMax);
    res.setHeader('X-Next-Update', new Date(cache.market.updatedAt + CACHE_TTL_MS).toISOString());
    res.json(data);
  } catch (err) {
    console.error('[Market API Error]', err);
    // 에러 시 fallback 데이터 반환
    res.json({
      timestamp: new Date().toISOString(),
      usdKrw: 1450.0, usdKrwChange: 0, usdKrwChangePercent: 0,
      sp500: 5923.45, sp500Change: 0,
      nasdaq: 18842.31, nasdaqChange: 0,
      kospi: 2612.40, kospiChange: 0,
      source: 'error_fallback'
    });
  }
});

// ===== 캐시 상태 확인 API =====
app.get('/api/market/status', (req, res) => {
  const now = Date.now();
  const age = cache.market.updatedAt ? Math.floor((now - cache.market.updatedAt) / 1000) : null;
  const nextUpdate = cache.market.updatedAt
    ? new Date(cache.market.updatedAt + CACHE_TTL_MS).toISOString()
    : null;
  res.json({
    cached: !!cache.market.data,
    cacheAgeSeconds: age,
    cacheTTLSeconds: Math.floor(CACHE_TTL_MS / 1000),
    nextScheduledUpdate: nextUpdate,
    lastUpdateAt: cache.market.updatedAt ? new Date(cache.market.updatedAt).toISOString() : null,
    source: cache.market.data?.source ?? 'none'
  });
});

// ===== 강제 갱신 API (POST) =====
app.post('/api/market/refresh', async (req, res) => {
  cache.market.updatedAt = 0;
  try {
    const data = await getMarketData();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== D램 가격 API (시뮬레이션 유지) =====
app.get('/api/dram', (req, res) => {
  const now = new Date();
  const seed = now.getDate() + now.getMonth() * 31;

  const pseudoRand = (base, range, s) => {
    const x = Math.sin(s * 9301 + seed * 49297) * 0.5 + 0.5;
    return parseFloat((base + (x - 0.5) * range).toFixed(3));
  };

  const dramPrices = [
    { id: 'ddr5-16', name: 'DDR5 16GB', spec: 'PC5-38400', type: 'spot',
      price: pseudoRand(3.20, 0.40, 1), prev: 3.12 },
    { id: 'ddr5-32', name: 'DDR5 32GB', spec: 'PC5-51200', type: 'spot',
      price: pseudoRand(6.80, 0.60, 2), prev: 6.65 },
    { id: 'ddr4-8', name: 'DDR4 8GB', spec: 'PC4-25600', type: 'spot',
      price: pseudoRand(1.45, 0.20, 3), prev: 1.47 },
    { id: 'ddr4-16', name: 'DDR4 16GB', spec: 'PC4-25600', type: 'spot',
      price: pseudoRand(2.90, 0.30, 4), prev: 2.88 },
    { id: 'lpddr5-8', name: 'LPDDR5 8GB', spec: 'Mobile', type: 'spot',
      price: pseudoRand(2.80, 0.35, 5), prev: 2.85 },
    { id: 'lpddr5x-16', name: 'LPDDR5X 16GB', spec: 'Mobile', type: 'spot',
      price: pseudoRand(5.60, 0.50, 6), prev: 5.52 },
    { id: 'hbm3', name: 'HBM3 8GB Stack', spec: 'AI/HPC', type: 'contract',
      price: pseudoRand(28.00, 2.0, 7), prev: 26.60 },
    { id: 'hbm3e', name: 'HBM3E 24GB Stack', spec: 'AI Server', type: 'contract',
      price: pseudoRand(48.00, 4.0, 8), prev: 45.50 }
  ];

  res.json({
    timestamp: now.toISOString(),
    currency: 'USD',
    data: dramPrices,
    source: 'simulated'
  });
});

// ===== 투자 이력 저장/조회 API =====
let serverHistory = [];

app.get('/api/history', (req, res) => {
  res.json(serverHistory);
});

app.post('/api/history', (req, res) => {
  const record = req.body;
  if (!record || !record.date) {
    return res.status(400).json({ error: 'Invalid data' });
  }
  const idx = serverHistory.findIndex(h => h.date === record.date);
  if (idx >= 0) serverHistory[idx] = record;
  else serverHistory.unshift(record);
  res.json({ success: true, record });
});

app.delete('/api/history/:date', (req, res) => {
  const date = req.params.date;
  serverHistory = serverHistory.filter(h => h.date !== date);
  res.json({ success: true });
});

// ===== 기본 라우트 =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== 서버 시작 + 초기 데이터 수집 =====
app.listen(PORT, '0.0.0.0', async () => {
  console.log('🚀 주식 투자 승률 시스템 서버 시작!');
  console.log(`📊 서버 주소: http://0.0.0.0:${PORT}`);
  console.log(`💹 시장 데이터 API: /api/market  (캐시 TTL: ${CACHE_TTL_MS / 60000}분)`);
  console.log(`🔧 D램 시황 API:    /api/dram`);
  console.log(`📝 투자 이력 API:   /api/history`);
  console.log(`📡 캐시 상태 API:   /api/market/status`);

  // 서버 시작 시 즉시 데이터 수집
  try {
    await getMarketData();
    console.log('✅ 초기 시장 데이터 수집 완료');
  } catch (e) {
    console.warn('⚠️ 초기 시장 데이터 수집 실패 (첫 요청 시 재시도):', e.message);
  }
});
