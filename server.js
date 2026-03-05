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
const BRENT_HISTORY_MAX = 48;               // 브렌트유 이력 최대 48포인트
const PER_UPDATE_MS     = 24 * 60 * 60 * 1000; // PER/PBR 매일 1회 갱신

const cache = {
  market: { data: null, updatedAt: 0 },
  news:   { data: null, updatedAt: 0 },
  fedNews:{ data: null, updatedAt: 0 }
};

// ★ PER/PBR 일별 갱신 캐시 (매일 자정 리셋)
let perPbrDailyCache = { data: null, date: null };

// 서버 사이드 1시간 자동 갱신 스케줄러 (브렌트유 포함 전체 시장 데이터)
function startMarketScheduler() {
  setInterval(async () => {
    console.log('[Scheduler] 1시간 자동 갱신 실행...');
    cache.market.updatedAt = 0; // 캐시 만료 처리
    try {
      await getMarketData();
      console.log('[Scheduler] 시장 데이터(브렌트유 포함) 갱신 완료');
    } catch (e) {
      console.warn('[Scheduler] 갱신 실패:', e.message);
    }
  }, CACHE_TTL_MS);
  console.log(`[Scheduler] 브렌트유·시장 데이터 매 ${CACHE_TTL_MS/60000}분 자동 갱신 스케줄러 시작`);
}

// ★ PER/PBR 매일 자정 리셋 스케줄러
function startPerPbrDailyScheduler() {
  // 자정까지 남은 시간 계산
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // 다음 자정
  const msUntilMidnight = midnight.getTime() - now.getTime();

  // 자정에 한 번 실행 후 매 24시간마다 반복
  setTimeout(() => {
    resetPerPbrDailyCache();
    setInterval(resetPerPbrDailyCache, PER_UPDATE_MS);
    console.log('[PER/PBR] 매일 자정 갱신 스케줄러 시작 (24h 간격)');
  }, msUntilMidnight);

  console.log(`[PER/PBR] 오늘 자정까지 ${Math.round(msUntilMidnight/60000)}분 후 첫 리셋 예정`);
}

function resetPerPbrDailyCache() {
  const today = new Date().toISOString().slice(0, 10);
  perPbrDailyCache = { data: null, date: today };
  // 마켓 데이터도 강제 갱신 (PER/PBR 재계산)
  cache.market.updatedAt = 0;
  console.log(`[PER/PBR] ${today} 일별 캐시 리셋 → 다음 API 호출 시 재계산`);
}

// USD/KRW 24시간 이력 (매 갱신마다 push)
let usdKrwHistory = [];
// 브렌트유 24시간 이력
let brentHistory = [];

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
// =====================================================
//  브렌트유 24시간 이력 관리
// =====================================================
function recordBrentHistory(price) {
  const now = Date.now();
  brentHistory.push({ price, ts: now });
  const cutoff = now - 48 * 60 * 60 * 1000;
  brentHistory = brentHistory.filter(h => h.ts >= cutoff);
  if (brentHistory.length > BRENT_HISTORY_MAX) brentHistory = brentHistory.slice(-BRENT_HISTORY_MAX);
}

/**
 * 24시간 전 브렌트유 대비 현재가 상승 여부 판단
 */
function calcBrent24hTrend(currentPrice) {
  const now = Date.now();
  const target = now - 24 * 60 * 60 * 1000;

  if (brentHistory.length < 2) {
    return { isUp: false, current: currentPrice, ref24h: null, changePct: null, dataPoints: brentHistory.length, note: '데이터 누적 중' };
  }

  let closest = brentHistory[0];
  let minDiff = Math.abs(brentHistory[0].ts - target);
  for (const h of brentHistory) {
    const diff = Math.abs(h.ts - target);
    if (diff < minDiff) { minDiff = diff; closest = h; }
  }

  const ref24h = closest.price;
  const changePct = parseFloat(((currentPrice - ref24h) / ref24h * 100).toFixed(3));
  const isUp = changePct > 0;

  return {
    isUp,
    current: currentPrice,
    ref24h,
    changePct,
    dataPoints: brentHistory.length,
    refAge: Math.round((now - closest.ts) / 60000),
    note: isUp
      ? `24h 대비 +${Math.abs(changePct).toFixed(2)}% 상승 (유가 강세)`
      : `24h 대비 ${changePct.toFixed(2)}% 하락 (유가 약세)`
  };
}

// =====================================================
//  코스피 PBR 추정 (역사적 데이터 기반 선형 추정)
// =====================================================
/**
 * 코스피 지수 레벨을 기반으로 PBR을 추정합니다.
 *
 * 역사적 앵커 데이터 (KRX / 한국거래소 공시 기반):
 *   코스피 2024년 말 ~ 2026년 초 PBR 관계 참조
 *   - 코스피 2400 pt ≈ PBR 0.87
 *   - 코스피 2600 pt ≈ PBR 0.94
 *   - 코스피 2800 pt ≈ PBR 1.01
 *   - 코스피 3000 pt ≈ PBR 1.09
 *   - 코스피 3400 pt ≈ PBR 1.24
 *
 * 선형 보간: PBR ≈ 0.87 + (kospi - 2400) * (0.94 - 0.87) / (2600 - 2400)
 *
 * 코스피 PBR 판정 기준:
 *   < 0.80  : 극도의 저평가 (역사적 최저구간)    → 매우 안전 (짙은 초록)
 *   0.80~0.90 : 저평가 구간                      → 안전 (초록)
 *   0.90~1.00 : 적정 하단 (역사적 평균 -1σ 수준) → 중립+
 *   1.00~1.10 : 적정 구간                        → 중립 (노랑)
 *   1.10~1.20 : 적정 상단                        → 주의 (주황)
 *   1.20~1.40 : 고평가 구간                      → 경계 (주황~빨강)
 *   > 1.40   : 버블 우려 구간                    → 위험 (빨강)
 */
