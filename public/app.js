// ====================================
//  주식 투자 승률 체크리스트 앱
// ====================================

// ===== 상태 관리 =====
let investmentHistory = JSON.parse(localStorage.getItem('investmentHistory') || '[]');
let historyChart = null;
let currentUsdKrw = 1450.0;
let dramData = [];

// ===== 시장 데이터 갱신 스케줄러 =====
let marketRefreshTimer = null;       // 1시간 주기 타이머
let countdownTimer = null;           // 카운트다운 타이머
let nextRefreshTime = null;          // 다음 갱신 예정 시각 (Date)
let lastRefreshTime = null;          // 마지막 갱신 시각 (Date)
let isRefreshing = false;            // 갱신 중 플래그

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1시간

// ===== 초기화 =====
document.addEventListener('DOMContentLoaded', () => {
  updateDateTime();
  setInterval(updateDateTime, 1000);
  initTodayInfo();
  loadMarketData();
  loadDramData();
  updateWinRate();
  renderHistoryPage();

  // 1시간 주기 자동 갱신 스케줄 등록
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

// ===== 날짜/시간 업데이트 =====
function updateDateTime() {
  const now = new Date();
  const opts = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul'
  };
  const str = new Intl.DateTimeFormat('ko-KR', opts).format(now);
  const el = document.getElementById('current-datetime');
  if (el) el.textContent = str + ' (KST)';
}

function getTodayString() {
  const now = new Date();
  return now.toLocaleDateString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'Asia/Seoul'
  }).replace(/\. /g, '-').replace('.', '');
}

function getTodayISO() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function getDayOfWeek() {
  const days = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  return days[new Date().getDay()];
}

function initTodayInfo() {
  const todayEl = document.getElementById('today-date-main');
  if (todayEl) todayEl.textContent = getTodayString() + ' ' + getDayOfWeek();

  const dayLabel = document.getElementById('today-day-label');
  const dayOfWeek = getDayOfWeek();
  if (dayLabel) {
    dayLabel.textContent = '오늘: ' + getTodayString() + ' (' + dayOfWeek + ')';
    if (dayOfWeek === '월요일') {
      dayLabel.style.color = '#f59e0b';
      dayLabel.textContent += ' ⚡ Monday Effect 해당일';
    }
  }

  const dexDate = document.getElementById('dex-date');
  if (dexDate) dexDate.textContent = '(기준일: ' + getTodayString() + ')';
}

// ===== 시장 데이터 로드 (실시간) =====
async function loadMarketData(showLoading = false) {
  if (isRefreshing) return;
  isRefreshing = true;

  if (showLoading) {
    setMarketCardsLoading(true);
  }

  try {
    // force=true 로 강제 갱신 (캐시 무시)
    const url = showLoading ? '/api/market?force=true' : '/api/market';
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      updateMarketCards(data);
      currentUsdKrw = data.usdKrw || 1450.0;
      updateDramKrwTable();

      // 갱신 시각 업데이트
      lastRefreshTime = new Date();
      updateRefreshStatus(data);
    }
  } catch(e) {
    console.warn('[Market] 데이터 로드 실패:', e);
    setDefaultMarketData();
    updateRefreshStatusError();
  } finally {
    isRefreshing = false;
    setMarketCardsLoading(false);
  }
}

