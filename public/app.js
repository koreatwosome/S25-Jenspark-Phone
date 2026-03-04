// ====================================
//  주식 투자 승률 체크리스트 앱
// ====================================

// ===== 상태 관리 =====
let investmentHistory = JSON.parse(localStorage.getItem('investmentHistory') || '[]');
let historyChart = null;
let currentUsdKrw = 1450.0;
let dramData = [];

// ===== 자동 체크 상태 =====
// 서버에서 내려온 자동 체크 결과를 저장
// { 1: { autoOn: bool, reason: '...' }, 2: {...}, 10: {...} }
let autoCheckState = {};
// 자동 체크가 적용된 항목 추적 (수동 변경 감지용)
let autoAppliedItems = new Set();

// ===== 시장 데이터 갱신 스케줄러 =====
let marketRefreshTimer = null;
let countdownTimer    = null;
let nextRefreshTime   = null;
let lastRefreshTime   = null;
let isRefreshing      = false;

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1시간

// ===== 초기화 =====
document.addEventListener('DOMContentLoaded', () => {
  updateDateTime();
  setInterval(updateDateTime, 1000);
  initTodayInfo();

  // 시장 + 자동체크 동시 로드
  loadMarketDataAndAutoCheck();
  loadDramData();
  updateWinRate();
  renderHistoryPage();

  // Fed 금리인상 뉴스 로드 (체크12 카드)
  loadFedNews();

  // 1시간 주기 자동 갱신
  scheduleNextRefresh();
});

// ===== 페이지 전환 =====
function showPage(pageName) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById('page-' + pageName).classList.add('active');
  document.getElementById('nav-' + pageName).classList.add('active');

  if (pageName === 'history') {
    renderHistoryPage();
    setTimeout(renderHistoryChart, 100);
  }
  if (pageName === 'dram') {
    loadDramData();
  }
}

// ===== 날짜/시간 =====
function updateDateTime() {
  const now = new Date();
  const opts = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'Asia/Seoul'
  };
  const str = new Intl.DateTimeFormat('ko-KR', opts).format(now);
  const el = document.getElementById('current-datetime');
  if (el) el.textContent = str + ' (KST)';
}

function getTodayString() {
  return new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul'
  }).replace(/\. /g, '-').replace('.', '');
}

function getTodayISO() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function getDayOfWeek() {
  const days = ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'];
  return days[new Date().getDay()];
}

function initTodayInfo() {
  const todayEl = document.getElementById('today-date-main');
  if (todayEl) todayEl.textContent = getTodayString() + ' ' + getDayOfWeek();

  const dayLabel = document.getElementById('today-day-label');
  const dow = getDayOfWeek();
  if (dayLabel) {
    dayLabel.textContent = '오늘: ' + getTodayString() + ' (' + dow + ')';
    if (dow === '월요일') {
      dayLabel.style.color = '#f59e0b';
      dayLabel.textContent += ' ⚡ Monday Effect 해당일';
    }
  }
  const dexDate = document.getElementById('dex-date');
  if (dexDate) dexDate.textContent = '(기준일: ' + getTodayString() + ')';
}

// =====================================================
//  시장 데이터 + 자동 체크 통합 로드
// =====================================================
async function loadMarketDataAndAutoCheck(showLoading = false) {
  if (isRefreshing) return;
  isRefreshing = true;
  if (showLoading) setMarketCardsLoading(true);

  try {
    // 시장 데이터와 자동체크 판단을 동시에 요청
    const forceParam = showLoading ? '?force=true' : '';
    const [marketRes, autoCheckRes] = await Promise.all([
      fetch('/api/market' + forceParam),
      fetch('/api/auto-check' + forceParam)
    ]);

    if (marketRes.ok) {
      const data = await marketRes.json();
      updateMarketCards(data);
      currentUsdKrw = data.usdKrw || 1450.0;
      updateDramKrwTable();
      lastRefreshTime = new Date();
      updateRefreshStatus(data);
    }

    if (autoCheckRes.ok) {
      const autoData = await autoCheckRes.json();
      applyAutoChecks(autoData);
    }
  } catch (e) {
    console.warn('[Market] 로드 실패:', e);
    setDefaultMarketData();
    updateRefreshStatusError();
  } finally {
    isRefreshing = false;
    setMarketCardsLoading(false);
  }
}

// ===== 하위 호환 별칭 =====
async function loadMarketData(showLoading = false) {
  return loadMarketDataAndAutoCheck(showLoading);
}

// =====================================================
//  자동 체크 적용 로직
// =====================================================
/**
 * 서버 /api/auto-check 응답을 받아 체크박스를 자동으로 ON/OFF
 * - 이미 수동으로 변경된 항목은 건드리지 않음 (사용자 우선)
 * - 단, 처음 로드 시 or 명시적 force 갱신 시에는 자동 적용
 */
function applyAutoChecks(autoData) {
  if (!autoData?.checks) return;

  autoCheckState = autoData.checks;
  const checks = autoData.checks;

  // 각 자동 체크 항목 처리
  Object.values(checks).forEach(chk => {
    const id = chk.id;
    const chkEl = document.getElementById('chk-' + id);
    const selEl = document.getElementById('sel-' + id);
    if (!chkEl) return;

    const wasManuallyChanged = autoAppliedItems.has(id) && chkEl.dataset.manualOverride === 'true';
    if (wasManuallyChanged) return; // 수동 변경 항목 스킵

    // 자동 체크 적용
    if (chk.autoOn !== chkEl.checked) {
      chkEl.checked = chk.autoOn;
      chkEl.dataset.autoSet = 'true';

      // 자동 체크 ON 시 셀렉트박스도 해당 값으로 설정
      if (selEl && chk.autoOn) {
        // 각 항목별로 적절한 value 설정
        if (id === 1) selEl.value = 'positive';  // 환율 하락 = 긍정
        if (id === 2) selEl.value = 'positive';  // 나스닥 상승 = 긍정
        if (id === 10) selEl.value = 'negative'; // 전쟁뉴스 급증 = 부정 (위험 신호)
      } else if (selEl && !chk.autoOn) {
        if (!selEl.value) selEl.value = '';
      }
    }

    autoAppliedItems.add(id);

    // 자동체크 배지 업데이트
    updateAutoCheckBadge(id, chk);
  });

  updateWinRate();
  showAutoCheckToast(autoData.summary);
}