function calcKospiPBR(kospiPrice) {
  if (!kospiPrice || kospiPrice <= 0) return null;

  // 코스피 PBR 앵커 포인트 (역사적 데이터 + 2026년 3월 실측값 기반)
  // 출처: KRX 시장지표, 조선비즈(2026-01-26), 노무라증권(2026-02-23)
  const anchors = [
    { kospi: 1800, pbr: 0.65 },  // 2022년 저점 구간
    { kospi: 2200, pbr: 0.80 },  // 2023년 초
    { kospi: 2400, pbr: 0.87 },  // 2024년 초
    { kospi: 2600, pbr: 0.94 },  // 2024년 중반
    { kospi: 2800, pbr: 1.01 },  // 2024년 상반기
    { kospi: 3000, pbr: 1.09 },  // 2024년 연초 고점
    { kospi: 3200, pbr: 1.17 },  // 2021년 상단
    { kospi: 3400, pbr: 1.24 },  // 2021년 고점 구간
    { kospi: 3800, pbr: 1.40 },  // 2021년 최고점
    { kospi: 4000, pbr: 1.50 },  // 2025년 하반기
    { kospi: 4500, pbr: 1.58 },  // 2025년 말~2026년 초
    { kospi: 5000, pbr: 1.67 },  // ★ 조선비즈 실측: 코스피 5000 돌파 당시 PBR 1.67배 (2026-01-26)
    { kospi: 5500, pbr: 1.82 },  // 2026년 2월 추정
    { kospi: 6000, pbr: 1.95 },  // 2026년 3월 (코스피 6000pt 구간)
    { kospi: 7000, pbr: 2.10 },  // ★ 노무라증권 목표: 코스피 8000pt → PBR 2.1~2.2배 (2026-02-23)
    { kospi: 8000, pbr: 2.20 },  // 노무라 상단 시나리오
  ];

  // 선형 보간
  let lower = anchors[0];
  let upper = anchors[anchors.length - 1];

  for (let i = 0; i < anchors.length - 1; i++) {
    if (kospiPrice >= anchors[i].kospi && kospiPrice <= anchors[i + 1].kospi) {
      lower = anchors[i];
      upper = anchors[i + 1];
      break;
    }
  }

  let pbr;
  if (kospiPrice <= anchors[0].kospi) {
    pbr = anchors[0].pbr;
  } else if (kospiPrice >= anchors[anchors.length - 1].kospi) {
    // 상한 초과 시 마지막 두 앵커의 기울기로 외삽
    const last2 = anchors.slice(-2);
    const slope = (last2[1].pbr - last2[0].pbr) / (last2[1].kospi - last2[0].kospi);
    pbr = last2[1].pbr + slope * (kospiPrice - last2[1].kospi);
  } else {
    const ratio = (kospiPrice - lower.kospi) / (upper.kospi - lower.kospi);
    pbr = lower.pbr + ratio * (upper.pbr - lower.pbr);
  }

  pbr = parseFloat(pbr.toFixed(2));

  // ★ PBR 수준 평가 — 2026년 3월 기준 재조정
  // 코스피 5000pt → 1.67배(실측), 6000pt → ~1.95배(추정), 8000pt → 2.1~2.2배(노무라)
  // 역사적 PBR 하단: 0.65배(2022년 저점), 역사적 평균: ~1.0배, 2026년 강세장: 1.7~2.0배
  let level, label, colorHex, emoji;
  if (pbr < 0.80) {
    level = 'extreme_low'; label = '극저평가'; colorHex = '#059669'; emoji = '🟢🟢';
    // 역사적 최저 구간 (2022년 이전 수준)
  } else if (pbr < 1.00) {
    level = 'undervalued'; label = '저평가'; colorHex = '#10b981'; emoji = '🟢';
    // 장부가 이하 — 구조적 저평가 (2024~2025년 초 수준)
  } else if (pbr < 1.20) {
    level = 'fair_low'; label = '적정하단'; colorHex = '#34d399'; emoji = '🔵';
    // 역사적 적정 하단 구간
  } else if (pbr < 1.50) {
    level = 'fair'; label = '적정'; colorHex = '#f59e0b'; emoji = '🟡';
    // 코스피 3000~4000pt 수준 (2024~2025년 강세장 초입)
  } else if (pbr < 1.80) {
    level = 'fair_high'; label = '적정상단'; colorHex = '#f97316'; emoji = '🟠';
    // ★ 현재(2026년 3월, 코스피 5000~6000pt) = PBR 1.67~1.95배 → 적정상단 구간
    // 코스피 5000pt 돌파 당시 실측 1.67배 (조선비즈, 2026-01-26)
  } else if (pbr < 2.20) {
    level = 'overvalued'; label = '고평가'; colorHex = '#ef4444'; emoji = '🔴';
    // 코스피 6000~8000pt 구간 (노무라 목표 PBR 2.1~2.2배)
  } else {
    level = 'bubble'; label = '버블위험'; colorHex = '#dc2626'; emoji = '🔴🔴';
    // PBR 2.2배 초과 — 2021년 역대 고점 수준 이상
  }

  return {
    pbr,
    level,
    label,
    colorHex,
    emoji,
    kospiRef: kospiPrice,
    note: `PBR ${pbr}x — ${label} (코스피 ${kospiPrice.toLocaleString('ko-KR', {maximumFractionDigits:2})}pt 기준 추정 | 출처: KRX·조선비즈·노무라증권)`,
    source: 'estimated_from_kospi_level_2026mar'
  };
}