// ===== 1시간 주기 갱신 스케줄러 =====
function scheduleNextRefresh() {
  // 기존 타이머 정리
  if (marketRefreshTimer) clearTimeout(marketRefreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  nextRefreshTime = new Date(Date.now() + REFRESH_INTERVAL_MS);

  // 1시간 후 갱신
  marketRefreshTimer = setTimeout(async () => {
    console.log('[Market] 1시간 주기 자동 갱신 실행');
    await loadMarketData(false);
    scheduleNextRefresh(); // 재귀 등록
  }, REFRESH_INTERVAL_MS);

  // 카운트다운 표시 (1초마다 업데이트)
  countdownTimer = setInterval(updateCountdownDisplay, 1000);
  updateCountdownDisplay(); // 즉시 한 번 표시
}

// ===== 카운트다운 표시 업데이트 =====
function updateCountdownDisplay() {
  if (!nextRefreshTime) return;
  const remaining = nextRefreshTime - Date.now();
  if (remaining <= 0) {
    updateCountdownEl('갱신 중...');
    return;
  }
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  const str = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  updateCountdownEl(str);
}

function updateCountdownEl(text) {
  const el = document.getElementById('market-countdown');
  if (el) el.textContent = text;
}

// ===== 갱신 상태 UI 업데이트 =====
function updateRefreshStatus(data) {
  const timeEl = document.getElementById('market-last-update');
  const sourceEl = document.getElementById('market-source-badge');

  if (timeEl && lastRefreshTime) {
    const timeStr = lastRefreshTime.toLocaleTimeString('ko-KR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: 'Asia/Seoul'
    });
    timeEl.textContent = timeStr + ' (KST)';
  }

  if (sourceEl) {
    if (data.source === 'live') {
      sourceEl.textContent = '● 실시간';
      sourceEl.className = 'source-badge live';
    } else if (data.source === 'fallback' || data.source === 'error_fallback') {
      sourceEl.textContent = '○ 기본값';
      sourceEl.className = 'source-badge fallback';
    } else {
      sourceEl.textContent = '● 실시간';
      sourceEl.className = 'source-badge live';
    }
  }
}

function updateRefreshStatusError() {
  const sourceEl = document.getElementById('market-source-badge');
  if (sourceEl) {
    sourceEl.textContent = '✗ 오류';
    sourceEl.className = 'source-badge error';
  }
}

// ===== 로딩 상태 카드 =====
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

// ===== 수동 갱신 함수 =====
async function manualRefreshMarket() {
  if (isRefreshing) return;
  // 카운트다운 리셋
  scheduleNextRefresh(); // 타이머 재시작
  await loadMarketData(true); // 강제 갱신
  showToast('📡 시장 데이터를 실시간으로 갱신했습니다.');
}

