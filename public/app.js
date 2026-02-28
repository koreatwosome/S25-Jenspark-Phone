// ====================================
//  주식 투자 승률 체크리스트 앱
// ====================================

// ===== 상태 관리 =====
let investmentHistory = JSON.parse(localStorage.getItem('investmentHistory') || '[]');
let historyChart = null;
let currentUsdKrw = 1335.0;
let dramData = [];

// ===== 초기화 =====
document.addEventListener('DOMContentLoaded', () => {
  updateDateTime();
  setInterval(updateDateTime, 1000);
  initTodayInfo();
  loadMarketData();
  loadDramData();
  updateWinRate();
  renderHistoryPage();
  setInterval(() => { loadMarketData(); }, 60000); // 1분마다 갱신
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

// ===== 시장 데이터 로드 =====
async function loadMarketData() {
  try {
    const res = await fetch('/api/market');
    if (res.ok) {
      const data = await res.json();
      updateMarketCards(data);
      currentUsdKrw = data.usdKrw || 1335.0;
      updateDramKrwTable();
    }
  } catch(e) {
    setDefaultMarketData();
  }
}

function updateMarketCards(data) {
  // USD/KRW
  const usdVal = document.getElementById('usd-krw-value');
  const usdChg = document.getElementById('usd-krw-change');
  if (usdVal) usdVal.textContent = data.usdKrw ? data.usdKrw.toFixed(2) + ' ₩' : '--';
  if (usdChg && data.usdKrwChange) {
    const isUp = data.usdKrwChange > 0;
    usdChg.textContent = (isUp ? '▲' : '▼') + ' ' + Math.abs(data.usdKrwChange).toFixed(2);
    usdChg.className = 'mc-change ' + (isUp ? 'up' : 'down');
  }
  // S&P500
  const spVal = document.getElementById('sp500-value');
  const spChg = document.getElementById('sp500-change');
  if (spVal) spVal.textContent = data.sp500 ? data.sp500.toLocaleString() : '--';
  if (spChg && data.sp500Change !== undefined) {
    const isUp = data.sp500Change >= 0;
    spChg.textContent = (isUp ? '▲' : '▼') + ' ' + Math.abs(data.sp500Change).toFixed(2) + '%';
    spChg.className = 'mc-change ' + (isUp ? 'up' : 'down');
  }
  // NASDAQ
  const nqVal = document.getElementById('nasdaq-value');
  const nqChg = document.getElementById('nasdaq-change');
  if (nqVal) nqVal.textContent = data.nasdaq ? data.nasdaq.toLocaleString() : '--';
  if (nqChg && data.nasdaqChange !== undefined) {
    const isUp = data.nasdaqChange >= 0;
    nqChg.textContent = (isUp ? '▲' : '▼') + ' ' + Math.abs(data.nasdaqChange).toFixed(2) + '%';
    nqChg.className = 'mc-change ' + (isUp ? 'up' : 'down');
  }
  // KOSPI
  const kpVal = document.getElementById('kospi-value');
  const kpChg = document.getElementById('kospi-change');
  if (kpVal) kpVal.textContent = data.kospi ? data.kospi.toLocaleString() : '--';
  if (kpChg && data.kospiChange !== undefined) {
    const isUp = data.kospiChange >= 0;
    kpChg.textContent = (isUp ? '▲' : '▼') + ' ' + Math.abs(data.kospiChange).toFixed(2) + '%';
    kpChg.className = 'mc-change ' + (isUp ? 'up' : 'down');
  }
  // 환율 업데이트
  const dexUsdKrw = document.getElementById('dex-usd-krw');
  if (dexUsdKrw && data.usdKrw) {
    dexUsdKrw.textContent = data.usdKrw.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}

function setDefaultMarketData() {
  const defaults = {
    usdKrw: 1335.00, usdKrwChange: 2.50,
    sp500: 5923.45, sp500Change: -0.48,
    nasdaq: 18842.31, nasdaqChange: -0.62,
    kospi: 2612.40, kospiChange: 0.31
  };
  updateMarketCards(defaults);
  currentUsdKrw = defaults.usdKrw;
}

// ===== 승률 업데이트 =====
function updateWinRate() {
  let count = 0;
  for (let i = 1; i <= 12; i++) {
    const chk = document.getElementById('chk-' + i);
    if (chk && chk.checked) count++;
  }

  const rate = count * 10; // 항목당 10%이나 최대 100%로 고정
  const clampedRate = Math.min(rate, 100);

  // 원형 진행률 — 라이트 테마 색상
  const circle = document.getElementById('win-rate-display');
  if (circle) {
    let color;
    if (clampedRate >= 70) color = '#16a34a';   // 초록
    else if (clampedRate >= 40) color = '#d97706'; // 앰버
    else color = '#ea580c';                        // 오렌지
    const trackColor = '#fde8d4'; // 살색 트랙
    circle.style.background = `conic-gradient(${color} ${clampedRate}%, ${trackColor} ${clampedRate}%)`;
  }

  const rateNum = document.getElementById('rate-number');
  if (rateNum) rateNum.textContent = clampedRate;

  // 체크 수 및 텍스트
  const checkedCount = document.getElementById('checked-count');
  if (checkedCount) checkedCount.textContent = count;
  // 하단 바의 체크 카운트도 동기화
  const checkedCountBottom = document.getElementById('checked-count-bottom');
  if (checkedCountBottom) checkedCountBottom.textContent = count;

  const rateText = document.getElementById('rate-text');
  if (rateText) rateText.textContent = clampedRate + '%';

  // 배너 진행바
  const progressBar = document.getElementById('progress-bar');
  if (progressBar) progressBar.style.width = clampedRate + '%';

  // 등급
  updateGrade(clampedRate);

  // 카드 강조
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

  // 체크된 항목들 수집
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

  // 기존 같은 날짜 기록이 있으면 업데이트
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

  listEl.innerHTML = data.map((item, idx) => {
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
  const dateStr = now.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });

  // ─── DRAMeXchange 실제 현물가 (2026-02-27 기준) ───────────────────
  // 출처: dramexchange.com  |  단위: USD per chip (16Gb 기준)
  // DDR5 16Gb 4800/5600  세션평균 $39.500  (전일 대비 +0.43%)
  // DDR5 16Gb eTT         세션평균 $20.600  (+0.49%)
  // DDR4 16Gb 3200        세션평균 $79.909  (+0.69%)
  // DDR4 16Gb eTT         세션평균 $13.675  (0.00%)
  // DDR4 8Gb  3200        세션평균 $32.900  (+0.31%)
  // DDR4 8Gb  eTT         세션평균 $6.897   (0.00%)
  // LPDDR5/LPDDR5X: Feb.9 업데이트 기준 (춘절 후 소폭 상승 추세)
  // HBM3/HBM3E: 계약가 기준 추정값 (DDR5 대비 5~7x 프리미엄)
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

  // 카드 업데이트
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
  // ✅ 2026년 2월 27일(금) 실제 종가 기준 (2/28은 토요일 — 장 없음)
  // 출처: Yahoo Finance, Investing.com, 토스증권, 알파스퀘어
  const stocks = [
    {
      priceId: 'stock-samsung',
      changeId: 'change-samsung',
      price: 216500,          // 2/27 종가 (₩)
      prev:  218000,          // 2/26 종가 (₩)
      isUsd: false
    },
    {
      priceId: 'stock-skhynix',
      changeId: 'change-skhynix',
      price: 1061000,         // 2/27 종가 (₩)
      prev:  1099000,         // 2/26 종가 (₩)
      isUsd: false
    },
    {
      priceId: 'stock-micron',
      changeId: 'change-micron',
      price: 412.37,          // 2/27(금) 종가 ($)
      prev:  415.56,          // 2/26(목) 종가 ($)
      isUsd: true
    },
    {
      priceId: 'stock-nvda',
      changeId: 'change-nvda',
      price: 177.19,          // 2/27(금) 종가 ($)
      prev:  184.89,          // 2/26(목) 종가 ($)
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
