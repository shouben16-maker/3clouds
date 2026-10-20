/* 湖內三層雲｜共用日曆邏輯。所有日期使用台灣日曆日期（YYYY-MM-DD）。 */
(function (global) {
  'use strict';
  const DEFAULT_SETTINGS = Object.freeze({ monthsAhead: 5, startMonthOffset: 0 });
  const CHINESE_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  function dateKey(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  function parseDate(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const [y, m, d] = key.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t : null;
  }
  function keyFromUTC(date) {
    return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  function nextDay(key) {
    const t = parseDate(key);
    if (!t) return null;
    t.setUTCDate(t.getUTCDate() + 1);
    return keyFromUTC(t);
  }
  function todayTaiwan() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const out = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return dateKey(Number(out.year), Number(out.month), Number(out.day));
  }
  function weekday(key) {
    const date = parseDate(key);
    return date ? date.getUTCDay() : null;
  }
  function monthList(settings, today = todayTaiwan()) {
    const t = parseDate(today);
    if (!t) return [];
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const count = Math.min(5, Math.max(1, Number(s.monthsAhead) || 5));
    // 固定從台灣當月份顯示，舊資料的 startMonthOffset: 1 不再使當月被略過。
    const start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
    return Array.from({length: count}, (_, i) => {
      const m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      return { year: m.getUTCFullYear(), month: m.getUTCMonth() + 1 };
    });
  }
  function emptyData() {
    return { version: 1, settings: { ...DEFAULT_SETTINGS }, dates: {} };
  }
  function normalize(raw) {
    const base = emptyData();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
    const settings = raw.settings || {};
    const months = Number(settings.monthsAhead);
    base.settings.monthsAhead = Number.isInteger(months) && months >= 1 ? Math.min(5, months) : 5;
    base.settings.startMonthOffset = 0; // 相容舊資料格式，從當月起算。
    const dates = raw.dates && typeof raw.dates === 'object' && !Array.isArray(raw.dates) ? raw.dates : {};
    Object.entries(dates).forEach(([day, entry]) => {
      if (!parseDate(day) || !entry || typeof entry !== 'object') return;
      const v = {};
      if (['open', 'closed', 'no_checkin', 'booked'].includes(entry.stay)) v.stay = entry.stay;
      if (['open', 'closed'].includes(entry.checkout)) v.checkout = entry.checkout;
      if (Object.keys(v).length) base.dates[day] = v;
    });
    return base;
  }
  function getStatus(key, data) {
    const d = data && data.dates && data.dates[key] || {};
    const w = weekday(key);
    // 預設：週五、六、日可住宿；週六、日、一可退房。
    const defaultStay = [5, 6, 0].includes(w) ? 'open' : 'closed';
    const defaultCheckout = [6, 0, 1].includes(w) ? 'open' : 'closed';
    return {
      stay: d.stay || defaultStay,
      checkout: d.checkout || defaultCheckout,
      manualStay: d.stay || '', manualCheckout: d.checkout || ''
    };
  }
  function checkRange(start, end, data, today = todayTaiwan()) {
    if (!parseDate(start) || !parseDate(end) || end <= start || start < today) return false;
    if (getStatus(start, data).stay !== 'open' || getStatus(end, data).checkout !== 'open') return false;
    if (getStatus(end, data).stay === 'booked') return false;
    // 退房日不需要住宿；但中間任何灰底／已訂房「夜晚」一律不可跨越。
    let current = start;
    let guard = 0;
    while (current < end && guard++ < 370) {
      if (getStatus(current, data).stay !== 'open') return false;
      current = nextDay(current);
    }
    return current === end;
  }
  function rangeNights(start, end) {
    const a = parseDate(start), b = parseDate(end);
    return a && b ? Math.round((b.getTime() - a.getTime()) / 86400000) : 0;
  }
  function displayDate(key) {
    const d = parseDate(key);
    return d ? `${d.getUTCFullYear()} / ${d.getUTCMonth() + 1} / ${d.getUTCDate()}` : key;
  }
  function monthKeys(year, month) {
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Array.from({length: days}, (_, i) => dateKey(year, month, i + 1));
  }
  // 單月檢視：月份切換在同一張日曆中完成，並保留上月最後一週作跨月點選。
  function createMonth(year, month, cellForDate, controls = {}) {
    const article = document.createElement('article');
    article.className = 'cal-month';
    const heading = document.createElement('div');
    heading.className = 'cal-month-heading';
    const title = document.createElement('h3');
    title.textContent = `${year} 年 ${month} 月`;
    if (controls.navigation) {
      const previous = document.createElement('button');
      previous.type = 'button'; previous.className = 'cal-nav-button cal-nav-prev';
      previous.textContent = '<'; previous.disabled = !controls.canPrev;
      previous.setAttribute('aria-label', '上一個月份');
      if (controls.canPrev) previous.addEventListener('click', controls.onPrev);
      const next = document.createElement('button');
      next.type = 'button'; next.className = 'cal-nav-button cal-nav-next';
      next.textContent = '>'; next.disabled = !controls.canNext;
      next.setAttribute('aria-label', '下一個月份');
      if (controls.canNext) next.addEventListener('click', controls.onNext);
      heading.append(previous, title, next);
    } else heading.append(title);
    article.append(heading);
    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', title.textContent);
    CHINESE_WEEKDAYS.forEach(day => {
      const head = document.createElement('span');
      head.className = 'cal-weekday';
      head.textContent = day;
      grid.append(head);
    });
    if (controls.adjacent) {
      const first = new Date(Date.UTC(year, month - 1, 1));
      const weekdayOffset = first.getUTCDay();
      // 保留前月最後一週的日期；若本月 1 號是星期日，另外保留完整上一週。
      const countPrevious = weekdayOffset || 7;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const currentCount = countPrevious + lastDay;
      const countNext = (7 - (currentCount % 7)) % 7;
      for (let i = -countPrevious; i < lastDay + countNext; i++) {
        const d = new Date(Date.UTC(year, month - 1, i + 1));
        const key = keyFromUTC(d);
        const adjacent = i < 0 || i >= lastDay;
        const day = cellForDate(key, adjacent);
        if (adjacent) {
          day.classList.add('is-adjacent');
          const sub = document.createElement('span');
          sub.className = 'cal-adjacent-month';
          sub.textContent = `${d.getUTCMonth() + 1}月`;
          day.append(sub);
        }
        grid.append(day);
      }
    } else {
      const firstDayOfWeek = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
      for (let i = 0; i < firstDayOfWeek; i++) {
        const blank = document.createElement('span');
        blank.className = 'cal-empty';
        blank.setAttribute('aria-hidden', 'true');
        grid.append(blank);
      }
      monthKeys(year, month).forEach(key => grid.append(cellForDate(key, false)));
    }
    article.append(grid);
    return article;
  }

  global.CloudCalendar = {dateKey, parseDate, nextDay, todayTaiwan, weekday, monthList,
    emptyData, normalize, getStatus, checkRange, rangeNights, displayDate, createMonth, monthKeys};
})(window);

/* 首頁：只讀取同目錄的 calendar-data.json，絕不寫入後台資料。 */
(function () {
  'use strict';
  const root = document.getElementById('Calendar');
  if (!root) return;
  const C = window.CloudCalendar;
  const monthsEl = document.getElementById('calendarMonths');
  const msgEl = document.getElementById('calendarResult');
  const statusEl = document.getElementById('calendarLoadStatus');
  const inquiryEl = document.getElementById('calendarInquiry');
  const clearEl = document.getElementById('calendarClear');
  const copyEl = document.getElementById('calendarCopy');
  const nextCheckoutEl = document.getElementById('calendarNextMonthCheckout');
  let data = null, start = null, end = null, feedback = '', monthIndex = 0;
  const today = C.todayTaiwan();

  function choose(key) {
    if (!data) return;
    if (start && !end && key === start) { start = null; feedback = ''; render(); return; }
    const openStay = C.getStatus(key, data).stay === 'open' && key >= today;
    if (start && !end && key > start) {
      if (C.checkRange(start, key, data, today)) {
        end = key; feedback = '';
      } else {
        feedback = '這個退房日期不符合開放規則，或途中有無法住宿的日期，請重新選擇。';
      }
    } else if (openStay) {
      start = key; end = null; feedback = '';
    }
    render();
  }
  function render() {
    if (!data) return;
    monthsEl.replaceChildren();
    const visibleMonths = C.monthList(data.settings, today);
    if (!visibleMonths.length) return;
    monthIndex = Math.max(0, Math.min(monthIndex, visibleMonths.length - 1));
    const {year, month} = visibleMonths[monthIndex];
    const firstAllowed = C.dateKey(visibleMonths[0].year, visibleMonths[0].month, 1);
    const lastMonth = visibleMonths[visibleMonths.length - 1];
    const lastDay = new Date(Date.UTC(lastMonth.year, lastMonth.month, 0)).getUTCDate();
    const lastAllowed = C.dateKey(lastMonth.year, lastMonth.month, lastDay);
    const lastCheckout = C.nextDay(lastAllowed);
    const dayCell = (key, adjacent) => {
      const state = C.getStatus(key, data);
      const inPast = key < today;
      const canStay = !inPast && key >= firstAllowed && key <= lastAllowed && state.stay === 'open';
      const canExit = !!(start && !end && key > start && key <= lastCheckout && C.checkRange(start, key, data, today));
      const selectable = canStay || canExit;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-day';
      const num = document.createElement('span');
      num.className = 'cal-day-num';
      num.textContent = String(Number(key.slice(-2)));
      cell.append(num);
      cell.dataset.date = key;
      cell.disabled = !selectable;
      const selectedA = key === start, selectedB = key === end;
      const inRange = !!(start && end && key > start && key < end);
      // 預設僅能入住的日子是黑字；只能退房的日期先維持灰字，
      // 唯有選定有效入住日且這一天確實可退房時，才轉為黑字及可點選。
      if (inPast) cell.classList.add('is-past'); // 過去日期灰字、不加斜線且不可選取。
      else if (state.stay === 'booked') cell.classList.add('is-booked');
      else if (!canStay && !canExit) cell.classList.add('is-unavailable');
      if (key < firstAllowed || (key > lastAllowed && !canExit)) cell.classList.add('is-outside-limit');
      if (canExit) cell.classList.add('is-checkout-ready');
      if (inRange) cell.classList.add('is-in-range');
      if (selectedA) cell.classList.add('is-start');
      if (selectedB) cell.classList.add('is-end');
      if (selectable) {
        cell.addEventListener('click', () => choose(key));
        cell.title = canExit && canStay ? `${key}：可入住或退房` : canExit ? `${key}：可退房` : `${key}：可入住`;
      }
      const reason = inPast ? '日期已過' : state.stay === 'booked' ? '已訂房' : state.stay !== 'open' && state.checkout === 'closed' ? '不開放入住、不可退房' : state.stay !== 'open' ? '不開放入住、可退房' : state.checkout === 'closed' ? '可入住、不可退房' : '可入住、可退房';
      cell.setAttribute('aria-label', `${C.displayDate(key)}，${reason}${selectedA ? '，已選入住日' : selectedB ? '，已選退房日' : ''}${!selectable ? '，目前不可點選' : ''}`);
      cell.setAttribute('aria-pressed', selectedA || selectedB ? 'true' : 'false');
      return cell;
    };
    monthsEl.append(C.createMonth(year, month, dayCell, {
      navigation: true, adjacent: true,
      canPrev: monthIndex > 0, canNext: monthIndex < visibleMonths.length - 1,
      onPrev: () => { monthIndex--; render(); },
      onNext: () => { monthIndex++; render(); }
    }));
    // 當最後一個月份的月底為週六，隔月一日不會進入日曆尾端補齊格，額外提供退房鈕。
    const canExitBeyondCalendar = !!(start && !end && C.checkRange(start, lastCheckout, data, today));
    nextCheckoutEl.hidden = !canExitBeyondCalendar || !!monthsEl.querySelector(`.cal-day[data-date="${lastCheckout}"]`);
    if (!nextCheckoutEl.hidden) {
      nextCheckoutEl.textContent = `選擇 ${C.displayDate(lastCheckout)} 退房`;
      nextCheckoutEl.onclick = () => { end = lastCheckout; feedback = ''; render(); };
    }
    clearEl.hidden = !start;
    if (start && end) {
      msgEl.className = 'cal-result has-availability';
      msgEl.textContent = `入住 ${C.displayDate(start)}　→　退房 ${C.displayDate(end)}（${C.rangeNights(start, end)} 晚）\n尚有空房，請洽詢三層雲管家確認。`;
      inquiryEl.hidden = false;
      copyEl.hidden = false;
    } else {
      msgEl.className = 'cal-result';
      msgEl.textContent = feedback || (start ? `已選入住 ${C.displayDate(start)}，請切換月份或選擇退房日期；已選日期會保留。` : '請先選擇入住日期，再選擇退房日期。');
      inquiryEl.hidden = true;
      copyEl.hidden = true;
    }
  }
  clearEl.addEventListener('click', () => { start = null; end = null; feedback = ''; render(); });
  copyEl.addEventListener('click', async () => {
    if (!start || !end) return;
    const text = `您好，我想詢問湖內三層雲包棟住宿：\n入住：${C.displayDate(start)}\n退房：${C.displayDate(end)}\n共 ${C.rangeNights(start, end)} 晚，請問是否可以訂房？`;
    try {
      await navigator.clipboard.writeText(text);
      copyEl.textContent = '已複製，可貼到 LINE';
    } catch {
      copyEl.textContent = '無法自動複製，請記下日期';
    }
  });

  fetch(`calendar-data.json?v=${Date.now()}`, {cache: 'no-store'})
    .then(response => { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
    .then(raw => {
      data = C.normalize(raw);
      statusEl.textContent = location.protocol === 'file:' ? '本機展示，尚未連線正式網站。' : '日期僅供詢問參考，實際空房以管家確認為準。';
      render();
    })
    .catch(() => {
      monthsEl.replaceChildren();
      statusEl.textContent = '目前無法取得最新房況資料，為避免誤判已暫停日期選擇。';
      msgEl.className = 'cal-result is-error';
      msgEl.textContent = '請使用下方 LINE 直接詢問三層雲管家。';
      inquiryEl.hidden = false;
      inquiryEl.textContent = 'LINE 聯絡管家';
    });
})();
