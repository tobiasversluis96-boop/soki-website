/**
 * booking.js
 * 6-step Soki booking flow.
 * Handles URL ?type=X pre-selection and Google Calendar confirmation.
 */

(function () {
  'use strict';

  // ─── i18n helper ──────────────────────────────────────────────────────────
  function t(key) {
    var lang = (typeof SOKI_LANG !== 'undefined') ? SOKI_LANG : 'en';
    var dict = (typeof SOKI_I18N !== 'undefined') ? (SOKI_I18N[lang] || SOKI_I18N['en']) : {};
    return (dict[key] !== undefined) ? dict[key] : key;
  }

  function locale() {
    return (typeof SOKI_LANG !== 'undefined' && SOKI_LANG === 'nl') ? 'nl-NL' : 'en-GB';
  }

  // ─── State ────────────────────────────────────────────────────────────────
  var state = {
    step:          1,
    sessionType:   null,
    slot:          null,
    groupSize:     1,
    token:         localStorage.getItem('soki_token') || null,
    user:          null,
    bookingId:     null,
    totalCents:    null,
    stripe:         null,
    stripeElements: null,
    clientSecret:   null,
    paymentIntentId: null,
    promoCode:      null,
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    return fetch('/api' + path, Object.assign({ headers: headers }, opts)).then(function (r) { return r.json(); });
  }

  function eur(cents) {
    return '€' + (cents / 100).toFixed(2).replace('.', ',');
  }

  function fmtDate(dateStr) {
    var parts = dateStr.split('-').map(Number);
    var dt = new Date(parts[0], parts[1] - 1, parts[2]);
    return dt.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function fmtDateShort(dateStr) {
    var parts = dateStr.split('-').map(Number);
    var dt = new Date(parts[0], parts[1] - 1, parts[2]);
    return dt.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'long' });
  }

  function setProgress(n) {
    document.getElementById('progress-fill').style.width = (n / 6 * 100) + '%';
    document.querySelectorAll('.booking-progress__step').forEach(function (el) {
      el.classList.toggle('active', +el.dataset.step === n);
    });
  }

  function showStep(n) {
    document.querySelectorAll('.booking-step').forEach(function (el) {
      el.style.display = 'none';
    });
    document.getElementById('step-' + n).style.display = 'block';
    state.step = n;
    setProgress(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function personStr(n) {
    return n + ' ' + (n === 1 ? t('booking.person') : t('booking.persons'));
  }

  function summaryHTML(includeTotal) {
    if (!state.slot || !state.sessionType) return '';
    var rows = [
      [t('booking.summary.session'), state.sessionType.name],
      [t('booking.summary.date'),    fmtDate(state.slot.date)],
      [t('booking.summary.time'),    state.slot.start_time + ' – ' + state.slot.end_time],
      [t('booking.summary.group'),   personStr(state.groupSize)],
    ];
    if (includeTotal !== false) {
      rows.push([t('booking.summary.total'), eur(state.totalCents || state.sessionType.price_cents * state.groupSize)]);
    }
    var html = '<div class="booking-summary-box__label">' + t('booking.summary.title') + '</div>';
    rows.forEach(function (r) {
      html += '<div class="booking-summary-row' + (r[0] === t('booking.summary.total') ? ' total' : '') + '">' +
        '<span>' + r[0] + '</span><span>' + r[1] + '</span></div>';
    });
    return html;
  }

  function proceedAfterAuth() {
    if (state.user && !state.user.waiver_signed_at) {
      document.querySelectorAll('.booking-step').forEach(function (el) { el.style.display = 'none'; });
      document.getElementById('step-4b').style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    initPayment();
  }

  // ─── Step 1: Session types ─────────────────────────────────────────────────
  function loadSessionTypes() {
    api('/session-types').then(function (types) {
      var container = document.getElementById('session-cards');
      container.innerHTML = types.map(function (t_) {
        return '<div class="pick-card" data-id="' + t_.id + '">' +
          '<div class="pick-card__name"><span class="pick-card__dot" style="background:' + t_.color + '"></span>' + t_.name + '</div>' +
          '<div class="pick-card__duration">' + t_.duration_min + ' ' + t('booking.minutes') + '</div>' +
          '<div class="pick-card__price">' + eur(t_.price_cents) + ' <span>p.p.</span></div>' +
          '<div class="pick-card__desc">' + (t_.description || '') + '</div>' +
          '<div class="pick-card__next-date" id="next-date-' + t_.id + '"></div>' +
          '</div>';
      }).join('');

      // Fetch next available date for each session type
      types.forEach(function (t_) {
        fetchNextAvailable(t_.id);
      });

      container.querySelectorAll('.pick-card').forEach(function (card) {
        card.addEventListener('click', function () {
          container.querySelectorAll('.pick-card').forEach(function (c) { c.classList.remove('selected'); });
          card.classList.add('selected');
          state.sessionType = types.find(function (t_) { return t_.id === +card.dataset.id; });
          loadCalendar();
          showStep(2);
        });
      });

      // URL pre-selection: ?type=X
      var params = new URLSearchParams(window.location.search);
      var preType = parseInt(params.get('type'));
      if (preType) {
        var match = types.find(function (t_) { return t_.id === preType; });
        if (match) {
          state.sessionType = match;
          var card = container.querySelector('[data-id="' + preType + '"]');
          if (card) card.classList.add('selected');
          loadCalendar();
          showStep(2);
        }
      }

      // Quick-book: ?slot=SLOT_ID (from homepage widget)
      var preSlotId = parseInt(params.get('slot'));
      if (preSlotId && !preType) {
        api('/slots/' + preSlotId).then(function (slot) {
          if (!slot || slot.error) return;
          var matchType = types.find(function (t_) { return t_.id === slot.session_type_id || t_.id === slot.type_id; });
          if (!matchType) return;
          state.sessionType = matchType;
          state.slot = slot;
          var saved = parseInt(localStorage.getItem('soki_last_group_size'));
          state.groupSize = (saved && saved >= 1 && saved <= (slot.spots_left || 15)) ? saved : 1;
          updateGroup();
          showStep(3);
        });
      }

      // Resume pending booking: ?resume=BOOKING_ID
      var resumeId = parseInt(params.get('resume'));
      if (resumeId && state.token) {
        api('/bookings/' + resumeId).then(function (b) {
          if (!b || b.error || b.status !== 'pending') return;
          state.bookingId  = b.id;
          state.groupSize  = b.group_size;
          state.totalCents = b.total_cents;
          state.slot = {
            id:         b.time_slot_id,
            date:       b.date,
            start_time: b.start_time,
            end_time:   b.end_time,
          };
          state.sessionType = types.find(function (t_) { return t_.name === b.session_name; }) || { name: b.session_name, price_cents: b.total_cents };
          initPayment();
        });
      }
    });
  }

  // ─── Step 1: Fetch next available date for a session type ──────────────────
  function fetchNextAvailable(sessionTypeId) {
    var now = new Date();
    var y = now.getFullYear();
    var m = now.getMonth() + 1;
    var todayStr = now.toISOString().slice(0, 10);
    var nowTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    api('/slots?session_type_id=' + sessionTypeId + '&year=' + y + '&month=' + m).then(function (slots) {
      var available = slots.filter(function (s) {
        if (s.is_full) return false;
        if (s.date < todayStr) return false;
        if (s.date === todayStr && s.start_time <= nowTime) return false;
        return true;
      });

      if (available.length === 0) {
        // Try next month
        var nm = m + 1, ny = y;
        if (nm > 12) { nm = 1; ny++; }
        api('/slots?session_type_id=' + sessionTypeId + '&year=' + ny + '&month=' + nm).then(function (slots2) {
          var avail2 = slots2.filter(function (s) { return !s.is_full; });
          var el = document.getElementById('next-date-' + sessionTypeId);
          if (el && avail2.length > 0) {
            el.textContent = t('booking.next.available') + fmtDateShort(avail2[0].date);
          }
        });
        return;
      }

      var el = document.getElementById('next-date-' + sessionTypeId);
      if (el) {
        el.textContent = t('booking.next.available') + fmtDateShort(available[0].date);
      }
    });
  }

  // ─── Step 2: Calendar ─────────────────────────────────────────────────────

  var calYear, calMonth, calAllSlots = [];

  function loadCalendar() {
    state.slot = null;

    document.getElementById('step2-sub').textContent =
      state.sessionType.name + ' · ' + eur(state.sessionType.price_cents) + ' p.p.';

    var now = new Date();
    calYear  = now.getFullYear();
    calMonth = now.getMonth() + 1; // 1-based

    fetchCalMonth(calYear, calMonth);
  }

  function fetchCalMonth(year, month) {
    var grid = document.getElementById('cal-grid');
    grid.innerHTML = '<div class="slots-loading">' + t('slots.loading') + '</div>';

    var MONTH_NAMES_NL = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
    var MONTH_NAMES_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var names = (typeof SOKI_LANG !== 'undefined' && SOKI_LANG === 'nl') ? MONTH_NAMES_NL : MONTH_NAMES_EN;
    document.getElementById('cal-month-label').textContent = names[month - 1] + ' ' + year;

    api('/slots?session_type_id=' + state.sessionType.id + '&year=' + year + '&month=' + month)
      .then(function (slots) {
        calAllSlots = slots;
        renderCalGrid(year, month, slots);
        // Hide slots panel when switching months
        document.getElementById('cal-slots-panel').style.display = 'none';
      })
      .catch(function () {
        grid.innerHTML = '<div class="slot-list-empty">' + t('booking.slots.error') + '</div>';
      });
  }

  function renderCalGrid(year, month, slots) {
    var now       = new Date();
    var todayStr  = now.toISOString().slice(0, 10);
    var nowTime   = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

    // Build map: date → available slot count
    var available = {};
    slots.forEach(function (s) {
      if (s.is_full) return;
      if (s.date < todayStr) return;
      if (s.date === todayStr && s.start_time <= nowTime) return;
      available[s.date] = (available[s.date] || 0) + 1;
    });

    // First weekday of month (0=Sun → convert to Mon-first: 0→6, 1→0, …)
    var firstDay = new Date(year, month - 1, 1).getDay();
    var offset   = (firstDay === 0) ? 6 : firstDay - 1;
    var daysInMonth = new Date(year, month, 0).getDate();

    var html = '';
    // Leading empty cells
    for (var i = 0; i < offset; i++) html += '<div class="cal-cell cal-cell--empty"></div>';

    for (var d = 1; d <= daysInMonth; d++) {
      var mm   = String(month).padStart(2, '0');
      var dd   = String(d).padStart(2, '0');
      var dateStr = year + '-' + mm + '-' + dd;

      var isPast    = dateStr < todayStr;
      var hasSlots  = !!available[dateStr];
      var cls = 'cal-cell';
      if (isPast)   cls += ' cal-cell--past';
      if (hasSlots) cls += ' cal-cell--available';
      if (dateStr === todayStr) cls += ' cal-cell--today';

      if (!isPast && hasSlots) {
        html += '<button class="' + cls + '" data-date="' + dateStr + '">' +
          '<span class="cal-day">' + d + '</span>' +
          '<span class="cal-dot"></span>' +
          '</button>';
      } else {
        html += '<div class="' + cls + '"><span class="cal-day">' + d + '</span></div>';
      }
    }

    document.getElementById('cal-grid').innerHTML = html;

    // Bind date clicks
    document.querySelectorAll('#cal-grid .cal-cell--available').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('#cal-grid .cal-cell--selected').forEach(function (b) { b.classList.remove('cal-cell--selected'); });
        btn.classList.add('cal-cell--selected');
        showSlotsForDate(btn.dataset.date);
      });
    });
  }

  function showSlotsForDate(dateStr) {
    var panel    = document.getElementById('cal-slots-panel');
    var dateEl   = document.getElementById('cal-slots-date');
    var listEl   = document.getElementById('cal-slot-list');

    dateEl.textContent = fmtDate(dateStr);
    panel.style.display = 'block';

    var now     = new Date();
    var todayStr = now.toISOString().slice(0, 10);
    var nowTime  = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

    var daySlots = calAllSlots.filter(function (s) {
      if (s.date !== dateStr) return false;
      if (s.date === todayStr && s.start_time <= nowTime) return false;
      return true;
    });

    var available = daySlots.filter(function (s) { return !s.is_full; });
    var fullSlots = daySlots.filter(function (s) { return s.is_full; });

    if (!daySlots.length) {
      listEl.innerHTML = '<div class="slot-list-empty">' + t('booking.slots.empty') + '</div>';
      return;
    }
    if (!available.length && !fullSlots.length) {
      listEl.innerHTML = '<div class="slot-list-empty">' + t('booking.slots.empty') + '</div>';
      return;
    }

    listEl.innerHTML = available.map(function (s) {
      var spotsLeft  = s.spots_left;
      var spotsClass = spotsLeft > 3 ? 'spots--green' : spotsLeft > 1 ? 'spots--orange' : 'spots--red';
      var spotsLabel = spotsLeft === 1 ? t('booking.spots.last') : spotsLeft + ' ' + t('booking.spots.left');
      return '<div class="slot-item" data-slot-id="' + s.id + '">' +
        '<div>' +
          '<div class="slot-item__time">' + s.start_time + ' – ' + s.end_time + '</div>' +
          '<div class="slot-item__info ' + spotsClass + '">' + spotsLabel + '</div>' +
        '</div>' +
        '<div><span class="spots-badge">' + eur(s.price_cents) + ' p.p.</span></div>' +
      '</div>';
    }).join('') + fullSlots.map(function (s) {
      return '<div class="slot-item slot-item--full" data-slot-id="' + s.id + '" style="opacity:0.7;cursor:default;">' +
        '<div>' +
          '<div class="slot-item__time">' + s.start_time + ' – ' + s.end_time + '</div>' +
          '<div class="slot-item__info spots--red">' + t('booking.slot.full') + '</div>' +
        '</div>' +
        '<div>' +
          '<button class="btn btn--outline btn--sm waitlist-join-btn" data-slot-id="' + s.id + '" style="font-size:12px;padding:6px 14px;">' + t('booking.slot.waitlist') + '</button>' +
        '</div>' +
      '</div>';
    }).join('');

    listEl.querySelectorAll('.slot-item:not(.slot-item--full)').forEach(function (el) {
      el.addEventListener('click', function () {
        listEl.querySelectorAll('.slot-item').forEach(function (c) { c.classList.remove('selected'); });
        el.classList.add('selected');
        var slotId = +el.dataset.slotId;
        state.slot = daySlots.find(function (s) { return s.id === slotId; });
        selectSlot();
      });
    });

    listEl.querySelectorAll('.waitlist-join-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var token = localStorage.getItem('soki_token');
        if (!token) {
          alert(t('booking.waitlist.login'));
          return;
        }
        var slotId = +btn.dataset.slotId;
        var slot   = daySlots.find(function (s) { return s.id === slotId; });
        openWaitlistModal(slotId, slot, btn);
      });
    });

    // Scroll to panel
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Calendar prev/next
  document.getElementById('cal-prev').addEventListener('click', function () {
    calMonth--;
    if (calMonth < 1) { calMonth = 12; calYear--; }
    fetchCalMonth(calYear, calMonth);
  });
  document.getElementById('cal-next').addEventListener('click', function () {
    calMonth++;
    if (calMonth > 12) { calMonth = 1; calYear++; }
    fetchCalMonth(calYear, calMonth);
  });

  // ─── Waitlist payment modal ───────────────────────────────────────────────
  function openWaitlistModal(slotId, slot, triggerBtn) {
    var existing = document.getElementById('waitlist-modal');
    if (existing) existing.remove();

    var pricePerPerson = slot ? slot.price_cents : 0;
    var modal = document.createElement('div');
    modal.id = 'waitlist-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1100;display:flex;align-items:center;justify-content:center;padding:24px;';
    modal.innerHTML =
      '<div style="background:#fff;border-radius:16px;padding:32px;max-width:440px;width:100%;">' +
        '<h3 style="font-family:\'Barlow Condensed\',Arial,sans-serif;font-weight:700;text-transform:uppercase;font-size:22px;color:#4A1C0C;margin:0 0 8px;">Wachtlijst</h3>' +
        '<p style="color:#666;font-size:14px;margin:0 0 20px;">Betaal nu. Als er een plek vrijkomt wordt je automatisch ingeboekt. Als er geen plek vrijkomt, storten we je bedrag terug.</p>' +
        (slot ? '<p style="font-weight:600;color:#4A1C0C;margin:0 0 20px;">' + slot.start_time + ' – ' + slot.end_time + ' · ' + eur(pricePerPerson) + ' p.p.</p>' : '') +
        '<div style="margin-bottom:16px;">' +
          '<label style="display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8C7B6B;margin-bottom:6px;">Groepsgrootte</label>' +
          '<div style="display:flex;align-items:center;gap:12px;">' +
            '<button id="wl-minus" style="width:36px;height:36px;border-radius:50%;border:2px solid #E8D5BF;background:#fff;font-size:20px;cursor:pointer;line-height:1;">−</button>' +
            '<span id="wl-count" style="font-size:20px;font-weight:700;min-width:24px;text-align:center;">1</span>' +
            '<button id="wl-plus"  style="width:36px;height:36px;border-radius:50%;border:2px solid #E8D5BF;background:#fff;font-size:20px;cursor:pointer;line-height:1;">+</button>' +
            '<span id="wl-total" style="margin-left:8px;font-size:16px;font-weight:600;color:#D94D1A;">' + eur(pricePerPerson) + '</span>' +
          '</div>' +
        '</div>' +
        '<div id="wl-stripe-container" style="margin-bottom:16px;"></div>' +
        '<div id="wl-error" style="color:#C62828;font-size:13px;margin-bottom:12px;display:none;"></div>' +
        '<div style="display:flex;gap:10px;">' +
          '<button id="wl-cancel-btn" class="btn btn--outline" style="flex:1;">Annuleren</button>' +
          '<button id="wl-pay-btn" class="btn btn--primary" style="flex:2;">' + t('booking.waitlist.pay') + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    var wlGroupSize = 1;
    var wlStripe = null;
    var wlElements = null;
    var wlClientSecret = null;

    function updateWlTotal() {
      document.getElementById('wl-total').textContent = eur(pricePerPerson * wlGroupSize);
      document.getElementById('wl-count').textContent = wlGroupSize;
    }

    document.getElementById('wl-minus').addEventListener('click', function () {
      if (wlGroupSize > 1) { wlGroupSize--; updateWlTotal(); }
    });
    document.getElementById('wl-plus').addEventListener('click', function () {
      if (wlGroupSize < 20) { wlGroupSize++; updateWlTotal(); }
    });

    // Create PaymentIntent and mount Stripe Elements
    var token = localStorage.getItem('soki_token');
    fetch('/api/waitlist/' + slotId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ group_size: wlGroupSize }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.error) {
        document.getElementById('wl-error').textContent = res.error;
        document.getElementById('wl-error').style.display = 'block';
        document.getElementById('wl-pay-btn').disabled = true;
        return;
      }
      wlClientSecret = res.client_secret;
      if (!wlStripe) wlStripe = Stripe(res.publishable_key);

      wlElements = wlStripe.elements({
        clientSecret: res.client_secret,
        appearance: {
          theme: 'stripe',
          variables: { colorPrimary: '#D94D1A', colorText: '#4A1C0C', borderRadius: '10px', fontFamily: "'DM Sans','Helvetica Neue',sans-serif" },
        },
      });
      var el = wlElements.create('payment', { layout: 'tabs', defaultValues: { billingDetails: { address: { country: 'NL' } } }, wallets: { link: 'never' } });
      document.getElementById('wl-stripe-container').innerHTML = '';
      el.mount('#wl-stripe-container');
    }).catch(function () {
      document.getElementById('wl-error').textContent = t('booking.error.load');
      document.getElementById('wl-error').style.display = 'block';
    });

    document.getElementById('wl-cancel-btn').addEventListener('click', function () {
      modal.remove();
      if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = 'Wachtlijst'; }
    });

    document.getElementById('wl-pay-btn').addEventListener('click', function () {
      if (!wlElements || !wlClientSecret) return;
      var payBtn = document.getElementById('wl-pay-btn');
      var errEl  = document.getElementById('wl-error');
      payBtn.disabled = true;
      payBtn.textContent = '\u2026';
      errEl.style.display = 'none';

      wlStripe.confirmPayment({
        elements: wlElements,
        confirmParams: { return_url: window.location.origin + '/payment-return' },
        redirect: 'if_required',
      }).then(function (result) {
        if (result.error) {
          errEl.textContent = result.error.message;
          errEl.style.display = 'block';
          payBtn.disabled = false;
          payBtn.textContent = t('booking.waitlist.pay');
        } else {
          modal.remove();
          if (triggerBtn) {
            triggerBtn.textContent = '\u2713 Op wachtlijst (betaald)';
            triggerBtn.style.color = '#2E7D32';
            triggerBtn.style.borderColor = '#2E7D32';
          }
        }
      });
    });
  }

  function selectSlot() {
    // Load saved group size preference
    var saved = parseInt(localStorage.getItem('soki_last_group_size'));
    if (saved && saved >= 1 && saved <= (state.slot ? state.slot.spots_left : 15)) {
      state.groupSize = saved;
    } else {
      state.groupSize = 1;
    }
    updateGroup();
    showStep(3);
  }

  // ─── Step 3: Group size ───────────────────────────────────────────────────
  function updateGroup() {
    var spotsLeft = state.slot ? state.slot.spots_left : 15;
    if (state.groupSize > spotsLeft) state.groupSize = spotsLeft;
    document.getElementById('group-count').textContent = state.groupSize;
    document.getElementById('group-total').textContent = eur(state.sessionType.price_cents * state.groupSize);
    document.getElementById('group-caption').textContent =
      personStr(state.groupSize) + ' · ' + spotsLeft + ' ' + t('booking.spots.left');
    document.getElementById('group-minus').disabled = state.groupSize <= 1;
    document.getElementById('group-plus').disabled  = state.groupSize >= spotsLeft;
  }

  // ─── Step 4: Auth ─────────────────────────────────────────────────────────
  function showStep4() {
    showStep(4);
    document.getElementById('step4-summary').innerHTML = summaryHTML(false);

    if (state.token) {
      api('/auth/me').then(function (user) {
        if (user.id) {
          state.user = user;
          document.getElementById('logged-in-name').textContent = user.name;
          document.getElementById('step4-logged-in').style.display = 'block';
          document.getElementById('step4-auth').style.display = 'none';
        } else {
          showAuthForms();
        }
      }).catch(showAuthForms);
    } else {
      showAuthForms();
    }
  }

  function showAuthForms() {
    state.token = null;
    localStorage.removeItem('soki_token');
    document.getElementById('step4-logged-in').style.display = 'none';
    document.getElementById('step4-auth').style.display = 'block';
  }

  // ─── Google Sign-In ────────────────────────────────────────────────────────
  var googleClientId = null;

  fetch('/api/config').then(function(r) { return r.json(); }).then(function(cfg) {
    googleClientId = cfg.googleClientId;
  });

  function initGoogleSignIn() {
    if (!googleClientId) return;
    if (typeof google === 'undefined' || !google.accounts) {
      var script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.onload = function() { setupGSI(); };
      document.head.appendChild(script);
    } else {
      setupGSI();
    }
  }

  function setupGSI() {
    google.accounts.id.initialize({
      client_id: googleClientId,
      callback: function(response) {
        handleGoogleCredential(response.credential);
      },
    });
    google.accounts.id.prompt();
  }

  function handleGoogleCredential(credential) {
    fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: credential }),
    }).then(function(r) { return r.json(); }).then(function(res) {
      if (res.error) {
        document.getElementById('login-error').textContent = res.error;
        return;
      }
      state.token = res.token;
      localStorage.setItem('soki_token', res.token);
      state.user = res.user;
      document.getElementById('logged-in-name').textContent = res.user.name;
      document.getElementById('step4-logged-in').style.display = 'block';
      document.getElementById('step4-auth').style.display = 'none';
    });
  }

  // ─── Step 5: Payment ──────────────────────────────────────────────────────
  function initPayment() {
    showStep(5);
    document.getElementById('payment-summary').innerHTML = summaryHTML();
    document.getElementById('stripe-errors').textContent = '';

    // Check subscription first
    if (state.token) {
      fetch('/api/subscriptions/credit-cost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ session_type_id: state.sessionType.id }),
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.can_book) {
          // Ensure booking exists before showing member payment
          ensureBooking(function() { showMemberPayment(data); });
        } else if (data.has_subscription && !data.is_unlimited) {
          document.getElementById('stripe-errors').textContent =
            'Je hebt ' + data.credits_remaining + ' credits over, maar hebt er ' + data.credits_cost + ' nodig. Je kunt gewoon betalen via iDEAL of kaart.';
          initStripePayment();
        } else {
          initStripePayment();
        }
      }).catch(function() {
        initStripePayment();
      });
    } else {
      initStripePayment();
    }
  }

  function ensureBooking(callback) {
    if (state.bookingId) { callback(); return; }
    api('/bookings', {
      method: 'POST',
      body: JSON.stringify({ slot_id: state.slot.id, group_size: state.groupSize }),
    }).then(function (bRes) {
      if (bRes.error) { document.getElementById('stripe-errors').textContent = bRes.error; return; }
      state.bookingId  = bRes.booking_id;
      state.totalCents = bRes.total_cents;
      callback();
    });
  }

  function showMemberPayment(data) {
    var creditsText = data.is_unlimited
      ? 'Your Unlimited membership covers this session.'
      : 'This will use ' + data.credits_cost + ' of your ' + data.credits_remaining + ' remaining credits.';

    document.getElementById('stripe-element').innerHTML =
      '<div style="background:rgba(46,125,50,0.06);border:1.5px solid rgba(46,125,50,0.3);border-radius:14px;padding:20px;text-align:center;">' +
        '<div style="font-size:1.5rem;margin-bottom:8px;">&#10003;</div>' +
        '<div style="font-weight:700;color:#2E7D32;margin-bottom:6px;">Member booking</div>' +
        '<div style="font-size:14px;color:var(--text-muted,#8C7B6B);">' + creditsText + '</div>' +
      '</div>';

    document.getElementById('payment-request-btn-container').style.display = 'none';

    var payBtn = document.getElementById('pay-btn');
    payBtn.querySelector('#pay-label').textContent = data.is_unlimited ? t('booking.member.unlimited') : t('booking.member.credits').replace('{n}', data.credits_cost);
    payBtn.disabled = false;
    payBtn.onclick = function() {
      confirmMemberBooking(data.credits_cost, data.is_unlimited);
    };
  }

  function confirmMemberBooking(creditsCost, isUnlimited) {
    var payBtn = document.getElementById('pay-btn');
    payBtn.disabled = true;
    payBtn.querySelector('#pay-label').innerHTML = '<span class="btn-spinner"></span>';

    fetch('/api/bookings/' + state.bookingId + '/confirm-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ credits_to_use: isUnlimited ? 0 : creditsCost }),
    }).then(function(r) { return r.json(); }).then(function(res) {
      if (res.error) {
        document.getElementById('stripe-errors').textContent = res.error;
        payBtn.disabled = false;
        payBtn.querySelector('#pay-label').textContent = t('booking.retry');
        return;
      }
      showConfirmation();
    });
  }

  function initStripePayment() {
    var doInit = function () {
      api('/payments/create-intent', {
        method: 'POST',
        body: JSON.stringify({ booking_id: state.bookingId }),
      }).then(function (pRes) {
        if (pRes.error) { document.getElementById('stripe-errors').textContent = pRes.error; return; }
        state.clientSecret    = pRes.client_secret;
        state.paymentIntentId = pRes.payment_intent_id;
        state.totalCents      = pRes.amount;

        if (!state.stripe) state.stripe = Stripe(pRes.publishable_key);
        state.stripeElements = state.stripe.elements({
          clientSecret: pRes.client_secret,
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary:      '#D94D1A',
              colorText:         '#4A1C0C',
              colorBackground:   '#ffffff',
              borderRadius:      '10px',
              fontFamily:        "'DM Sans', 'Helvetica Neue', sans-serif",
            },
          },
        });
        var paymentElement = state.stripeElements.create('payment', {
          layout: 'tabs',
          defaultValues: {
            billingDetails: { address: { country: 'NL' } },
          },
          wallets: {
            link: 'never',
            applePay: 'auto',
            googlePay: 'auto',
          },
        });
        document.getElementById('stripe-element').innerHTML = '';
        paymentElement.mount('#stripe-element');

        // ── Payment Request Button (Apple Pay / Google Pay) ──
        var paymentRequest = state.stripe.paymentRequest({
          country: 'NL',
          currency: 'eur',
          total: { label: 'Soki Social Sauna', amount: pRes.amount },
          requestPayerName: true,
          requestPayerEmail: true,
        });

        var prButton = state.stripeElements.create('paymentRequestButton', {
          paymentRequest: paymentRequest,
        });

        paymentRequest.canMakePayment().then(function (result) {
          if (result) {
            document.getElementById('payment-request-btn').innerHTML = '';
            prButton.mount('#payment-request-btn');
            document.getElementById('payment-request-btn-container').style.display = 'block';
          } else {
            document.getElementById('payment-request-btn-container').style.display = 'none';
          }
        });

        paymentRequest.on('paymentmethod', function (ev) {
          state.stripe.confirmCardPayment(
            pRes.client_secret,
            { payment_method: ev.paymentMethod.id },
            { handleActions: false }
          ).then(function (confirmResult) {
            if (confirmResult.error) {
              ev.complete('fail');
              document.getElementById('stripe-errors').textContent = confirmResult.error.message;
            } else {
              ev.complete('success');
              if (confirmResult.paymentIntent.status === 'requires_action') {
                state.stripe.confirmCardPayment(pRes.client_secret).then(function (actionResult) {
                  if (actionResult.error) {
                    document.getElementById('stripe-errors').textContent = actionResult.error.message;
                  } else {
                    api('/payments/confirm', {
                      method: 'POST',
                      body: JSON.stringify({ payment_intent_id: actionResult.paymentIntent.id }),
                    }).then(function (conf) {
                      if (conf.confirmed) showConfirmation();
                      else document.getElementById('stripe-errors').textContent = t('booking.error.payment');
                    });
                  }
                });
              } else {
                api('/payments/confirm', {
                  method: 'POST',
                  body: JSON.stringify({ payment_intent_id: confirmResult.paymentIntent.id }),
                }).then(function (conf) {
                  if (conf.confirmed) showConfirmation();
                  else document.getElementById('stripe-errors').textContent = t('booking.error.payment');
                });
              }
            }
          });
        });

        document.getElementById('pay-label').textContent = t('booking.pay.prefix') + eur(pRes.amount);

        // Reset pay button to use Stripe flow
        document.getElementById('pay-btn').onclick = null;
      });
    };

    if (state.bookingId) {
      doInit();
      return;
    }

    api('/bookings', {
      method: 'POST',
      body: JSON.stringify({ slot_id: state.slot.id, group_size: state.groupSize }),
    }).then(function (bRes) {
      if (bRes.error) { document.getElementById('stripe-errors').textContent = bRes.error; return; }
      state.bookingId  = bRes.booking_id;
      state.totalCents = bRes.total_cents;
      doInit();
    });
  }

  // ─── Step 6: Confirmation ─────────────────────────────────────────────────
  function showConfirmation() {
    showStep(6);

    // Save group size preference
    localStorage.setItem('soki_last_group_size', String(state.groupSize));

    document.getElementById('confirm-email-note').innerHTML =
      t('booking.confirm.sent') + ' <strong>' + (state.user ? state.user.email : '') + '</strong>' + t('booking.confirm.see');

    document.getElementById('confirm-summary').innerHTML = summaryHTML();

    // Google Calendar link
    var s = state.slot;
    var tp = state.sessionType;
    if (s && tp) {
      var d   = s.date.replace(/-/g, '');
      var st  = s.start_time.replace(':', '') + '00';
      var en  = s.end_time.replace(':', '') + '00';
      var gcalUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
        '&text=' + encodeURIComponent('Soki Social Sauna – ' + tp.name) +
        '&dates=' + d + 'T' + st + '/' + d + 'T' + en +
        '&details=' + encodeURIComponent('Booking #' + state.bookingId + '\nGroup: ' + personStr(state.groupSize)) +
        '&location=' + encodeURIComponent('Gietijzerstraat 3, Utrecht');
      document.getElementById('gcal-btn').href = gcalUrl;
    }

    // QR link on confirmation
    var qrNote = document.getElementById('confirm-qr-note');
    if (qrNote && state.bookingId) {
      qrNote.innerHTML = '<a href="/account#qr-' + state.bookingId + '" style="color:var(--terra);font-size:0.875rem;">\u2192 Bekijk QR-code voor inchecken in je account</a>';
    }
  }

  // ─── Event bindings ────────────────────────────────────────────────────────
  function bind() {
    // Step 2 back
    document.getElementById('back-1').addEventListener('click', function () { showStep(1); });

    // Step 3 nav — back goes to slot list (step 2)
    document.getElementById('back-2').addEventListener('click', function () { showStep(2); });
    document.getElementById('next-3').addEventListener('click', showStep4);
    document.getElementById('group-minus').addEventListener('click', function () {
      if (state.groupSize > 1) { state.groupSize--; updateGroup(); }
    });
    document.getElementById('group-plus').addEventListener('click', function () {
      if (state.groupSize < (state.slot ? state.slot.spots_left : 15)) {
        state.groupSize++;
        updateGroup();
      }
    });

    // Step 4 back
    ['back-3a', 'back-3b', 'back-3c'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', function () { showStep(3); });
    });

    document.getElementById('next-4a').addEventListener('click', proceedAfterAuth);

    document.getElementById('back-4b').addEventListener('click', showStep4);
    document.getElementById('waiver-submit').addEventListener('click', function () {
      if (!document.getElementById('waiver-agree').checked) {
        document.getElementById('waiver-error').textContent = t('waiver.error');
        return;
      }
      document.getElementById('waiver-error').textContent = '';
      var btn = document.getElementById('waiver-submit');
      btn.disabled = true;
      var token = localStorage.getItem('soki_token');
      fetch('/api/auth/me/waiver', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      }).then(function() {
        if (state.user) state.user.waiver_signed_at = new Date().toISOString();
        btn.disabled = false;
        initPayment();
      }).catch(function() {
        btn.disabled = false;
      });
    });

    // Google sign-in
    document.getElementById('google-signin-btn').addEventListener('click', initGoogleSignIn);

    // Auth tabs
    document.getElementById('tab-login').addEventListener('click', function () {
      document.getElementById('tab-login').classList.add('active');
      document.getElementById('tab-register').classList.remove('active');
      document.getElementById('login-form').style.display = 'block';
      document.getElementById('register-form').style.display = 'none';
    });
    document.getElementById('tab-register').addEventListener('click', function () {
      document.getElementById('tab-register').classList.add('active');
      document.getElementById('tab-login').classList.remove('active');
      document.getElementById('register-form').style.display = 'block';
      document.getElementById('login-form').style.display = 'none';
    });

    // Login
    document.getElementById('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      document.getElementById('login-error').textContent = '';
      var btn = e.target.querySelector('[type=submit]');
      btn.disabled = true;
      api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email:    document.getElementById('login-email').value,
          password: document.getElementById('login-password').value,
        }),
      }).then(function (res) {
        btn.disabled = false;
        if (res.error) { document.getElementById('login-error').textContent = res.error; return; }
        state.token = res.token;
        state.user  = res.user;
        localStorage.setItem('soki_token', res.token);
        proceedAfterAuth();
      });
    });

    // Register
    document.getElementById('register-form').addEventListener('submit', function (e) {
      e.preventDefault();
      document.getElementById('reg-error').textContent = '';
      const gdprConsent = document.getElementById('gdpr-consent');
      if (gdprConsent && !gdprConsent.checked) {
        document.getElementById('reg-error').textContent = t('booking.gdpr');
        return;
      }
      var btn = e.target.querySelector('[type=submit]');
      btn.disabled = true;
      api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name:     document.getElementById('reg-name').value,
          email:    document.getElementById('reg-email').value,
          password: document.getElementById('reg-password').value,
        }),
      }).then(function (res) {
        btn.disabled = false;
        if (res.error) { document.getElementById('reg-error').textContent = res.error; return; }
        state.token = res.token;
        state.user  = res.user;
        localStorage.setItem('soki_token', res.token);
        proceedAfterAuth();
      });
    });

    // Promo code toggle
    document.getElementById('promo-toggle').addEventListener('click', function () {
      var field = document.getElementById('promo-field');
      field.style.display = field.style.display === 'none' ? 'flex' : 'none';
    });

    // Promo code apply
    document.getElementById('promo-apply').addEventListener('click', function () {
      var code = document.getElementById('promo-input').value.trim();
      var msgEl = document.getElementById('promo-msg');
      if (!code) { msgEl.textContent = t('promo.empty'); msgEl.style.color = '#C62828'; return; }

      var applyBtn = document.getElementById('promo-apply');
      applyBtn.disabled = true;
      msgEl.textContent = '';

      api('/bookings', {
        method: 'POST',
        body: JSON.stringify({ slot_id: state.slot.id, group_size: state.groupSize, promo_code: code }),
      }).then(function (res) {
        applyBtn.disabled = false;
        if (res.error) {
          msgEl.style.color = '#C62828';
          msgEl.textContent = res.error;
          return;
        }
        if (res.free) {
          state.bookingId  = res.booking_id;
          state.totalCents = 0;
          state.promoCode  = code;
          msgEl.style.color = '#2E7D32';
          msgEl.textContent = t('promo.accepted');
          document.getElementById('stripe-element').style.display = 'none';
          document.getElementById('payment-request-btn-container').style.display = 'none';
          var payBtn = document.getElementById('pay-btn');
          payBtn.disabled = false;
          payBtn.querySelector('#pay-label').textContent = t('promo.confirm');
          payBtn.onclick = function () { showConfirmation(); };
        } else if (res.discount_cents > 0) {
          state.bookingId  = res.booking_id;
          state.totalCents = res.total_cents;
          state.promoCode  = code;
          msgEl.style.color = '#2E7D32';
          var saved = (res.discount_cents / 100).toFixed(2).replace('.', ',');
          var msg = '✓ Code geaccepteerd! Je bespaart €' + saved + '.';
          if (res.gift_card_remaining !== undefined) {
            var rem = (res.gift_card_remaining / 100).toFixed(2).replace('.', ',');
            msg += ' Resterend saldo: €' + rem + '.';
          }
          msgEl.textContent = msg;
        } else {
          msgEl.style.color = '#C62828';
          msgEl.textContent = t('promo.invalid');
        }
      });
    });

    // Step 5 back
    document.getElementById('back-4').addEventListener('click', showStep4);

    // Pay
    document.getElementById('pay-btn').addEventListener('click', function () {
      var btn = document.getElementById('pay-btn');
      var errEl = document.getElementById('stripe-errors');
      btn.disabled = true;
      document.getElementById('pay-label').innerHTML = '<span class="btn-spinner"></span>';
      errEl.textContent = '';

      state.stripe.confirmPayment({
        elements: state.stripeElements,
        confirmParams: {
          return_url: window.location.origin + '/payment-return',
        },
        redirect: 'if_required',
      }).then(function (result) {
        if (result.error) {
          errEl.textContent = result.error.message;
          btn.disabled = false;
          document.getElementById('pay-label').textContent = t('booking.retry');
          return;
        }
        api('/payments/confirm', {
          method: 'POST',
          body: JSON.stringify({ payment_intent_id: result.paymentIntent.id }),
        }).then(function (conf) {
          if (conf.confirmed) {
            showConfirmation();
          } else {
            errEl.textContent = t('booking.error.payment');
            btn.disabled = false;
            document.getElementById('pay-label').textContent = t('booking.retry');
          }
        });
      });
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  bind();
  loadSessionTypes();

})();