/**
 * 자동 체크 결과 배지를 카드에 표시
 */
function updateAutoCheckBadge(id, chk) {
  const card = document.getElementById('card-' + id);
  if (!card) return;

  // 기존 배지 제거
  const existing = card.querySelector('.auto-check-badge');
  if (existing) existing.remove();

  const badge = document.createElement('div');
  badge.className = 'auto-check-badge';

  if (chk.autoOn) {
    badge.innerHTML = `<span class="acb-icon acb-on">🤖 자동 ON</span><span class="acb-reason">${escHtml(chk.reason)}</span>`;
    card.classList.add('auto-checked');
  } else {
    badge.innerHTML = `<span class="acb-icon acb-off">🤖 자동분석</span><span class="acb-reason">${escHtml(chk.reason)}</span>`;
    card.classList.remove('auto-checked');
  }

  // 체크 카드 하단에 배지 삽입
  const detail = card.querySelector('.check-detail');
  if (detail) detail.appendChild(badge);

  // 전쟁 뉴스 항목(10번)에는 헤드라인 표시
  if (id === 10 && chk.detail?.headlines?.length > 0) {
    updateWarNewsHeadlines(card, chk.detail);
  }
}

/**
 * 전쟁 뉴스 헤드라인 표시
 */
function updateWarNewsHeadlines(card, detail) {
  const existing = card.querySelector('.war-news-headlines');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'war-news-headlines';
  div.innerHTML = `
    <div class="wnh-header">
      <i class="fas fa-newspaper"></i>
      오늘 뉴스 <strong>${detail.todayCount}건</strong> / 어제 ${detail.yesterdayCount}건
      <span class="wnh-change ${detail.changePct >= 5 ? 'wnh-up' : 'wnh-neutral'}">
        ${detail.changePct > 0 ? '+' : ''}${detail.changePct}%
      </span>
    </div>
    <ul class="wnh-list">
      ${(detail.headlines || []).slice(0, 3).map(h =>
        `<li><span class="wnh-date">${h.date?.slice(5,16) || ''}</span> ${escHtml(h.title)}</li>`
      ).join('')}
    </ul>`;

  const detail2 = card.querySelector('.check-detail');
  if (detail2) detail2.appendChild(div);
}

/**
 * 자동 체크 결과 토스트 알림
 */