// =====================================================
//  코스피 12개월 선행 PER 추정 (밸류에이션 밴드 기반 — 2026년 3월 업데이트)
// =====================================================
/**
 * 코스피 지수 → 12개월 선행 PER (Forward PER) 산출
 *
 * ★★ 계산 기준: 코스피 12개월 선행 PER 밸류에이션 밴드 ★★
 * ────────────────────────────────────────────
 * [밴드 기준 — 이미지 차트 분석 (2004~2026년 역사적 데이터)]
 *   선행 PER = 코스피 지수 / (12개월 선행 EPS)
 *   밴드: 8배 / 9배 / 10배 / 11배 / 12배
 *
 *   ★ "선행 PER 밸류에이션 8배 조반으로 내려간 사례는 극소수"
 *      → 8배 이하 = 역사적 최저 저평가 (매수 기회)
 *      → 9배 이하 = 강한 저평가 구간
 *      → 10배 = 역사적 평균 / 적정가 기준선
 *      → 11배 = 적정상단
 *      → 12배 이상 = 고평가
 *
 * [코스피 지수별 12개월 선행 PER 추정 앵커]
 *   ─ 선행 EPS = 코스피 / 선행PER 에서 역산
 *   ─ 주요 참고: FnGuide 컨센서스, 하나증권, 신영증권, KB자산운용
 *
 *   코스피 2400pt → 선행PER ≈ 9.5x  (2024년 초 저평가 구간)
 *   코스피 2600pt → 선행PER ≈ 10.0x (역사적 평균선 근처)
 *   코스피 2800pt → 선행PER ≈ 10.3x
 *   코스피 3000pt → 선행PER ≈ 10.5x
 *   코스피 3500pt → 선행PER ≈ 10.8x
 *   코스피 4000pt → 선행PER ≈ 11.0x
 *   코스피 5000pt → 선행PER ≈ 10.4x (Siblis Research 10.43x 실측 검증)
 *   코스피 6000pt → 선행PER ≈ 10.9x (FnGuide 10.7x / 하나증권 실측)
 *   코스피 6300pt → 선행PER ≈ 11.1x (2026-02-말 FnGuide 실측 검증)
 *
 * [12개월 선행 PER 밴드 기준 판정]
 *   < 8.0  : 극저평가 (역사적 8배 미만 — 극소수 사례)  🟢🟢
 *   8~9    : 강한 저평가 (8배 밴드~9배 밴드 사이)       🟢
 *   9~10   : 저평가 (9배 밴드~10배 밴드 사이)           🟩
 *   10~11  : 적정 (10배 기준선~11배 밴드 사이)          🔵  ← 현재(2026년 3월)
 *   11~12  : 적정상단 (11배~12배 밴드 사이)             🟡
 *   12~13  : 고평가 진입 (12배 밴드 돌파)               🟠
 *   > 13   : 고평가 / 버블 주의                         🔴
 * ────────────────────────────────────────────
 */