// ===== 마켓 카드 업데이트 =====
function updateMarketCards(data) {
  // USD/KRW
  const usdVal = document.getElementById('usd-krw-value');
  const usdChg = document.getElementById('usd-krw-change');
  if (usdVal) usdVal.textContent = data.usdKrw ? data.usdKrw.toLocaleString('ko-KR', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' ₩' : '--';
  if (usdChg) {
    const chgPct = data.usdKrwChangePercent ?? data.usdKrwChange ?? 0;
    const chgAbs = data.usdKrwChange ?? 0;
    const isUp = chgPct > 0;
    const isZero = chgPct === 0;
    if (isZero) {
      usdChg.textContent = '변동없음';
      usdChg.className = 'mc-change neutral';
    } else {
      usdChg.textContent = (isUp ? '▲' : '▼') + ' ' + Math.abs(chgPct).toFixed(2) + '%';
      usdChg.className = 'mc-change ' + (isUp ? 'up' : 'down');
    }
  }

  // S&P500
  const spVal = document.getElementById('sp500-value');
  const spChg = document.getElementById('sp500-change');
  if (spVal) spVal.textContent = data.sp500 ? data.sp500.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : '--';
  if (spChg && data.sp500Change !== undefined) {
    const isUp = data.sp500Change >= 0;
    const isZero = data.sp500Change === 0;
    if (isZero) {
      spChg.textContent = '변동없음';
      spChg.className = 'mc-change neutral';
    } else {
      spChg.textContent = (isUp ? '▲' : '▼') + ' ' + Math.abs(data.sp500Change).toFixed(2) + '%';
      spChg.className = 'mc-change ' + (isUp ? 'up' : 'down');
    }
  }

  // NASDAQ
  const nqVal = document.getElementById('nasdaq-value');
  const nqChg = document.getElementById('nasdaq-change');
  if (nqVal) nqVal.textContent = data.nasdaq ? data.nasdaq.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : '--';
  if (nqChg && data.nasdaqChange !== undefined) {
    const isUp = data.nasdaqChange >= 0;
    const isZero = data.nasdaqChange === 0;
    if (isZero) {
      nqChg.textContent = '변동없음';
      nqChg.className = 'mc-change neutral';
    } else {
      nqChg.textContent = (isUp ? '▲' : '▼') + ' ' + Math.abs(data.nasdaqChange).toFixed(2) + '%';
      nqChg.className = 'mc-change ' + (isUp ? 'up' : 'down');
    }
  }

  // KOSPI
  const kpVal = document.getElementById('kospi-value');
  const kpChg = document.getElementById('kospi-change');
  if (kpVal) kpVal.textContent = data.kospi ? data.kospi.toLocaleString('ko-KR', {minimumFractionDigits:2, maximumFractionDigits:2}) : '--';
  if (kpChg && data.kospiChange !== undefined) {
    const isUp = data.kospiChange >= 0;
    const isZero = data.kospiChange === 0;
    if (isZero) {
      kpChg.textContent = '변동없음';
      kpChg.className = 'mc-change neutral';
    } else {
      kpChg.textContent = (isUp ? '▲' : '▼') + ' ' + Math.abs(data.kospiChange).toFixed(2) + '%';
      kpChg.className = 'mc-change ' + (isUp ? 'up' : 'down');
    }
  }

  // D램 환산 환율 업데이트
  const dexUsdKrw = document.getElementById('dex-usd-krw');
  if (dexUsdKrw && data.usdKrw) {
    dexUsdKrw.textContent = data.usdKrw.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // USD/KRW 카드 테두리 색상 (환율 방향에 따라)
  const usdCard = document.getElementById('usd-krw-card');
  if (usdCard) {
    const chgPct = data.usdKrwChangePercent ?? 0;
    usdCard.classList.remove('card-up', 'card-down');
    if (chgPct > 0) usdCard.classList.add('card-up');
    else if (chgPct < 0) usdCard.classList.add('card-down');
  }
}

function setDefaultMarketData() {
  const defaults = {
    usdKrw: 1450.00, usdKrwChange: 0, usdKrwChangePercent: 0,
    sp500: 5923.45, sp500Change: 0,
    nasdaq: 18842.31, nasdaqChange: 0,
    kospi: 2612.40, kospiChange: 0,
    source: 'fallback'
  };
  updateMarketCards(defaults);
  currentUsdKrw = defaults.usdKrw;
  updateRefreshStatus(defaults);
}

// ===== 승률 업데이트 =====
function updateWinRate() {
  let count = 0;
  for (let i = 1; i <= 12; i++) {
    const chk = document.getElementById('chk-' + i);
    if (chk && chk.checked) count++;
  }

  const rate = count * 10;
  const clampedRate = Math.min(rate, 100);

  const circle = document.getElementById('win-rate-display');
  if (circle) {
    let color;
    if (clampedRate >= 70) color = '#16a34a';
    else if (clampedRate >= 40) color = '#d97706';
    else color = '#ea580c';
    const trackColor = '#fde8d4';
    circle.style.background = `conic-gradient(${color} ${clampedRate}%, ${trackColor} ${clampedRate}%)`;
  }

  const rateNum = document.getElementById('rate-number');
  if (rateNum) rateNum.textContent = clampedRate;

  const checkedCount = document.getElementById('checked-count');
  if (checkedCount) checkedCount.textContent = count;
  const checkedCountBottom = document.getElementById('checked-count-bottom');
  if (checkedCountBottom) checkedCountBottom.textContent = count;

  const rateText = document.getElementById('rate-text');
  if (rateText) rateText.textContent = clampedRate + '%';

  const progressBar = document.getElementById('progress-bar');
  if (progressBar) progressBar.style.width = clampedRate + '%';

  updateGrade(clampedRate);

  for (let i = 1; i <= 12; i++) {
    const card = document.getElementById('card-' + i);
    const chk = document.getElementById('chk-' + i);
    if (card && chk) {
      if (chk.checked) card.classList.add('checked');
      else card.classList.remove('checked');
    }
  }
}

function updateGrade(rate) {
  const gradeEl = document.getElementById('rate-grade');
  if (!gradeEl) return;
  let icon, text, color;
  if (rate >= 90)      { icon = '🚀'; text = '최상 - 적극 매수'; color = '#15803d'; }
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
  updateWinRate();
}

function toggleChip(el, num) {
  el.classList.toggle('active');
}

// ===== 투자 확정 =====
function confirmInvestment() {
  const checkedEl = document.getElementById('checked-count');
  const count = parseInt(checkedEl ? checkedEl.textContent : '0');
  const rate = Math.min(count * 10, 100);

  const modal = document.getElementById('confirm-modal');
  const modalRate = document.getElementById('modal-rate-display');
  const modalGrade = document.getElementById('modal-grade-display');
  const modalDate = document.getElementById('modal-date-display');

  if (modalRate) modalRate.textContent = rate + '%';
  if (modalDate) modalDate.textContent = getTodayString() + ' (' + getDayOfWeek() + ')';

  let gradeText, gradeColor;
  if (rate >= 90)      { gradeText = '🚀 최상 - 적극 매수'; gradeColor = '#22c55e'; }
  else if (rate >= 70) { gradeText = '✅ 양호 - 매수 고려'; gradeColor = '#10b981'; }
  else if (rate >= 50) { gradeText = '👀 중립 - 관망 권장'; gradeColor = '#f59e0b'; }
  else if (rate >= 30) { gradeText = '⚠️ 주의 - 신중 접근'; gradeColor = '#ef4444'; }
  else                 { gradeText = '🛑 위험 - 매수 자제'; gradeColor = '#dc2626'; }

  if (modalGrade) {
    modalGrade.textContent = gradeText;
    modalGrade.style.color = gradeColor;
  }

  if (modal) modal.classList.add('open');
}

function closeModal() {
  const modal = document.getElementById('confirm-modal');
  if (modal) modal.classList.remove('open');
}

function saveInvestment() {
  const checkedEl = document.getElementById('checked-count');
  const count = parseInt(checkedEl ? checkedEl.textContent : '0');
  const rate = Math.min(count * 10, 100);
  const today = getTodayISO();

  const checkedItems = [];
  const itemNames = [
    'USD/KRW 환율', '전날 미국장', '815 채널', '증시각도기',
    '외국인 지분', 'ETF 자금', '연준 발언', 'Monday 효과',
    '빅테크 실적', '전쟁/지정학', '파산 뉴스', '기타 이슈'
  ];
  for (let i = 1; i <= 12; i++) {
    const chk = document.getElementById('chk-' + i);
    if (chk && chk.checked) checkedItems.push(itemNames[i-1]);
  }

  const existingIdx = investmentHistory.findIndex(h => h.date === today);
  const record = {
    date: today,
    displayDate: getTodayString(),
    dayOfWeek: getDayOfWeek(),
    rate: rate,
    checkedCount: count,
    checkedItems: checkedItems,
    memo: '',
    savedAt: new Date().toISOString()
  };

  if (existingIdx >= 0) {
    record.memo = investmentHistory[existingIdx].memo || '';
    investmentHistory[existingIdx] = record;
  } else {
    investmentHistory.unshift(record);
  }

  localStorage.setItem('investmentHistory', JSON.stringify(investmentHistory));
  closeModal();
  showToast('✅ 오늘의 승률 ' + rate + '%가 투자 이력에 저장되었습니다!');
}

// ===== 투자 이력 렌더링 =====
function renderHistoryPage() {
  const totalEl = document.getElementById('total-records');
  const avgEl = document.getElementById('avg-rate');
  const maxEl = document.getElementById('max-rate');

  if (investmentHistory.length > 0) {
    const avg = (investmentHistory.reduce((s, h) => s + h.rate, 0) / investmentHistory.length).toFixed(1);
    const max = Math.max(...investmentHistory.map(h => h.rate));
    if (totalEl) totalEl.textContent = investmentHistory.length;
    if (avgEl) avgEl.textContent = avg + '%';
    if (maxEl) maxEl.textContent = max + '%';
  } else {
    if (totalEl) totalEl.textContent = '0';
    if (avgEl) avgEl.textContent = '0%';
    if (maxEl) maxEl.textContent = '0%';
  }

  renderHistoryList(investmentHistory);
}

function renderHistoryList(data) {
  const listEl = document.getElementById('history-list');
  if (!listEl) return;

  if (data.length === 0) {
    listEl.innerHTML = `
      <div class="empty-history">
        <i class="fas fa-inbox"></i>
        <p>아직 확정된 투자 이력이 없습니다.</p>
        <p class="small">체크리스트에서 '오늘 승률 확정하기'를 눌러 기록을 추가하세요.</p>
      </div>`;
    return;
  }

  listEl.innerHTML = data.map((item) => {
    const realIdx = investmentHistory.indexOf(item);
    let rateClass = 'rate-low', gradeClass = 'grade-low', gradeText = '위험';
    if (item.rate >= 70) { rateClass = 'rate-high'; gradeClass = 'grade-high'; gradeText = '양호+'; }
    else if (item.rate >= 40) { rateClass = 'rate-mid'; gradeClass = 'grade-mid'; gradeText = '중립'; }

    const checkedStr = item.checkedItems && item.checkedItems.length > 0
      ? item.checkedItems.map(c => `<span style="font-size:0.7rem;padding:2px 6px;background:rgba(59,130,246,0.1);border-radius:4px;color:#94a3b8;margin:2px">${c}</span>`).join('')
      : '';

    return `
      <div class="history-item" id="hi-${realIdx}">
        <div class="hi-date">
          ${item.displayDate || item.date}
          <span>${item.dayOfWeek || ''}</span>
          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:2px">${checkedStr}</div>
        </div>
        <div class="hi-rate">
          <div class="hi-rate-num ${rateClass}">${item.rate}<span style="font-size:1rem">%</span></div>
          <div class="hi-rate-label">투자 승률</div>
          <span class="hi-grade ${gradeClass}">${gradeText}</span>
        </div>
        <div class="hi-memo-area">
          <div class="hi-memo-label"><i class="fas fa-pen"></i> 투자 일기 메모</div>
          <textarea class="hi-memo-input" id="hi-memo-${realIdx}" placeholder="오늘의 투자 일기를 작성하세요. 시장 분석, 매매 내역, 느낀 점 등을 기록하세요...">${item.memo || ''}</textarea>
        </div>
        <div class="hi-actions">
          <button class="hi-save-btn" onclick="saveMemo(${realIdx})">
            <i class="fas fa-save"></i> 저장
          </button>
          <button class="hi-del-btn" onclick="deleteHistoryItem(${realIdx})">
            <i class="fas fa-trash"></i> 삭제
          </button>
        </div>
      </div>`;
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
  renderHistoryPage();
  setTimeout(renderHistoryChart, 100);
  showToast('🗑️ 기록이 삭제되었습니다.');
}

function clearAllHistory() {
  if (!confirm('전체 투자 이력을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
  investmentHistory = [];
  localStorage.setItem('investmentHistory', JSON.stringify(investmentHistory));
  renderHistoryPage();
  setTimeout(renderHistoryChart, 100);
  showToast('🗑️ 전체 이력이 삭제되었습니다.');
}

function filterHistory() {
  const query = document.getElementById('history-search').value.toLowerCase();
  const filtered = investmentHistory.filter(h =>
    (h.displayDate || h.date || '').includes(query) ||
    (h.memo || '').toLowerCase().includes(query) ||
    (h.dayOfWeek || '').includes(query) ||
    (h.checkedItems || []).some(c => c.toLowerCase().includes(query))
  );
  renderHistoryList(filtered);
}

// ===== 투자 이력 차트 =====
function renderHistoryChart() {
  const canvas = document.getElementById('history-chart');
  if (!canvas) return;

  if (historyChart) {
    historyChart.destroy();
    historyChart = null;
  }

  const sortedHistory = [...investmentHistory].sort((a, b) => a.date > b.date ? 1 : -1);
  const last30 = sortedHistory.slice(-30);

  if (last30.length === 0) {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const labels = last30.map(h => h.displayDate || h.date);
  const rates = last30.map(h => h.rate);

  historyChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: '투자 승률 (%)',
        data: rates,
        borderColor: '#d97706',
        backgroundColor: 'rgba(217,119,6,0.07)',
        borderWidth: 2.5,
        pointRadius: 5,
        pointHoverRadius: 8,
        pointBackgroundColor: rates.map(r => r >= 70 ? '#16a34a' : r >= 40 ? '#d97706' : '#dc2626'),
        pointBorderColor: '#ffffff',
        pointBorderWidth: 2,
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#ffffff',
          titleColor: '#1c1209',
          bodyColor: '#6b4c30',
          borderColor: '#f0dece',
          borderWidth: 1.5,
          callbacks: {
            label: ctx => '승률: ' + ctx.parsed.y + '%'
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(240,222,206,0.8)' },
          ticks: { color: '#a07850', font: { size: 11 } }
        },
        y: {
          min: 0, max: 120,
          grid: { color: 'rgba(240,222,206,0.8)' },
          ticks: {
            color: '#a07850',
            font: { size: 11 },
            callback: v => v + '%'
          }
        }
      }
    }
  });
}

// ===== D램 데이터 =====
function loadDramData() {
  const now = new Date();

  dramData = [
    {
      name: 'DDR5 16Gb (2Gx8)', spec: '4800/5600 현물',
      spot: 39.50, prevSpot: 39.33,
      type: '현물가', id: 'ddr5'
    },
    {
      name: 'DDR5 16Gb eTT', spec: 'Entry-Level',
      spot: 20.60, prevSpot: 20.50,
      type: '현물가', id: 'ddr5-32'
    },
    {
      name: 'DDR4 16Gb (2Gx8)', spec: '3200 현물',
      spot: 79.91, prevSpot: 79.36,
      type: '현물가', id: 'ddr4'
    },
    {
      name: 'DDR4 8Gb (1Gx8)', spec: '3200 현물',
      spot: 32.90, prevSpot: 32.80,
      type: '현물가', id: 'ddr4-16'
    },
    {
      name: 'LPDDR5 16Gb', spec: 'Mobile / 계약가',
      spot: 11.50, prevSpot: 10.80,
      type: '계약가', id: 'lpddr5'
    },
    {
      name: 'LPDDR5X 16Gb', spec: 'Mobile Premium',
      spot: 14.20, prevSpot: 13.30,
      type: '계약가', id: 'lpddr5x'
    },
    {
      name: 'HBM3 8GB Stack', spec: 'AI/HPC 계약가',
      spot: 235.00, prevSpot: 220.00,
      type: '계약가', id: 'hbm3'
    },
    {
      name: 'HBM3E 24GB Stack', spec: 'AI Server 계약가',
      spot: 420.00, prevSpot: 390.00,
      type: '계약가', id: 'hbm3e'
    }
  ];

  updateDramCards();
  updateDramKrwTable();
  updateDramStocks();

  const updStr = '데이터 기준: 2026.02.27 (DRAMeXchange)';
  ['ddr5-updated','ddr4-updated','lpddr5-updated','hbm3-updated'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = updStr;
  });
}

function updateDramCards() {
  if (dramData.length < 7) return;

  const updates = [
    { priceId: 'ddr5-price', changeId: 'ddr5-change', idx: 0 },
    { priceId: 'ddr4-price', changeId: 'ddr4-change', idx: 2 },
    { priceId: 'lpddr5-price', changeId: 'lpddr5-change', idx: 4 },
    { priceId: 'hbm3-price', changeId: 'hbm3-change', idx: 6 }
  ];

  updates.forEach(({ priceId, changeId, idx }) => {
    const item = dramData[idx];
    if (!item) return;
    const pEl = document.getElementById(priceId);
    const cEl = document.getElementById(changeId);
    if (pEl) pEl.textContent = '$' + item.spot.toFixed(2);
    if (cEl) {
      const diff = item.spot - item.prevSpot;
      const pct = ((diff / item.prevSpot) * 100).toFixed(2);
      const isUp = diff >= 0;
      cEl.className = 'dram-change ' + (isUp ? 'up' : 'down');
      cEl.innerHTML = `<i class="fas fa-arrow-${isUp ? 'up' : 'down'}"></i> ${isUp ? '+' : ''}${pct}%`;
    }
  });
}

function updateDramKrwTable() {
  const tbody = document.getElementById('dram-table-body');
  if (!tbody || dramData.length === 0) return;

  const dexEl = document.getElementById('dex-usd-krw');
  if (dexEl) dexEl.textContent = currentUsdKrw.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  tbody.innerHTML = dramData.map(item => {
    const krw = item.spot * currentUsdKrw;
    const diff = item.spot - item.prevSpot;
    const pct = ((diff / item.prevSpot) * 100).toFixed(2);
    const isUp = diff >= 0;
    const trendBar = getTrendBar(pct);

    return `
      <tr>
        <td><strong style="color:#000000;font-weight:800">${item.name}</strong></td>
        <td style="color:#555555">${item.spec}</td>
        <td class="td-price">$${item.spot.toFixed(3)}</td>
        <td class="td-krw">₩${Math.round(krw).toLocaleString()}</td>
        <td class="${isUp ? 'td-up' : 'td-down'}">${isUp ? '▲' : '▼'} ${Math.abs(pct)}%</td>
        <td>${trendBar}</td>
      </tr>`;
  }).join('');
}

function getTrendBar(pct) {
  const v = parseFloat(pct);
  const absV = Math.min(Math.abs(v), 10);
  const w = (absV / 10 * 100).toFixed(0);
  const color = v >= 0 ? '#10b981' : '#ef4444';
  return `<div style="background:${color};height:8px;width:${w}%;border-radius:4px;min-width:4px"></div>`;
}

function updateDramStocks() {
  const stocks = [
    {
      priceId: 'stock-samsung',
      changeId: 'change-samsung',
      price: 216500,
      prev:  218000,
      isUsd: false
    },
    {
      priceId: 'stock-skhynix',
      changeId: 'change-skhynix',
      price: 1061000,
      prev:  1099000,
      isUsd: false
    },
    {
      priceId: 'stock-micron',
      changeId: 'change-micron',
      price: 412.37,
      prev:  415.56,
      isUsd: true
    },
    {
      priceId: 'stock-nvda',
      changeId: 'change-nvda',
      price: 177.19,
      prev:  184.89,
      isUsd: true
    }
  ];

  stocks.forEach(s => {
    const pEl = document.getElementById(s.priceId);
    const cEl = document.getElementById(s.changeId);
    const diff = s.price - s.prev;
    const pct  = ((diff / s.prev) * 100).toFixed(2);
    const isUp = diff >= 0;

    if (pEl) {
      pEl.textContent = s.isUsd
        ? '$' + s.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : '₩' + s.price.toLocaleString('ko-KR');
    }
    if (cEl) {
      const sign = isUp ? '▲ +' : '▼ ';
      const absPct = Math.abs(pct);
      const absDiff = s.isUsd
        ? '$' + Math.abs(diff).toFixed(2)
        : '₩' + Math.abs(diff).toLocaleString('ko-KR');
      cEl.textContent = sign + absPct + '% (' + absDiff + ')';
      cEl.className = 'dstock-change ' + (isUp ? 'up' : 'down');
    }
  });
}

// ===== 유틸리티 =====
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// 클릭 외부 모달 닫기
document.addEventListener('click', e => {
  const modal = document.getElementById('confirm-modal');
  if (modal && e.target === modal) closeModal();
});