function showAutoCheckToast(summary) {
  if (!summary) return;
  const msgs = [];
  if (summary.usdKrwDown)  msgs.push('💱 USD/KRW 하락 → 체크1 ON');
  if (summary.nasdaqUp)    msgs.push('📈 NASDAQ 상승 → 체크2 ON');
  if (summary.warNewsUp)   msgs.push('⚔️ 전쟁뉴스 급증 → 체크10 ON');
  if (summary.brentUp)     msgs.push('🛢️ 브렌트유 상승 → 체크13 ON');

  if (msgs.length > 0) {
    showToast('🤖 자동체크: ' + msgs.join(' | '), 5000);
  }
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// =====================================================
//  1시간 주기 갱신 스케줄러
// =====================================================
function scheduleNextRefresh() {
  if (marketRefreshTimer) clearTimeout(marketRefreshTimer);
  if (countdownTimer)     clearInterval(countdownTimer);

  nextRefreshTime = new Date(Date.now() + REFRESH_INTERVAL_MS);

  marketRefreshTimer = setTimeout(async () => {
    console.log('[Market] 1시간 주기 자동 갱신');
    await loadMarketDataAndAutoCheck(false);
    // Fed 뉴스도 매시간 함께 갱신
    loadFedNews();
    scheduleNextRefresh();
  }, REFRESH_INTERVAL_MS);

  countdownTimer = setInterval(updateCountdownDisplay, 1000);
  updateCountdownDisplay();
}

function updateCountdownDisplay() {
  if (!nextRefreshTime) return;
  const remaining = nextRefreshTime - Date.now();
  if (remaining <= 0) { updateCountdownEl('갱신 중...'); return; }
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  updateCountdownEl(`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
}
function updateCountdownEl(text) {
  const el = document.getElementById('market-countdown');
  if (el) el.textContent = text;
}

// ===== 수동 갱신 =====
async function manualRefreshMarket() {
  if (isRefreshing) return;
  // 자동 체크 적용 상태 초기화 (재분석 허용)
  autoAppliedItems.clear();
  // 카드의 manualOverride 플래그도 초기화
  document.querySelectorAll('[data-manual-override]').forEach(el => {
    el.dataset.manualOverride = 'false';
  });
  scheduleNextRefresh();
  await loadMarketDataAndAutoCheck(true);
  loadFedNews(true); // 수동 갱신 시 Fed 뉴스도 강제 갱신
  showToast('📡 시장 데이터, 자동 체크, Fed 뉴스를 실시간으로 갱신했습니다.', 3000);
}

// ===== 갱신 상태 UI =====
function updateRefreshStatus(data) {
  const timeEl   = document.getElementById('market-last-update');
  const sourceEl = document.getElementById('market-source-badge');

  if (timeEl && lastRefreshTime) {
    timeEl.textContent = lastRefreshTime.toLocaleTimeString('ko-KR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: 'Asia/Seoul'
    }) + ' (KST)';
  }
  if (sourceEl) {
    if (data.source === 'live') {
      sourceEl.textContent = '● 실시간'; sourceEl.className = 'source-badge live';
    } else {
      sourceEl.textContent = '○ 기본값'; sourceEl.className = 'source-badge fallback';
    }
  }
}
function updateRefreshStatusError() {
  const el = document.getElementById('market-source-badge');
  if (el) { el.textContent = '✗ 오류'; el.className = 'source-badge error'; }
}
function setMarketCardsLoading(isLoading) {
  const refreshBtn = document.getElementById('market-refresh-btn');
  if (refreshBtn) {
    refreshBtn.disabled = isLoading;
    refreshBtn.innerHTML = isLoading
      ? '<i class="fas fa-spinner fa-spin"></i>'
      : '<i class="fas fa-sync-alt"></i>';
  }
  if (isLoading) {
    ['usd-krw-value','sp500-value','nasdaq-value','kospi-value'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '갱신중...';
    });
  }
}

// =====================================================
//  시장 카드 UI 업데이트
// =====================================================
function updateMarketCards(data) {
  // USD/KRW
  setCardValue('usd-krw-value', data.usdKrw
    ? data.usdKrw.toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' ₩'
    : '--');
  setCardChange('usd-krw-change', data.usdKrwChangePercent ?? 0, '%');

  // USD/KRW 24h 트렌드 배지
  const trendEl = document.getElementById('usd-krw-24h-trend');
  if (trendEl && data.usdKrw24hTrend) {
    const t = data.usdKrw24hTrend;
    if (t.changePct !== null && t.dataPoints >= 2) {
      const isDown = t.changePct < 0;
      trendEl.textContent = `24h: ${isDown ? '▼' : '▲'} ${Math.abs(t.changePct).toFixed(2)}%`;
      trendEl.className = 'mc-24h-trend ' + (isDown ? 'trend-down' : 'trend-up');
      trendEl.title = t.note;
    } else {
      trendEl.textContent = `24h 누적중 (${t.dataPoints}pts)`;
      trendEl.className = 'mc-24h-trend trend-neutral';
    }
  }

  // S&P500
  setCardValue('sp500-value', data.sp500
    ? data.sp500.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
    : '--');
  setCardChange('sp500-change', data.sp500Change ?? 0, '%');

  // NASDAQ
  setCardValue('nasdaq-value', data.nasdaq
    ? data.nasdaq.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
    : '--');
  setCardChange('nasdaq-change', data.nasdaqChange ?? 0, '%');

  // KOSPI
  setCardValue('kospi-value', data.kospi
    ? data.kospi.toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2})
    : '--');
  setCardChange('kospi-change', data.kospiChange ?? 0, '%');

  // ─── 코스피 PBR 배지 ───
  updateKospiPBR(data.kospiPBR);
  // ─── 코스피 PER 배지 ───
  updateKospiPER(data.kospiPER);

  // D램 환산 환율
  const dexEl = document.getElementById('dex-usd-krw');
  if (dexEl && data.usdKrw) {
    dexEl.textContent = data.usdKrw.toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2});
  }

  // ─── Brent Oil 카드 (상단 마켓 카드) ───
  if (data.brent) {
    setCardValue('brent-value', '$' + data.brent.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));
    setCardChange('brent-change', data.brentChange ?? 0, '%');

    // 상단 카드 24h 트렌드 배지
    const brentTrendCard = document.getElementById('brent-24h-trend-card');
    if (brentTrendCard && data.brent24hTrend) {
      const t = data.brent24hTrend;
      if (t.changePct !== null && t.dataPoints >= 2) {
        const isUp = t.changePct > 0;
        brentTrendCard.textContent = `24h: ${isUp ? '▲' : '▼'} ${Math.abs(t.changePct).toFixed(2)}%`;
        brentTrendCard.className = 'mc-24h-trend ' + (isUp ? 'trend-up' : 'trend-down');
        brentTrendCard.title = t.note || '';
      } else {
        brentTrendCard.textContent = `24h 누적중 (${t.dataPoints}pts)`;
        brentTrendCard.className = 'mc-24h-trend trend-neutral';
      }
    }

    // ─── Brent Oil 체크리스트 카드 내부 표시 (card-13) ───
    const brentPriceVal = document.getElementById('brent-price-value');
    if (brentPriceVal) {
      brentPriceVal.textContent = '$' + data.brent.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    }
    const brentPriceChange = document.getElementById('brent-price-change');
    if (brentPriceChange) {
      const chg = data.brentChange ?? 0;
      const isUp = chg > 0;
      const isZero = chg === 0;
      brentPriceChange.textContent = isZero ? '변동없음' : (isUp ? '▲ +' : '▼ ') + Math.abs(chg).toFixed(2) + '%';
      brentPriceChange.className = 'bpd-change ' + (isZero ? 'neutral' : isUp ? 'up' : 'down');
    }
    const brentTrend24h = document.getElementById('brent-24h-trend');
    if (brentTrend24h && data.brent24hTrend) {
      const t = data.brent24hTrend;
      if (t.changePct !== null && t.dataPoints >= 2) {
        const isUp = t.changePct > 0;
        brentTrend24h.textContent = `24h: ${isUp ? '▲' : '▼'} ${Math.abs(t.changePct).toFixed(2)}%`;
        brentTrend24h.className = 'bpd-trend ' + (isUp ? 'bpd-up' : 'bpd-down');
      } else {
        brentTrend24h.textContent = `24h 데이터 누적 중 (${t.dataPoints}pts)`;
        brentTrend24h.className = 'bpd-trend bpd-neutral';
      }
    }
  }

  // 카드 테두리 색상 (USD/KRW & Brent)
  const usdCard = document.getElementById('usd-krw-card');
  if (usdCard) {
    usdCard.classList.remove('card-up','card-down');
    if ((data.usdKrwChangePercent ?? 0) > 0) usdCard.classList.add('card-up');
    else if ((data.usdKrwChangePercent ?? 0) < 0) usdCard.classList.add('card-down');
  }
  const brentCard = document.getElementById('brent-card');
  if (brentCard && data.brent24hTrend) {
    const t = data.brent24hTrend;
    brentCard.classList.remove('card-up','card-down');
    if (t.dataPoints >= 2 && t.changePct !== null) {
      if (t.changePct > 0) brentCard.classList.add('card-up');
      else if (t.changePct < 0) brentCard.classList.add('card-down');
    }
  }
}

function setCardValue(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function setCardChange(id, val, unit = '') {
  const el = document.getElementById(id);
  if (!el) return;
  const isZero = val === 0;
  if (isZero) { el.textContent = '변동없음'; el.className = 'mc-change neutral'; return; }
  const isUp = val > 0;
  el.textContent = (isUp ? '▲' : '▼') + ' ' + Math.abs(val).toFixed(2) + unit;
  el.className = 'mc-change ' + (isUp ? 'up' : 'down');
}

function setDefaultMarketData() {
  updateMarketCards({
    usdKrw: 1450.0, usdKrwChangePercent: 0,
    sp500: 5923.45, sp500Change: 0,
    nasdaq: 18842.31, nasdaqChange: 0,
    kospi: 2612.40, kospiChange: 0,
    kospiPBR: null, kospiPER: null,
    source: 'fallback'
  });
  currentUsdKrw = 1450.0;
  updateRefreshStatus({ source: 'fallback' });
}

// =====================================================
//  코스피 PBR 배지 업데이트
// =====================================================
/**
 * 서버에서 받은 kospiPBR 객체를 KOSPI 카드에 표시합니다.
 * 수치가 낮을수록 초록색(저평가), 높을수록 빨간색(고평가)
 */
function updateKospiPBR(pbrData) {
  const badgeEl = document.getElementById('kospi-pbr-badge');
  const levelEl = document.getElementById('kospi-pbr-level');
  const rowEl   = document.getElementById('kospi-pbr-row');
  const kospiCard = document.getElementById('kospi-card');

  if (!badgeEl) return;

  if (!pbrData || pbrData.pbr === undefined || pbrData.pbr === null) {
    badgeEl.textContent = '--';
    badgeEl.style.background = '#94a3b8';
    badgeEl.style.color = '#fff';
    if (levelEl) levelEl.textContent = '';
    return;
  }

  const pbr = pbrData.pbr;
  const label = pbrData.label || '';
  const colorHex = pbrData.colorHex || '#f59e0b';
  const note = pbrData.note || '';

  // 배지 업데이트
  badgeEl.textContent = pbr.toFixed(2) + 'x';
  badgeEl.style.background = colorHex;
  badgeEl.style.color = '#fff';
  if (rowEl) rowEl.title = note;

  // 레벨 텍스트
  if (levelEl) {
    levelEl.textContent = label;
    levelEl.style.color = colorHex;
  }

  // 카드 PBR 강조 클래스 업데이트
  if (kospiCard) {
    kospiCard.classList.remove(
      'pbr-extreme-low','pbr-undervalued','pbr-fair-low',
      'pbr-fair','pbr-fair-high','pbr-overvalued','pbr-bubble'
    );
    const levelClass = {
      'extreme_low': 'pbr-extreme-low',
      'undervalued':  'pbr-undervalued',
      'fair_low':     'pbr-fair-low',
      'fair':         'pbr-fair',
      'fair_high':    'pbr-fair-high',
      'overvalued':   'pbr-overvalued',
      'bubble':       'pbr-bubble'
    }[pbrData.level];
    if (levelClass) kospiCard.classList.add(levelClass);
  }
}

// =====================================================
//  코스피 PER 배지 업데이트 (매일 갱신)
// =====================================================
/**
 * 서버에서 받은 kospiPER 객체를 KOSPI 카드에 표시합니다.
 * - 메인 배지: Forward PER (선행 PER, 향후 12개월 예상이익 기준 — FnGuide 컨센서스)
 * - 보조 표시: Trailing PER (후행 PER, 과거 12개월 실적 기준 — CEIC 실측)
 *
 * ★ 2026년 3월 기준 실제 수치:
 *   선행PER(Forward): 코스피 6000pt ≈ 10.0~10.7배 (FnGuide/신영증권/삼성증권)
 *   후행PER(Trailing): 코스피 6000pt ≈ 26배 (CEIC 실측 26.04x, 2026-03-02)
 *   ※ 유튜브 "PER 8배" = 삼성전자(8.6배)·SK하이닉스(5.3배) 개별 종목 기준
 *      코스피 전체 선행PER은 10배 수준 (역사적 평균 근방)
 *
 * 수치가 낮을수록 초록색(저평가), 높을수록 빨간색(고평가)
 * 매일 갱신됩니다.
 */
function updateKospiPER(perData) {
  const badgeEl   = document.getElementById('kospi-per-badge');
  const subEl     = document.getElementById('kospi-per-sub');
  const levelEl   = document.getElementById('kospi-per-level');
  const rowEl     = document.getElementById('kospi-per-row');
  const kospiCard = document.getElementById('kospi-card');

  if (!badgeEl) return;

  if (!perData || perData.per === undefined || perData.per === null) {
    badgeEl.textContent = '--';
    badgeEl.style.background = '#94a3b8';
    badgeEl.style.color = '#fff';
    if (subEl)   subEl.textContent = '';
    if (levelEl) levelEl.textContent = '';
    return;
  }

  const forwardPer  = perData.forwardPer  ?? perData.per;
  const trailingPer = perData.trailingPer ?? null;
  const label    = perData.label    || '';
  const colorHex = perData.colorHex || '#f59e0b';
  const date     = perData.date     || '';

  // ── 메인 배지: 선행 PER (Forward PER) ──
  badgeEl.textContent = '선행' + forwardPer.toFixed(1) + 'x';
  badgeEl.style.background = colorHex;
  badgeEl.style.color = '#fff';

  // ── 툴팁: 출처 및 설명 ──
  const tooltipText = [
    `📊 코스피 PER (${date} 기준)`,
    `선행PER(12개월 예상): ${forwardPer.toFixed(1)}x — ${label}`,
    trailingPer ? `후행PER(과거12개월): ${trailingPer.toFixed(1)}x` : '',
    ``,
    `출처: FnGuide·신영증권·삼성증권 컨센서스`,
    `역사적 평균: 10.3배 (최근 10년)`,
    `과거 강세장 상단: ~12배`,
    ``,
    `※ "PER 8배" 유튜브 언급은`,
    `  삼성전자(8.6x)·SK하이닉스(5.3x)`,
    `  개별 종목 기준 (코스피 전체 ≠ 8배)`,
  ].filter(Boolean).join('\n');
  if (rowEl) rowEl.title = tooltipText;

  // ── 보조 표시: 후행 PER ──
  if (subEl && trailingPer !== null) {
    subEl.textContent = `후행${trailingPer.toFixed(1)}x`;
  } else if (subEl) {
    subEl.textContent = '';
  }

  // ── 레벨 텍스트 ──
  if (levelEl) {
    levelEl.textContent = label;
    levelEl.style.color = colorHex;
  }

  // ── 카드 PER 강조 클래스 ──
  if (kospiCard) {
    kospiCard.classList.remove(
      'per-extreme-low','per-undervalued','per-fair-low',
      'per-fair','per-fair-high','per-overvalued','per-bubble'
    );
    const levelClass = {
      'extreme_low': 'per-extreme-low',
      'undervalued':  'per-undervalued',
      'fair_low':     'per-fair-low',
      'fair':         'per-fair',
      'fair_high':    'per-fair-high',
      'overvalued':   'per-overvalued',
      'bubble':       'per-bubble'
    }[perData.level];
    if (levelClass) kospiCard.classList.add(levelClass);
  }
}

// =====================================================
//  체크박스 수동 변경 감지
// =====================================================
// 사용자가 자동체크된 항목을 수동 변경 시 autoOn 상태 무효화
document.addEventListener('change', e => {
  const target = e.target;
  if (!target.matches('input[type="checkbox"]')) return;
  const idMatch = target.id.match(/^chk-(\d+)$/);
  if (!idMatch) return;
  const num = parseInt(idMatch[1]);

  if (target.dataset.autoSet === 'true') {
    // 이번 change는 자동 적용에 의한 것 — 플래그 해제만
    target.dataset.autoSet = 'false';
    return;
  }

  // 수동 변경 → manualOverride 마크
  target.dataset.manualOverride = 'true';
  // 자동체크 배지 업데이트 (회색으로)
  const card = document.getElementById('card-' + num);
  if (card) {
    const badge = card.querySelector('.auto-check-badge');
    if (badge) badge.classList.add('acb-manual-override');
    card.classList.remove('auto-checked');
  }
});

// =====================================================
//  승률 업데이트
// =====================================================
// 체크리스트 총 항목 수 (DOM에서 동적 계산)
function getTotalCheckItems() {
  var max = 0;
  document.querySelectorAll('[id^="chk-"]').forEach(function(el) {
    var m = el.id.match(/^chk-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1]));
  });
  return max;
}

function updateWinRate() {
  var total = getTotalCheckItems(); // 현재 DOM 항목 수 (14)
  var count = 0;
  for (var i = 1; i <= total; i++) {
    var chk = document.getElementById('chk-' + i);
    if (chk && chk.checked) count++;
  }
  // 항목당 10% 포션, 10개 초과 시 100% 넘을 수 있음
  var rate = count * 10;

  var circle = document.getElementById('win-rate-display');
  if (circle) {
    var color = rate >= 70 ? '#16a34a' : rate >= 40 ? '#d97706' : '#ea580c';
    if (rate > 100) color = '#7c3aed';
    var displayPct = Math.min(rate, 100);
    circle.style.background = 'conic-gradient(' + color + ' ' + displayPct + '%, #fde8d4 ' + displayPct + '%)';
    circle.style.boxShadow = rate > 100 ? '0 0 0 4px #7c3aed44' : '';
  }

  var rateNum = document.getElementById('rate-number');
  if (rateNum) {
    rateNum.textContent = rate;
    rateNum.style.color = rate > 100 ? '#7c3aed' : '';
    rateNum.style.fontWeight = rate > 100 ? '800' : '';
  }

  ['checked-count','checked-count-bottom'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.textContent = count;
  });
  var rateText = document.getElementById('rate-text');
  if (rateText) rateText.textContent = rate + '%';

  var progressBar = document.getElementById('progress-bar');
  if (progressBar) progressBar.style.width = Math.min(rate, 100) + '%';

  updateGrade(rate);

  for (var j = 1; j <= total; j++) {
    var card = document.getElementById('card-' + j);
    var chkJ = document.getElementById('chk-' + j);
    if (card && chkJ) {
      if (chkJ.checked) card.classList.add('checked');
      else card.classList.remove('checked');
    }
  }
}

function updateGrade(rate) {
  const gradeEl = document.getElementById('rate-grade');
  if (!gradeEl) return;
  let icon, text, color;
  if (rate > 100)      { icon = '💎'; text = '초과달성 - 최적 매수'; color = '#7c3aed'; }
  else if (rate >= 90) { icon = '🚀'; text = '최상 - 적극 매수'; color = '#15803d'; }
  else if (rate >= 70) { icon = '✅'; text = '양호 - 매수 고려'; color = '#16a34a'; }
  else if (rate >= 50) { icon = '👀'; text = '중립 - 관망 권장'; color = '#d97706'; }
  else if (rate >= 30) { icon = '⚠️'; text = '주의 - 신중 접근'; color = '#ea580c'; }
  else if (rate > 0)   { icon = '🛑'; text = '위험 - 매수 자제'; color = '#dc2626'; }
  else                 { icon = '🤔'; text = '아직 체크 전';     color = '#a07850'; }
  gradeEl.innerHTML = `<span class="grade-icon">${icon}</span><span class="grade-text" style="color:${color}">${text}</span>`;
}

function updateCardStatus(num) {
  const sel = document.getElementById('sel-' + num);
  const chk = document.getElementById('chk-' + num);
  if (!sel || !chk) return;
  const val = sel.value;
  if (val === 'positive') chk.checked = true;
  else if (val === 'negative' || val === '') chk.checked = false;
  // 수동 변경 마크
  chk.dataset.manualOverride = 'true';
  updateWinRate();
}

function toggleChip(el) { el.classList.toggle('active'); }

// =====================================================
//  투자 확정
// =====================================================
function confirmInvestment() {
  const count = parseInt(document.getElementById('checked-count')?.textContent || '0');
  const rate  = count * 10; // 항목당 10%, 100% 초과 가능

  document.getElementById('modal-rate-display').textContent = rate + '%';
  document.getElementById('modal-date-display').textContent = getTodayString() + ' (' + getDayOfWeek() + ')';

  let gradeText, gradeColor;
  if (rate >= 90)      { gradeText = '🚀 최상 - 적극 매수'; gradeColor = '#22c55e'; }
  else if (rate >= 70) { gradeText = '✅ 양호 - 매수 고려'; gradeColor = '#10b981'; }
  else if (rate >= 50) { gradeText = '👀 중립 - 관망 권장'; gradeColor = '#f59e0b'; }
  else if (rate >= 30) { gradeText = '⚠️ 주의 - 신중 접근'; gradeColor = '#ef4444'; }
  else                 { gradeText = '🛑 위험 - 매수 자제'; gradeColor = '#dc2626'; }

  const modalGrade = document.getElementById('modal-grade-display');
  if (modalGrade) { modalGrade.textContent = gradeText; modalGrade.style.color = gradeColor; }
  document.getElementById('confirm-modal')?.classList.add('open');
}

function closeModal() { document.getElementById('confirm-modal')?.classList.remove('open'); }

function saveInvestment() {
  const count = parseInt(document.getElementById('checked-count')?.textContent || '0');
  const rate  = count * 10; // 항목당 10%, 100% 초과 가능
  const today = getTodayISO();

  const itemNames = [
    'USD/KRW 환율','전날 미국장','815 채널','증시각도기',
    '외국인 지분','ETF 자금','연준 발언','Monday 효과',
    '빅테크 실적','전쟁/지정학','파산 뉴스','기타 이슈',
    '브렌트 유가','ASPIM Research'
  ];
  const checkedItems = [];
  const total = getTotalCheckItems();
  for (let i = 1; i <= total; i++) {
    const chk = document.getElementById('chk-' + i);
    if (chk?.checked) checkedItems.push(itemNames[i-1] || ('항목' + i));
  }

  const existingIdx = investmentHistory.findIndex(h => h.date === today);
  const record = {
    date: today, displayDate: getTodayString(), dayOfWeek: getDayOfWeek(),
    rate, checkedCount: count, checkedItems, memo: '',
    savedAt: new Date().toISOString()
  };
  if (existingIdx >= 0) { record.memo = investmentHistory[existingIdx].memo || ''; investmentHistory[existingIdx] = record; }
  else investmentHistory.unshift(record);

  localStorage.setItem('investmentHistory', JSON.stringify(investmentHistory));
  closeModal();
  showToast('✅ 오늘의 승률 ' + rate + '%가 투자 이력에 저장되었습니다!');
}

// =====================================================
//  투자 이력 렌더링
// =====================================================
function renderHistoryPage() {
  const totalEl = document.getElementById('total-records');
  const avgEl   = document.getElementById('avg-rate');
  const maxEl   = document.getElementById('max-rate');

  if (investmentHistory.length > 0) {
    const avg = (investmentHistory.reduce((s, h) => s + h.rate, 0) / investmentHistory.length).toFixed(1);
    const max = Math.max(...investmentHistory.map(h => h.rate));
    if (totalEl) totalEl.textContent = investmentHistory.length;
    if (avgEl)   avgEl.textContent   = avg + '%';
    if (maxEl)   maxEl.textContent   = max + '%';
  } else {
    if (totalEl) totalEl.textContent = '0';
    if (avgEl)   avgEl.textContent   = '0%';
    if (maxEl)   maxEl.textContent   = '0%';
  }
  renderHistoryList(investmentHistory);
}

function renderHistoryList(data) {
  const listEl = document.getElementById('history-list');
  if (!listEl) return;
  if (data.length === 0) {
    listEl.innerHTML = `<div class="empty-history"><i class="fas fa-inbox"></i><p>아직 확정된 투자 이력이 없습니다.</p><p class="small">체크리스트에서 '오늘 승률 확정하기'를 눌러 기록을 추가하세요.</p></div>`;
    return;
  }
  listEl.innerHTML = data.map(item => {
    const realIdx = investmentHistory.indexOf(item);
    let rateClass = 'rate-low', gradeClass = 'grade-low', gradeText = '위험';
    if (item.rate >= 70) { rateClass = 'rate-high'; gradeClass = 'grade-high'; gradeText = '양호+'; }
    else if (item.rate >= 40) { rateClass = 'rate-mid'; gradeClass = 'grade-mid'; gradeText = '중립'; }
    const checkedStr = (item.checkedItems || []).map(c => `<span style="font-size:0.7rem;padding:2px 6px;background:rgba(59,130,246,0.1);border-radius:4px;color:#94a3b8;margin:2px">${c}</span>`).join('');
    return `<div class="history-item" id="hi-${realIdx}">
      <div class="hi-date">${item.displayDate||item.date}<span>${item.dayOfWeek||''}</span><div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:2px">${checkedStr}</div></div>
      <div class="hi-rate"><div class="hi-rate-num ${rateClass}">${item.rate}<span style="font-size:1rem">%</span></div><div class="hi-rate-label">투자 승률</div><span class="hi-grade ${gradeClass}">${gradeText}</span></div>
      <div class="hi-memo-area"><div class="hi-memo-label"><i class="fas fa-pen"></i> 투자 일기 메모</div><textarea class="hi-memo-input" id="hi-memo-${realIdx}" placeholder="오늘의 투자 일기를 작성하세요...">${item.memo||''}</textarea></div>
      <div class="hi-actions">
        <button class="hi-save-btn" onclick="saveMemo(${realIdx})"><i class="fas fa-save"></i> 저장</button>
        <button class="hi-del-btn" onclick="deleteHistoryItem(${realIdx})"><i class="fas fa-trash"></i> 삭제</button>
      </div></div>`;
  }).join('');
}

function saveMemo(idx) {
  const memoEl = document.getElementById('hi-memo-' + idx);
  if (!memoEl || !investmentHistory[idx]) return;
  investmentHistory[idx].memo = memoEl.value;
  localStorage.setItem('investmentHistory', JSON.stringify(investmentHistory));
  showToast('📝 메모가 저장되었습니다.');
}
function deleteHistoryItem(idx) {
  if (!confirm('이 기록을 삭제하시겠습니까?')) return;
  investmentHistory.splice(idx, 1);
  localStorage.setItem('investmentHistory', JSON.stringify(investmentHistory));
  renderHistoryPage(); setTimeout(renderHistoryChart, 100);
  showToast('🗑️ 기록이 삭제되었습니다.');
}
function clearAllHistory() {
  if (!confirm('전체 투자 이력을 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;
  investmentHistory = [];
  localStorage.setItem('investmentHistory', JSON.stringify(investmentHistory));
  renderHistoryPage(); setTimeout(renderHistoryChart, 100);
  showToast('🗑️ 전체 이력이 삭제되었습니다.');
}
function filterHistory() {
  const q = document.getElementById('history-search').value.toLowerCase();
  renderHistoryList(investmentHistory.filter(h =>
    (h.displayDate||h.date||'').includes(q) || (h.memo||'').toLowerCase().includes(q) ||
    (h.dayOfWeek||'').includes(q) || (h.checkedItems||[]).some(c=>c.toLowerCase().includes(q))
  ));
}

// =====================================================
//  차트
// =====================================================
function renderHistoryChart() {
  const canvas = document.getElementById('history-chart');
  if (!canvas) return;
  if (historyChart) { historyChart.destroy(); historyChart = null; }
  const sorted = [...investmentHistory].sort((a,b)=>a.date>b.date?1:-1).slice(-30);
  if (sorted.length === 0) return;
  historyChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: sorted.map(h => h.displayDate||h.date),
      datasets: [{ label: '투자 승률 (%)', data: sorted.map(h=>h.rate),
        borderColor: '#d97706', backgroundColor: 'rgba(217,119,6,0.07)', borderWidth: 2.5,
        pointRadius: 5, pointHoverRadius: 8,
        pointBackgroundColor: sorted.map(r => r.rate >= 70 ? '#16a34a' : r.rate >= 40 ? '#d97706' : '#dc2626'),
        pointBorderColor: '#ffffff', pointBorderWidth: 2, fill: true, tension: 0.4 }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false },
        tooltip: { backgroundColor:'#ffffff', titleColor:'#1c1209', bodyColor:'#6b4c30', borderColor:'#f0dece', borderWidth:1.5,
          callbacks: { label: ctx => '승률: ' + ctx.parsed.y + '%' } }
      },
      scales: {
        x: { grid:{color:'rgba(240,222,206,0.8)'}, ticks:{color:'#a07850',font:{size:11}} },
        y: { min:0, max:120, grid:{color:'rgba(240,222,206,0.8)'},
          ticks:{color:'#a07850',font:{size:11},callback:v=>v+'%'} }
      }
    }
  });
}

// =====================================================
//  D램 데이터
// =====================================================
function loadDramData() {
  dramData = [
    { name:'DDR5 16Gb (2Gx8)', spec:'4800/5600 현물', spot:39.50, prevSpot:39.33, type:'현물가', id:'ddr5' },
    { name:'DDR5 16Gb eTT',    spec:'Entry-Level',    spot:20.60, prevSpot:20.50, type:'현물가', id:'ddr5-32' },
    { name:'DDR4 16Gb (2Gx8)', spec:'3200 현물',       spot:79.91, prevSpot:79.36, type:'현물가', id:'ddr4' },
    { name:'DDR4 8Gb (1Gx8)',  spec:'3200 현물',       spot:32.90, prevSpot:32.80, type:'현물가', id:'ddr4-16' },
    { name:'LPDDR5 16Gb',      spec:'Mobile / 계약가', spot:11.50, prevSpot:10.80, type:'계약가', id:'lpddr5' },
    { name:'LPDDR5X 16Gb',     spec:'Mobile Premium',  spot:14.20, prevSpot:13.30, type:'계약가', id:'lpddr5x' },
    { name:'HBM3 8GB Stack',   spec:'AI/HPC 계약가',   spot:235.00,prevSpot:220.00,type:'계약가', id:'hbm3' },
    { name:'HBM3E 24GB Stack', spec:'AI Server 계약가', spot:420.00,prevSpot:390.00,type:'계약가', id:'hbm3e' }
  ];
  updateDramCards(); updateDramKrwTable(); updateDramStocks();
  const updStr = '데이터 기준: 2026.02.27 (DRAMeXchange)';
  ['ddr5-updated','ddr4-updated','lpddr5-updated','hbm3-updated'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = updStr;
  });
}

function updateDramCards() {
  if (dramData.length < 7) return;
  [{ pi:'ddr5-price', ci:'ddr5-change', i:0 },{ pi:'ddr4-price', ci:'ddr4-change', i:2 },
   { pi:'lpddr5-price', ci:'lpddr5-change', i:4 },{ pi:'hbm3-price', ci:'hbm3-change', i:6 }
  ].forEach(({ pi, ci, i }) => {
    const item = dramData[i]; if (!item) return;
    const pEl = document.getElementById(pi); const cEl = document.getElementById(ci);
    if (pEl) pEl.textContent = '$' + item.spot.toFixed(2);
    if (cEl) {
      const diff = item.spot - item.prevSpot;
      const pct = ((diff / item.prevSpot)*100).toFixed(2);
      const isUp = diff >= 0;
      cEl.className = 'dram-change ' + (isUp ? 'up' : 'down');
      cEl.innerHTML = `<i class="fas fa-arrow-${isUp?'up':'down'}"></i> ${isUp?'+':''}${pct}%`;
    }
  });
}

function updateDramKrwTable() {
  const tbody = document.getElementById('dram-table-body');
  if (!tbody || dramData.length === 0) return;
  const dexEl = document.getElementById('dex-usd-krw');
  if (dexEl) dexEl.textContent = currentUsdKrw.toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2});
  tbody.innerHTML = dramData.map(item => {
    const krw = item.spot * currentUsdKrw;
    const diff = item.spot - item.prevSpot;
    const pct = ((diff / item.prevSpot)*100).toFixed(2);
    const isUp = diff >= 0;
    const v = parseFloat(pct); const w = (Math.min(Math.abs(v),10)/10*100).toFixed(0);
    const trendBar = `<div style="background:${v>=0?'#10b981':'#ef4444'};height:8px;width:${w}%;border-radius:4px;min-width:4px"></div>`;
    return `<tr>
      <td><strong style="color:#000;font-weight:800">${item.name}</strong></td>
      <td style="color:#555">${item.spec}</td>
      <td class="td-price">$${item.spot.toFixed(3)}</td>
      <td class="td-krw">₩${Math.round(krw).toLocaleString()}</td>
      <td class="${isUp?'td-up':'td-down'}">${isUp?'▲':'▼'} ${Math.abs(pct)}%</td>
      <td>${trendBar}</td></tr>`;
  }).join('');
}

function updateDramStocks() {
  const stocks = [
    { priceId:'stock-samsung',  changeId:'change-samsung',  price:216500,  prev:218000,  isUsd:false },
    { priceId:'stock-skhynix',  changeId:'change-skhynix',  price:1061000, prev:1099000, isUsd:false },
    { priceId:'stock-micron',   changeId:'change-micron',   price:412.37,  prev:415.56,  isUsd:true  },
    { priceId:'stock-nvda',     changeId:'change-nvda',     price:177.19,  prev:184.89,  isUsd:true  }
  ];
  stocks.forEach(s => {
    const pEl = document.getElementById(s.priceId);
    const cEl = document.getElementById(s.changeId);
    const diff = s.price - s.prev;
    const pct  = ((diff / s.prev)*100).toFixed(2);
    const isUp = diff >= 0;
    if (pEl) pEl.textContent = s.isUsd ? '$' + s.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '₩' + s.price.toLocaleString('ko-KR');
    if (cEl) {
      cEl.textContent = (isUp?'▲ +':'▼ ') + Math.abs(pct) + '% (' + (s.isUsd ? '$'+Math.abs(diff).toFixed(2) : '₩'+Math.abs(diff).toLocaleString('ko-KR')) + ')';
      cEl.className = 'dstock-change ' + (isUp?'up':'down');
    }
  });
}

// =====================================================
//  Fed 금리인상 뉴스 로드 & 렌더링
// =====================================================
let fedNewsLoading = false;

async function loadFedNews(force = false) {
  if (fedNewsLoading) return;
  fedNewsLoading = true;

  const listEl    = document.getElementById('fed-news-list');
  const metaEl    = document.getElementById('fed-news-meta');
  const countEl   = document.getElementById('fed-news-count');
  const updatedEl = document.getElementById('fed-news-updated');
  const alertBar  = document.getElementById('fed-alert-bar');
  const alertBadge= document.getElementById('fed-alert-badge');

  if (listEl) listEl.innerHTML = '<div class="fnp-loading"><i class="fas fa-spinner fa-spin"></i> 금리인상 뉴스 검색 중...</div>';

  try {
    const url = force ? '/api/fed-news?force=true' : '/api/fed-news';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    renderFedNews(data);
  } catch (e) {
    console.warn('[FedNews] 로드 실패:', e);
    if (listEl) listEl.innerHTML = '<div class="fnp-error"><i class="fas fa-exclamation-triangle"></i> 뉴스 로드 실패. 잠시 후 다시 시도됩니다.</div>';
  } finally {
    fedNewsLoading = false;
  }
}

/**
 * Fed 금리 뉴스 데이터를 UI에 렌더링
 */
function renderFedNews(data) {
  const listEl    = document.getElementById('fed-news-list');
  const countEl   = document.getElementById('fed-news-count');
  const updatedEl = document.getElementById('fed-news-updated');
  const alertBar  = document.getElementById('fed-alert-bar');
  const alertBadge= document.getElementById('fed-alert-badge');
  const panel     = document.getElementById('fed-news-panel');

  if (!listEl) return;

  // 카운트 & 업데이트 시간
  if (countEl) countEl.textContent = `72h 이내 ${data.totalCount ?? 0}건 (오늘 ${data.todayCount ?? 0}건)`;
  if (updatedEl) {
    const fetchedAt = data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString('ko-KR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul'
    }) : '--';
    updatedEl.textContent = `갱신: ${fetchedAt} KST`;
  }

  // 경보 배지
  if (alertBadge) {
    if (data.isSurge) {
      alertBadge.textContent = '🚨 급증';
      alertBadge.className = 'fnp-badge badge-surge';
    } else if (data.isAlert) {
      alertBadge.textContent = '⚠️ 증가';
      alertBadge.className = 'fnp-badge badge-alert';
    } else if ((data.todayCount ?? 0) > 0) {
      alertBadge.textContent = `📰 ${data.todayCount}건`;
      alertBadge.className = 'fnp-badge badge-normal';
    } else {
      alertBadge.textContent = '📭 없음';
      alertBadge.className = 'fnp-badge badge-none';
    }
  }

  // 경보 배너 (급증·증가 시만 표시)
  if (alertBar) {
    if (data.isAlert || data.isSurge) {
      alertBar.style.display = 'block';
      alertBar.textContent = data.alertMsg || '';
      alertBar.className = 'fnp-alert-bar ' + (data.isSurge ? 'alert-surge' : 'alert-warning');
    } else {
      alertBar.style.display = 'none';
    }
  }

  // 패널 border 강조 (급증 시)
  if (panel) {
    panel.classList.toggle('fnp-surge', !!data.isSurge);
    panel.classList.toggle('fnp-alert', !!data.isAlert && !data.isSurge);
  }

  // 뉴스 목록 렌더링
  if (!data.articles || data.articles.length === 0) {
    listEl.innerHTML = `
      <div class="fnp-empty">
        <i class="fas fa-search"></i>
        <span>최근 72시간 내 주요 금리인상 관련 뉴스가 없습니다.</span>
      </div>`;
    return;
  }

  // 신뢰도 tier 이름
  const tierLabel = { 1:'투자은행', 2:'자산운용', 3:'금융미디어', 4:'경제매체', 5:'금융포털', 9:'기타' };
  const tierClass = { 1:'tier-bank', 2:'tier-fund', 3:'tier-premium', 4:'tier-major', 5:'tier-fin', 9:'tier-other' };

  listEl.innerHTML = data.articles.map((art, i) => {
    const cls   = tierClass[art.tier] || 'tier-other';
    const label = tierLabel[art.tier] || '기타';
    const ageText = art.ageHours < 24
      ? `${art.ageHours}시간 전`
      : `${Math.round(art.ageHours/24)}일 전`;
    const linkHtml = art.link
      ? `<a href="${escHtml(art.link)}" target="_blank" rel="noopener" class="fnp-link" title="원문 보기"><i class="fas fa-external-link-alt"></i></a>`
      : '';
    return `
      <div class="fnp-item ${i === 0 ? 'fnp-item-first' : ''}">
        <div class="fnp-item-top">
          <span class="fnp-src-badge ${cls}">${escHtml(art.srcType || label)}</span>
          <span class="fnp-src-name">${escHtml(art.source)}</span>
          <span class="fnp-age">${ageText}</span>
          ${linkHtml}
        </div>
        <div class="fnp-item-title">${escHtml(art.title)}</div>
        <div class="fnp-item-date"><i class="fas fa-clock"></i> ${art.date} UTC</div>
      </div>`;
  }).join('');
}

// =====================================================
//  유틸리티
// =====================================================
function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

document.addEventListener('click', e => {
  const modal = document.getElementById('confirm-modal');
  if (modal && e.target === modal) closeModal();
});