function calcKospiPER(kospiPrice) {
  if (!kospiPrice || kospiPrice <= 0) return null;

  // ══════════════════════════════════════════════════════════════
  //  12개월 선행 PER 밴드 앵커 포인트
  //  (코스피 지수 ↔ 선행PER 매핑 — 역사적 데이터 + 실측 검증)
  //
  //  핵심 검증 포인트:
  //    코스피 2600pt (2024년): 선행PER ≈ 10.0x (10배 밴드)
  //    코스피 5000pt (2026.01): 선행PER = 10.4x (Siblis Research 실측)
  //    코스피 6000pt (2026.03): 선행PER = 10.9x (FnGuide/하나증권 실측)
  //    코스피 6300pt (2026.02): 선행PER = 11.1x (FnGuide 실측)
  //
  //  선행 EPS 성장 반영:
  //    12개월 선행 EPS는 증권사 컨센서스 기반 (매년 성장)
  //    코스피 상승 시 EPS도 함께 상향되므로 PER 상승 억제됨
  // ══════════════════════════════════════════════════════════════

  // 12개월 선행 PER 앵커 (역사적 데이터 + 실측 검증)
  const fwdPerAnchors = [
    { kospi: 1500, fwdPer:  7.5 },  // 2008년 금융위기 저점 (극저평가 구간)
    { kospi: 1800, fwdPer:  8.0 },  // 역사적 8배 밴드 하단 (극소수 사례)
    { kospi: 2000, fwdPer:  8.5 },  // 8.5배 구간
    { kospi: 2200, fwdPer:  9.0 },  // 9배 밴드 근처 (2022~2023년 저평가)
    { kospi: 2400, fwdPer:  9.5 },  // 9.5배 구간 (2024년 초 저평가)
    { kospi: 2600, fwdPer: 10.0 },  // ★ 10배 기준선 (역사적 평균)
    { kospi: 2800, fwdPer: 10.3 },  // 10배~11배 사이
    { kospi: 3000, fwdPer: 10.5 },  // 10.5배 구간
    { kospi: 3500, fwdPer: 10.8 },  // 11배 밴드 접근
    { kospi: 4000, fwdPer: 11.0 },  // ★ 11배 밴드
    { kospi: 4500, fwdPer: 10.8 },  // 이익 급성장으로 PER 하락
    { kospi: 5000, fwdPer: 10.4 },  // ★ Siblis Research 실측: 10.43x (2026.01.01)
    { kospi: 5500, fwdPer: 10.7 },  // 2026년 2월 초
    { kospi: 6000, fwdPer: 10.9 },  // ★ FnGuide/하나증권 실측: ~10.7~10.95x (2026-03)
    { kospi: 6300, fwdPer: 11.1 },  // ★ FnGuide 실측: 11.1x (2026-02-말)
    { kospi: 6500, fwdPer: 11.3 },  // 2026년 3월 이후
    { kospi: 7000, fwdPer: 11.5 },  // 11배~12배 사이
    { kospi: 7500, fwdPer: 11.8 },  // 12배 밴드 접근
    { kospi: 8000, fwdPer: 12.0 },  // ★ 12배 밴드
  ];

  // 선형 보간 함수
  function interpolatePerBand(anchors, price) {
    if (price <= anchors[0].kospi) return anchors[0].fwdPer;
    if (price >= anchors[anchors.length - 1].kospi) {
      const last2 = anchors.slice(-2);
      const slope = (last2[1].fwdPer - last2[0].fwdPer) / (last2[1].kospi - last2[0].kospi);
      return last2[1].fwdPer + slope * (price - last2[1].kospi);
    }
    for (let i = 0; i < anchors.length - 1; i++) {
      if (price >= anchors[i].kospi && price <= anchors[i + 1].kospi) {
        const ratio = (price - anchors[i].kospi) / (anchors[i + 1].kospi - anchors[i].kospi);
        return anchors[i].fwdPer + ratio * (anchors[i + 1].fwdPer - anchors[i].fwdPer);
      }
    }
    return anchors[anchors.length - 1].fwdPer;
  }

  // ── 12개월 선행 PER 계산 ──
  const forwardPer = parseFloat(interpolatePerBand(fwdPerAnchors, kospiPrice).toFixed(1));

  // ── 밴드 위치 계산 (8~12배 밴드 기준) ──
  // 어느 밴드 구간에 위치하는지 표시
  const bandFloor = Math.floor(forwardPer);  // 하한 밴드 (예: 10)
  const bandCeil  = bandFloor + 1;           // 상한 밴드 (예: 11)
  const bandPos   = parseFloat((forwardPer - bandFloor).toFixed(2));  // 밴드 내 위치 (0~1)

  // 현재 위치하는 밴드 레이블 (차트 기준: 8배/9배/10배/11배/12배)
  let nearestBand;
  if (forwardPer <= 8.5)       nearestBand = '8배 밴드';
  else if (forwardPer <= 9.5)  nearestBand = '9배 밴드';
  else if (forwardPer <= 10.5) nearestBand = '10배 밴드';
  else if (forwardPer <= 11.5) nearestBand = '11배 밴드';
  else                          nearestBand = '12배+ 밴드';

  // ── 12개월 선행 PER 밴드 기준 판정 ──
  // 밴드 차트 기준: 8배/9배/10배/11배/12배
  let level, label, colorHex, emoji;
  if (forwardPer < 8.0) {
    level = 'extreme_low';  label = '극저평가';  colorHex = '#059669'; emoji = '🟢🟢';
    // ★ "8배 조반 이하 극소수 사례" — 역사적 매수 기회
  } else if (forwardPer < 9.0) {
    level = 'deep_value';   label = '강저평가';  colorHex = '#10b981'; emoji = '🟢';
    // 8배~9배 밴드 사이 — 강한 저평가
  } else if (forwardPer < 10.0) {
    level = 'undervalued';  label = '저평가';    colorHex = '#34d399'; emoji = '🟩';
    // 9배~10배 밴드 사이
  } else if (forwardPer < 11.0) {
    level = 'fair';         label = '적정';      colorHex = '#3b82f6'; emoji = '🔵';
    // ★ 10배~11배 밴드 사이 — 역사적 평균 구간 (현재 위치 2026년 3월)
  } else if (forwardPer < 12.0) {
    level = 'fair_high';    label = '적정상단';  colorHex = '#f59e0b'; emoji = '🟡';
    // 11배~12배 밴드 사이
  } else if (forwardPer < 13.0) {
    level = 'overvalued';   label = '고평가';    colorHex = '#f97316'; emoji = '🟠';
    // 12배 밴드 돌파
  } else {
    level = 'bubble';       label = '버블주의';  colorHex = '#ef4444'; emoji = '🔴';
    // 13배 이상
  }

  const today = new Date().toISOString().slice(0, 10);
  const kospiStr = kospiPrice.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

  // ── 참고: 시가총액/이익 역산값도 유지 (하위 호환) ──
  const WON_PER_PT = 5002 / 6000;
  const mktCap     = parseFloat((kospiPrice * WON_PER_PT).toFixed(1));

  // 선행 EPS 역산 (선행PER = 코스피 / EPS → EPS = 코스피 / 선행PER)
  // 코스피는 지수이므로 실제 EPS는 pt 단위
  // 순이익 추정: 시총 / PER (조원 단위)
  const estimatedNI = parseFloat((mktCap / forwardPer).toFixed(1));

  return {
    per: forwardPer,          // 메인 표시값 = 12개월 선행 PER
    forwardPer,               // 12개월 선행 PER (FnGuide 컨센서스 기준)
    bandPosition: {
      floor: bandFloor,       // 하한 밴드 (예: 10)
      ceil: bandCeil,         // 상한 밴드 (예: 11)
      pos: bandPos,           // 밴드 내 위치 (0~1)
      nearestBand             // 현재 위치 밴드 레이블
    },
    mktCap,                   // 추정 시가총액 (조원)
    estimatedNI,              // 추정 순이익 (조원)
    level,
    label,
    colorHex,
    emoji,
    kospiRef: kospiPrice,
    date: today,
    note: `12개월 선행PER ${forwardPer}x — ${label} (${nearestBand}) | 코스피 ${kospiStr}pt | 밴드: 8배/9배/10배/11배/12배 기준 | 출처: FnGuide·하나증권 컨센서스`,
    noteKo: `12개월 선행PER ${forwardPer}x (${nearestBand}) — ${label}`,
    source: 'fwd_per_band_2026mar'
  };
}

