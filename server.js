const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== 시장 데이터 API =====
// 실제 환경에서는 외부 API(Yahoo Finance, Alpha Vantage 등)에서 가져옴
// 현재는 시뮬레이션 데이터 제공
app.get('/api/market', (req, res) => {
  const now = new Date();
  const seed = now.getHours() * 60 + now.getMinutes();

  // 의사 난수 기반 시뮬레이션 (실제 데이터처럼 표현)
  const pseudoRand = (base, range, s) => {
    const x = Math.sin(s * 9301 + 49297) * 0.5 + 0.5;
    return parseFloat((base + (x - 0.5) * range).toFixed(2));
  };

  const data = {
    timestamp: now.toISOString(),
    usdKrw: pseudoRand(1335.0, 20, seed + 1),
    usdKrwChange: pseudoRand(2.5, 8, seed + 2),
    sp500: pseudoRand(5923.45, 80, seed + 3),
    sp500Change: pseudoRand(-0.48, 2.0, seed + 4),
    nasdaq: pseudoRand(18842.31, 250, seed + 5),
    nasdaqChange: pseudoRand(-0.62, 2.5, seed + 6),
    kospi: pseudoRand(2612.40, 40, seed + 7),
    kospiChange: pseudoRand(0.31, 1.5, seed + 8),
    source: 'simulated'  // 'live' when using real API
  };

  res.json(data);
});

// ===== D램 가격 API =====
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

// ===== 투자 이력 저장/조회 API (선택사항, localStorage 병행 사용) =====
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 주식 투자 승률 시스템 서버 시작!`);
  console.log(`📊 서버 주소: http://0.0.0.0:${PORT}`);
  console.log(`💹 USD/KRW 환율 API: /api/market`);
  console.log(`🔧 D램 시황 API: /api/dram`);
  console.log(`📝 투자 이력 API: /api/history`);
});