async function fetchLiveMarketData() {
  console.log('[Market] 실시간 데이터 수집 시작...');

  const [sp500, nasdaq, kospi, usdKrwFx, usdKrwYahoo, brentRaw] = await Promise.all([
    fetchYahooQuote('^GSPC'),
    fetchYahooQuote('^IXIC'),
    fetchYahooQuote('^KS11'),
    fetchUsdKrw(),
    fetchYahooQuote('KRW=X'),
    fetchYahooQuote('BZ=F')   // ★ 브렌트유 선물 (ICE Brent Crude)
  ]);

  let usdKrwRate = 1450.0;
  let usdKrwChange = 0;

  if (usdKrwFx?.rate) usdKrwRate = usdKrwFx.rate;
  else if (usdKrwYahoo?.price) usdKrwRate = usdKrwYahoo.price;

  if (usdKrwYahoo?.changePercent !== undefined) {
    usdKrwChange = parseFloat((usdKrwRate * (usdKrwYahoo.changePercent / 100)).toFixed(2));
  }

  // USD/KRW 이력 기록
  recordUsdKrwHistory(usdKrwRate);
  const usdKrw24h = calcUsdKrw24hTrend(usdKrwRate);

  // 브렌트유 이력 기록
  const brentPrice = brentRaw?.price ?? 75.00;
  recordBrentHistory(brentPrice);
  const brent24h = calcBrent24hTrend(brentPrice);

  // ★ 코스피 PBR 추정
  const kospiPrice = kospi?.price ?? 2612.40;
  const kospiPBR = calcKospiPBR(kospiPrice);
  // ★ 코스피 PER 추정 (일별 캐시)
  const today = new Date().toISOString().slice(0, 10);
  if (!perPbrDailyCache.data || perPbrDailyCache.date !== today) {
    perPbrDailyCache = { data: calcKospiPER(kospiPrice), date: today };
    const _pd = perPbrDailyCache.data;
    console.log(`[PER] ${today} 일별 12개월 선행PER 재계산: ${_pd?.forwardPer}x (${_pd?.bandPosition?.nearestBand ?? '-'}) — ${_pd?.label} | 코스피 ${kospiPrice}pt | 시총 ${_pd?.mktCap?.toFixed(0)}조`);
  }
  const kospiPER = perPbrDailyCache.data;

  const now = new Date();
  const result = {
    timestamp: now.toISOString(),
    usdKrw: usdKrwRate,
    usdKrwChange,
    usdKrwChangePercent: usdKrwYahoo?.changePercent ?? 0,
    usdKrwPrevClose: usdKrwYahoo?.prevClose ?? usdKrwRate,
    usdKrw24hTrend: usdKrw24h,
    sp500: sp500?.price ?? 5923.45,
    sp500Change: sp500?.changePercent ?? 0,
    sp500PrevClose: sp500?.prevClose ?? 5923.45,
    nasdaq: nasdaq?.price ?? 18842.31,
    nasdaqChange: nasdaq?.changePercent ?? 0,
    nasdaqPrevClose: nasdaq?.prevClose ?? 18842.31,
    kospi: kospiPrice,
    kospiChange: kospi?.changePercent ?? 0,
    kospiPrevClose: kospi?.prevClose ?? 2612.40,
    // ★ 코스피 PBR
    kospiPBR: kospiPBR,
    // ★ 코스피 PER (일별 갱신)
    kospiPER: kospiPER,
    // ★ 브렌트유
    brent: brentPrice,
    brentChange: brentRaw?.changePercent ?? 0,
    brentPrevClose: brentRaw?.prevClose ?? brentPrice,
    brent24hTrend: brent24h,
    source: (sp500 || nasdaq || kospi || usdKrwFx) ? 'live' : 'fallback',
    sources: {
      sp500:   sp500     ? 'yahoo_finance' : 'fallback',
      nasdaq:  nasdaq    ? 'yahoo_finance' : 'fallback',
      kospi:   kospi     ? 'yahoo_finance' : 'fallback',
      usdKrw:  usdKrwFx ? 'open_er_api'  : (usdKrwYahoo ? 'yahoo_finance' : 'fallback'),
      brent:   brentRaw  ? 'yahoo_finance' : 'fallback',
      kospiPBR: 'estimated',
      kospiPER: 'estimated_daily'
    }
  };

  console.log(
    `[Market] 완료 | USD/KRW=${result.usdKrw}(24h:${usdKrw24h.changePct ?? 'n/a'}%) | ` +
    `NASDAQ=${result.nasdaq}(${result.nasdaqChange}%) | ` +
    `KOSPI=${result.kospi}(PBR:${kospiPBR?.pbr ?? 'n/a'}x,PER:${kospiPER?.per ?? 'n/a'}x,${kospiPBR?.label ?? '-'}) | ` +
    `Brent=$${result.brent}(${result.brentChange}%, 24h:${brent24h.changePct ?? 'n/a'}%)`
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
//  Fed 금리인상 가능성 뉴스 수집 (Google News RSS)
// =====================================================
const FED_NEWS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6시간 캐시 (매시간 갱신시 연동)

// 출처 신뢰도 등급 맵 (우선순위 정렬용)
const SOURCE_TIER = {
  // 투자은행·자산운용 (최우선)
  'Goldman Sachs':     { tier: 1, type: '투자은행' },
  'JPMorgan':          { tier: 1, type: '투자은행' },
  'Morgan Stanley':    { tier: 1, type: '투자은행' },
  'Bank of America':   { tier: 1, type: '투자은행' },
  'Citigroup':         { tier: 1, type: '투자은행' },
  'Deutsche Bank':     { tier: 1, type: '투자은행' },
  'UBS':               { tier: 1, type: '투자은행' },
  'Barclays':          { tier: 1, type: '투자은행' },
  'BlackRock':         { tier: 2, type: '자산운용' },
  'Vanguard':          { tier: 2, type: '자산운용' },
  'Fidelity':          { tier: 2, type: '자산운용' },
  'PIMCO':             { tier: 2, type: '자산운용' },
  'Bridgewater':       { tier: 2, type: '자산운용' },
  // 프리미엄 금융미디어
  'Bloomberg':         { tier: 3, type: '금융미디어' },
  'Reuters':           { tier: 3, type: '금융미디어' },
  'Financial Times':   { tier: 3, type: '금융미디어' },
  'Wall Street Journal':{ tier: 3, type: '금융미디어' },
  'The Economist':     { tier: 3, type: '금융미디어' },
  "Barron's":          { tier: 3, type: '금융미디어' },
  'Barrons':           { tier: 3, type: '금융미디어' },
  // 메이저 경제매체
  'CNBC':              { tier: 4, type: '경제매체' },
  'MarketWatch':       { tier: 4, type: '경제매체' },
  'Morningstar':       { tier: 4, type: '경제매체' },
  'Forbes':            { tier: 4, type: '경제매체' },
  'The Guardian':      { tier: 4, type: '경제매체' },
  'Investing.com':     { tier: 4, type: '경제매체' },
  'Yahoo Finance':     { tier: 5, type: '금융포털' },
  'Business Insider':  { tier: 5, type: '금융포털' },
};

/**
 * Google News RSS에서 Fed 금리인상 가능성 관련 뉴스를 수집합니다.
 * - 72시간 이내 기사 수집
 * - 출처별 신뢰도로 우선 정렬
 * - 최대 10건 반환
 * - 급증 경보 로직 포함
 */
async function fetchFedRateHikeNews() {
  const queries = [
    'Federal+Reserve+interest+rate+2026',
    'Fed+rate+hike+hawkish+probability',
    'Federal+Reserve+rate+increase+inflation',
    'Fed+hawkish+Goldman+Sachs+JPMorgan+rate',
    'interest+rate+hike+Federal+Reserve+forecast',
    'Fed+rate+outlook+2026+analyst',
    'Federal+Reserve+monetary+policy+rate'
  ];

  const seen = new Set();
  const articles = [];
  const now = Date.now();
  const h72 = now - 72 * 60 * 60 * 1000;  // 72시간 이내 (더 넓은 범위)

  for (const q of queries) {
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const rssText = await fetchText(url);
    if (!rssText) continue;

    const itemMatches = rssText.match(/<item>([\s\S]*?)<\/item>/g) || [];

    for (const item of itemMatches) {
      const dateMatch  = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/);
      const srcMatch   = item.match(/<source[^>]*>([\s\S]*?)<\/source>/);
      const linkMatch  = item.match(/<link>([\s\S]*?)<\/link>/);

      if (!dateMatch || !titleMatch) continue;

      const pubTs = new Date(dateMatch[1]).getTime();
      if (pubTs < h72) continue;

      const rawTitle = titleMatch[1]
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .trim();

      // 중복 방지 (제목 앞 50자 기준)
      const dedupeKey = rawTitle.slice(0, 50).toLowerCase();
      if (seen.has(dedupeKey)) continue;

      // 금리인상 관련성 필터링 — 넓게 적용 (title에 아래 중 하나 이상 포함)
      const lc = rawTitle.toLowerCase();
      const hasFed = (
        lc.includes('fed') || lc.includes('federal reserve') || lc.includes('fomc') ||
        lc.includes('central bank') || lc.includes('rba') || lc.includes('bank of england') ||
        lc.includes('interest rate') || lc.includes('rate decision') || lc.includes('monetary policy')
      );
      const hasHike = (
        lc.includes('rate hike') || lc.includes('rate increase') || lc.includes('raise rate') ||
        lc.includes('hawkish') || lc.includes('higher rate') || lc.includes('rate rise') ||
        lc.includes('tightening') || lc.includes('inflation') || lc.includes('hike probability') ||
        lc.includes('rate cut') || lc.includes('rate outlook') || lc.includes('rate forecast') ||
        lc.includes('rate change') || lc.includes('rate hold')
      );
      const isRelevant = hasFed && hasHike;
      if (!isRelevant) continue;

      seen.add(dedupeKey);

      const srcName = srcMatch
        ? srcMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()
        : 'Unknown';

      const srcInfo = SOURCE_TIER[srcName] || { tier: 9, type: '기타' };
      const link = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim() : '';
      const dateStr = new Date(pubTs).toISOString().slice(0, 16).replace('T', ' ');

      articles.push({
        title:   rawTitle.slice(0, 140),
        source:  srcName,
        srcType: srcInfo.type,
        tier:    srcInfo.tier,
        date:    dateStr,
        ts:      pubTs,
        link,
        ageHours: Math.round((now - pubTs) / 3600000)
      });
    }
  }

  // 정렬: 신뢰도 tier 우선, 동일 tier 내에서 최신순
  articles.sort((a, b) => a.tier !== b.tier ? a.tier - b.tier : b.ts - a.ts);

  // 최대 10건
  const top10 = articles.slice(0, 10);

  // 경보 로직: 24h 이내 기사 수 계산
  const h24 = now - 24 * 60 * 60 * 1000;
  const todayCount     = articles.filter(a => a.ts >= h24).length;
  const yesterdayCount = articles.filter(a => a.ts < h24 && a.ts >= h24 - 24 * 3600000).length;

  // 경보 기준: 24h 이내 5건 이상, 또는 전일 대비 50% 이상 증가
  const changePct = yesterdayCount > 0
    ? parseFloat(((todayCount - yesterdayCount) / yesterdayCount * 100).toFixed(1))
    : (todayCount >= 3 ? 100 : 0);

  const isAlert      = todayCount >= 5 || changePct >= 50;
  const isSurge      = todayCount >= 8 || changePct >= 100;

  let alertLevel = 'normal';
  let alertMsg   = '';
  if (isSurge) {
    alertLevel = 'surge';
    alertMsg   = `🚨 금리인상 뉴스 급증! 24h ${todayCount}건 (전일 대비 +${Math.abs(changePct)}%) — 시장 경계 필요`;
  } else if (isAlert) {
    alertLevel = 'alert';
    alertMsg   = `⚠️ 금리인상 가능성 뉴스 증가 중 (24h ${todayCount}건) — 주의 필요`;
  } else if (todayCount > 0) {
    alertMsg   = `📰 금리인상 관련 뉴스 ${todayCount}건 (72h 이내 총 ${articles.length}건)`;
  } else {
    alertMsg   = `📭 최근 72h 주요 금리인상 뉴스 없음 (총 ${articles.length}건)`;
  }

  console.log(`[FedNews] ${alertMsg}`);

  return {
    articles: top10,
    totalCount:     articles.length,
    todayCount,
    yesterdayCount,
    changePct,
    isAlert,
    isSurge,
    alertLevel,
    alertMsg,
    fetchedAt:  new Date(now).toISOString(),
    windowHours: 72,
    source: 'google_news_rss'
  };
}

async function getFedNewsData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache.fedNews.data && now - cache.fedNews.updatedAt < FED_NEWS_CACHE_TTL_MS) {
    return cache.fedNews.data;
  }
  const data = await fetchFedRateHikeNews();
  cache.fedNews.data = data;
  cache.fedNews.updatedAt = now;
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

  // ── 13. 브렌트유 가격 24시간 상승 여부 ──
  const brentTrend = market.brent24hTrend || calcBrent24hTrend(market.brent ?? 75.0);
  const brentUp = brentTrend.isUp;
  const check13 = {
    id: 13,
    label: '브렌트 유가',
    autoOn: brentUp,
    reason: brentTrend.note || '데이터 누적 중',
    detail: {
      current: market.brent,
      prevClose: market.brentPrevClose,
      changePercent: market.brentChange,
      ref24h: brentTrend.ref24h,
      changePct24h: brentTrend.changePct,
      dataPoints: brentTrend.dataPoints
    }
  };

  // ── 15. 코스피 12개월 선행 PER 밴드 판단 ──
  // ★ 밴드 기준 (이미지 차트): 8배 / 9배 / 10배 / 11배 / 12배
  // ★ 체크 ON 조건: 선행 PER 10배 이하 (역사적 평균 또는 저평가 구간)
  //   → 저평가 매수 기회 신호
  const kospiPerData = market.kospiPER;
  let perCheckOn = false;
  let perReason = '데이터 없음';
  let perDetail = {};

  if (kospiPerData && kospiPerData.forwardPer) {
    const fwdPer = kospiPerData.forwardPer;
    const nearestBand = kospiPerData.bandPosition?.nearestBand ?? '-';
    const perLabel = kospiPerData.label ?? '-';
    // ★ 선행 PER 10배 이하 → 저평가 또는 극저평가 → 체크 ON
    perCheckOn = fwdPer <= 10.0;
    if (perCheckOn) {
      perReason = `12개월 선행PER ${fwdPer.toFixed(1)}x ≤ 10배 — ${perLabel} (${nearestBand}) → 저평가 구간`;
    } else {
      perReason = `12개월 선행PER ${fwdPer.toFixed(1)}x > 10배 — ${perLabel} (${nearestBand}) → 적정 또는 고평가`;
    }
    perDetail = {
      forwardPer: fwdPer,
      nearestBand,
      level: kospiPerData.level,
      label: perLabel,
      kospiRef: kospiPerData.kospiRef,
      bandFloor: kospiPerData.bandPosition?.floor,
      bandCeil: kospiPerData.bandPosition?.ceil,
      threshold: 10.0,  // 체크 ON 기준값
      date: kospiPerData.date
    };
  }

  const check15 = {
    id: 15,
    label: '코스피 12개월 선행 PER',
    autoOn: perCheckOn,
    reason: perReason,
    detail: perDetail
  };

  return {
    timestamp: new Date().toISOString(),
    checks: { 1: check1, 2: check2, 10: check10, 13: check13, 15: check15 },
    summary: {
      usdKrwDown:  check1.autoOn,
      nasdaqUp:    check2.autoOn,
      warNewsUp:   check10.autoOn,
      brentUp:     check13.autoOn,
      kospiPerLow: check15.autoOn,
      autoOnCount: [check1, check2, check10, check13, check15].filter(c => c.autoOn).length
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

// 브렌트유 24시간 이력 조회
app.get('/api/market/brent-history', (req, res) => {
  res.json({
    history: brentHistory,
    count: brentHistory.length,
    oldest: brentHistory.length > 0 ? new Date(brentHistory[0].ts).toISOString() : null,
    latest: brentHistory.length > 0 ? new Date(brentHistory[brentHistory.length - 1].ts).toISOString() : null
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

// ★ Fed 금리인상 뉴스 API
app.get('/api/fed-news', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const data = await getFedNewsData(force);
    const cacheAge = Math.floor((Date.now() - cache.fedNews.updatedAt) / 1000);
    res.setHeader('X-Cache-Age', cacheAge);
    res.setHeader('X-Cache-TTL', Math.floor(FED_NEWS_CACHE_TTL_MS / 1000));
    res.json(data);
  } catch (err) {
    console.error('[FedNews API Error]', err);
    res.status(500).json({ error: err.message, articles: [], alertLevel: 'error', alertMsg: '뉴스 수집 오류' });
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
  console.log(`🏦 Fed 금리뉴스:   /api/fed-news`);
  console.log(`📈 USD/KRW 이력:   /api/market/usdkrw-history`);
  console.log(`🛢️  브렌트유 이력:  /api/market/brent-history`);
  console.log(`📊 PER/PBR:        /api/market (kospiPER, kospiPBR 포함, 매일 갱신)`);

  // 1시간 자동 갱신 스케줄러 시작 (브렌트유 포함)
  startMarketScheduler();
  // ★ PER/PBR 매일 자정 갱신 스케줄러
  startPerPbrDailyScheduler();

  try {
    await getMarketData();
    console.log('✅ 초기 시장 데이터 수집 완료 (USD/KRW, 브렌트유 이력 기록 시작)');
    // 전쟁 뉴스, Fed 뉴스 백그라운드 선로드
    getWarNewsData().then(d => console.log(`✅ 초기 전쟁뉴스 수집 완료: ${d.note}`));
    getFedNewsData().then(d => console.log(`✅ 초기 Fed금리뉴스 수집 완료: ${d.alertMsg}`));
  } catch (e) {
    console.warn('⚠️ 초기 데이터 수집 실패:', e.message);
  }
});
