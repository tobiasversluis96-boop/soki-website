/**
 * admin/admin.js
 * Admin dashboard: login, bookings, slots, analytics.
 */

(function () {
  'use strict';

  let adminToken       = sessionStorage.getItem('soki_admin_token');
  let sessionTypes     = [];
  let isAdminUser      = sessionStorage.getItem('soki_admin_type') !== 'staff';
  let staffPermissions = JSON.parse(sessionStorage.getItem('soki_staff_perms') || '[]');

  function hasPermission(perm) {
    return isAdminUser || staffPermissions.includes(perm);
  }

  function parseJwt(token) {
    try { return JSON.parse(atob(token.split('.')[1])); } catch { return {}; }
  }

  // ─── API ──────────────────────────────────────────────────────────────────
  function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;
    return fetch('/api/admin' + path, { headers, ...opts }).then(r => {
      if (r.status === 401) {
        logout();
        throw new Error('Unauthorized');
      }
      return r.json();
    });
  }

  function formatEur(cents) {
    return '€' + (cents / 100).toFixed(2).replace('.', ',');
  }

  function formatDate(dateStr) {
    if (!dateStr) return '–';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function statusBadge(status) {
    const map = {
      confirmed: ['Bevestigd', 'confirmed'],
      pending:   ['In behandeling', 'pending'],
      cancelled: ['Geannuleerd', 'cancelled'],
    };
    const [label, cls] = map[status] || ['–', 'pending'];
    return `<span class="status-badge status-badge--${cls}">${label}</span>`;
  }

  // ─── Login ────────────────────────────────────────────────────────────────
  document.getElementById('admin-login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = document.getElementById('login-err');
    err.textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;

    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:    document.getElementById('admin-email').value,
        password: document.getElementById('admin-password').value,
      }),
    }).then(r => r.json());

    btn.disabled = false;
    if (res.error) { err.textContent = res.error; return; }
    adminToken       = res.token;
    isAdminUser      = res.type !== 'staff';
    staffPermissions = res.permissions || [];
    sessionStorage.setItem('soki_admin_token', res.token);
    sessionStorage.setItem('soki_admin_type',  res.type || 'admin');
    sessionStorage.setItem('soki_staff_perms', JSON.stringify(staffPermissions));
    showApp();
  });

  function logout() {
    adminToken = null;
    sessionStorage.removeItem('soki_admin_token');
    sessionStorage.removeItem('soki_admin_type');
    sessionStorage.removeItem('soki_staff_perms');
    document.getElementById('app').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
  }

  document.getElementById('admin-logout').addEventListener('click', logout);

  // Permission → nav view mapping
  const PERM_NAV = { dashboard: 'revenue', revenue: 'revenue', bookings: 'bookings', slots: 'slots', schedule: 'schedule', customers: 'customers', generate: 'generate', messages: 'messages' };

  function applyPermissions() {
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      const view = btn.dataset.view;
      if (view === 'staff') { btn.style.display = isAdminUser ? '' : 'none'; return; }
      if (view === 'generate') { btn.style.display = isAdminUser ? '' : 'none'; return; }
      const perm = PERM_NAV[view];
      btn.style.display = (!perm || hasPermission(perm)) ? '' : 'none';
    });
    // Show user name in topbar for staff
    const payload = parseJwt(adminToken);
    const nameEl = document.getElementById('topbar-user-name');
    if (nameEl) nameEl.textContent = isAdminUser ? 'Admin' : (payload.name || 'Staff');
  }

  function firstAllowedView() {
    if (isAdminUser)               return 'dashboard';
    if (hasPermission('schedule')) return 'schedule';
    if (hasPermission('bookings')) return 'bookings';
    if (hasPermission('customers'))return 'customers';
    if (hasPermission('messages')) return 'messages';
    if (hasPermission('slots'))    return 'slots';
    if (hasPermission('revenue'))  return 'dashboard';
    return 'schedule';
  }

  function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    loadSessionTypes();
    applyPermissions();
    showView(firstAllowedView());
  }

  // ─── Views ────────────────────────────────────────────────────────────────
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    const navBtn = document.querySelector('.nav-item[data-view="' + name + '"]');
    if (navBtn) navBtn.classList.add('active');

    const titles = { dashboard: 'Dashboard', revenue: 'Omzet & Analytics', bookings: 'Boekingen', slots: 'Tijdslots', schedule: 'Rooster', customers: 'Klanten', generate: 'Slots genereren', messages: 'Berichten', staff: 'Medewerkers' };
    document.getElementById('topbar-title').textContent = titles[name] || name;

    if (name === 'dashboard') loadDashboard();
    if (name === 'revenue')   loadDashboard();
    if (name === 'bookings')  loadBookings();
    if (name === 'slots')     loadSlots();
    if (name === 'schedule')  loadSchedule();
    if (name === 'customers') loadCustomers();
    if (name === 'generate')  loadGenerate();
    if (name === 'messages')  loadMessages();
    if (name === 'staff') {
      // Admin sees full staff management; staff only sees own password change
      const createSection = document.querySelector('#view-staff .table-card');
      const staffListSection = document.getElementById('staff-list');
      const staffListHeader  = document.querySelector('#view-staff .section-header');
      if (createSection) createSection.style.display = isAdminUser ? '' : 'none';
      if (staffListSection) staffListSection.style.display = isAdminUser ? '' : 'none';
      if (staffListHeader)  staffListHeader.style.display  = isAdminUser ? '' : 'none';
      if (isAdminUser) loadStaff();
    }
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────
  async function loadDashboard() {
    const canSeeRevenue = isAdminUser || hasPermission('revenue');

    // Staff without revenue: show only forward view
    if (!canSeeRevenue) {
      document.getElementById('revenue-charts').style.display = 'none';
      document.getElementById('stat-grid').style.display = 'none';
      document.getElementById('staff-forward-view').style.display = 'block';
      const fwd = await api('/analytics/enhanced');
      const el  = document.getElementById('staff-forward-list');
      if (fwd.error || !fwd.forwardView) { el.innerHTML = '–'; return; }
      el.innerHTML = fwd.forwardView.length === 0 ? '<p style="color:var(--text-muted)">Geen sessies gepland.</p>' :
        fwd.forwardView.map(s => {
          const pct = s.capacity ? Math.round(s.booked / s.capacity * 100) : 0;
          return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(0,0,0,.05);">
            <div style="width:8px;height:8px;border-radius:50%;background:${s.color||'#D94D1A'};flex-shrink:0;"></div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;font-size:14px;">${s.session_name} <span style="font-weight:400;color:var(--text-muted)">${s.start_time}–${s.end_time}</span></div>
              <div style="font-size:12px;color:var(--text-muted)">${s.date}</div>
            </div>
            <div style="text-align:right;font-size:13px;font-weight:600;">${s.booked}/${s.capacity} <span style="font-weight:400;color:${pct>=90?'#C62828':'var(--text-muted)'}">(${pct}%)</span></div>
          </div>`;
        }).join('');
      return;
    }

    let data, enhanced;
    try {
      [data, enhanced] = await Promise.all([
        api('/analytics'),
        api('/analytics/enhanced'),
      ]);
    } catch (err) {
      document.getElementById('stat-grid').innerHTML = `<div style="color:#C62828;padding:12px">Fout bij laden: ${err.message}</div>`;
      ['occupancy-bars','subscription-stats','peak-heatmap','retention-bars','forward-view'].forEach(id => {
        document.getElementById(id).innerHTML = '–';
      });
      return;
    }
    if (enhanced.error) {
      document.getElementById('stat-grid').innerHTML = `<div style="color:#C62828;padding:12px">Analytics fout: ${enhanced.error}</div>`;
      return;
    }

    // ── Stat cards (row 1) ──
    const totalMembers = enhanced.subscriptionPlans.reduce((s, p) => s + p.active_count, 0);
    document.getElementById('stat-grid').innerHTML = [
      { label: 'Totaal boekingen',  value: data.totalBookings,         sub: 'actief' },
      { label: 'Bevestigd',         value: data.confirmedBookings,      sub: 'betaald' },
      { label: 'Omzet (deze maand)', value: formatEur(data.totalRevenue), sub: 'bevestigde boekingen' },
      { label: 'Abonnementen',      value: formatEur(enhanced.mrr),     sub: totalMembers + ' actieve leden' },
    ].map(s => `
      <div class="stat-card">
        <div class="stat-card__label">${s.label}</div>
        <div class="stat-card__value">${s.value}</div>
        <div class="stat-card__sub">${s.sub}</div>
      </div>
    `).join('');

    renderRevenueChart(enhanced.revenuePerWeek);
    renderOccupancy(enhanced.occupancy);
    renderPeakHeatmap(enhanced.peakDays);
    renderRetention(enhanced.customerRetention, enhanced.cancellationRate);
    renderForwardView(enhanced.forwardView);
    renderSubscriptions(enhanced.subscriptionPlans, enhanced.mrr);
    renderMonthlyRevenueChart(enhanced.revenuePerMonth, enhanced.currentMonthProjection);
  }

  function renderRevenueChart(weeks) {
    const maxRev = Math.max(...weeks.map(w => w.revenue_cents), 1);
    document.getElementById('chart-columns').innerHTML = weeks.map(w => `
      <div class="chart-col" title="${w.week}: ${formatEur(w.revenue_cents)} · ${w.bookings} boekingen">
        <div class="chart-bar-value">${w.revenue_cents > 0 ? formatEur(w.revenue_cents) : ''}</div>
        <div class="chart-bar" style="height:${Math.max(3, w.revenue_cents / maxRev * 120)}px"></div>
        <div class="chart-label">${w.week.slice(5)}</div>
      </div>
    `).join('');
    // Update chart title
    const titleEl = document.querySelector('#chart-revenue .table-card__title');
    if (titleEl) titleEl.textContent = 'Omzet per week (\u20AC)';
  }

  function renderMonthlyRevenueChart(months, projection) {
    const allValues = months.map(m => m.revenue_cents);
    if (projection && projection.projected_cents > 0) allValues.push(projection.projected_cents);
    const maxRev = Math.max(...allValues, 1);

    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

    const cols = months.map(m => {
      const isCurrent = m.month === currentMonth;
      const height = Math.max(3, m.revenue_cents / maxRev * 120);
      const label = m.month.slice(5); // MM
      const monthNames = ['','Jan','Feb','Mrt','Apr','Mei','Jun','Jul','Aug','Sep','Okt','Nov','Dec'];
      const monthLabel = monthNames[parseInt(label)] || label;

      // Projection overlay for current month
      const projHeight = isCurrent && projection ? Math.max(3, projection.projected_cents / maxRev * 120) : 0;
      const projBar = isCurrent && projHeight > height ? `<div class="chart-bar chart-bar--projected" style="height:${projHeight}px;position:absolute;bottom:0;left:0;right:0;opacity:0.25;background:var(--terra);border-radius:4px 4px 0 0;"></div>` : '';

      return `<div class="chart-col" style="position:relative" title="${m.month}: ${formatEur(m.revenue_cents)}${isCurrent && projection ? ' \u00B7 Prognose: ' + formatEur(projection.projected_cents) : ''}">
        <div class="chart-bar-value">${m.revenue_cents > 0 ? formatEur(m.revenue_cents) : ''}</div>
        <div style="position:relative;display:inline-block;width:100%">
          ${projBar}
          <div class="chart-bar${isCurrent ? ' chart-bar--current' : ''}" style="height:${height}px"></div>
        </div>
        <div class="chart-label">${monthLabel}${isCurrent ? ' \u25B8' : ''}</div>
      </div>`;
    });

    document.getElementById('monthly-chart-columns').innerHTML = cols.join('');
  }

  function renderOccupancy(data) {
    const el = document.getElementById('occupancy-bars');
    if (!el) return;
    el.innerHTML = data.map(d => {
      const pct = d.total_capacity > 0 ? Math.round(d.booked / d.total_capacity * 100) : 0;
      return `
        <div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
            <span style="font-size:13px;font-weight:600;color:var(--brown)">${d.name}</span>
            <span style="font-size:13px;font-weight:700;color:${pct >= 75 ? '#2E7D32' : pct >= 40 ? '#F57F17' : 'var(--muted)'}">${pct}%</span>
          </div>
          <div style="height:8px;background:var(--border);border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${d.color || 'var(--terra)'};border-radius:4px;transition:width .4s;"></div>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px;">${d.booked} / ${d.total_capacity} plekken · ${d.total_slots} sessies (30 dgn)</div>
        </div>
      `;
    }).join('');
  }

  function renderPeakHeatmap(data) {
    const el = document.getElementById('peak-heatmap');
    if (!el) return;

    const days = ['Zo','Ma','Di','Wo','Do','Vr','Za'];
    const hours = [10,11,12,13,14,15,16,17,18,19,20,21];

    // Build lookup
    const map = {};
    data.forEach(d => { map[`${d.dow}-${d.hour}`] = d.bookings; });
    const maxVal = Math.max(...data.map(d => d.bookings), 1);

    let html = '<div style="overflow-x:auto;"><table style="border-collapse:collapse;font-size:11px;width:100%;">';
    // Header row
    html += '<tr><th style="padding:4px 6px;color:var(--muted);font-weight:600;text-align:left;"></th>';
    hours.forEach(h => {
      html += `<th style="padding:4px 3px;color:var(--muted);font-weight:600;text-align:center;">${h}u</th>`;
    });
    html += '</tr>';

    // Day rows (1=Mon … 6=Sat, 0=Sun → reorder to Mon–Sun)
    [1,2,3,4,5,6,0].forEach(dow => {
      html += `<tr><td style="padding:4px 6px;font-weight:600;color:var(--brown);white-space:nowrap;">${days[dow]}</td>`;
      hours.forEach(h => {
        const val = map[`${dow}-${h}`] || 0;
        const intensity = val / maxVal;
        const bg = val === 0 ? 'var(--white)' : `rgba(217,77,26,${0.12 + intensity * 0.78})`;
        const color = intensity > 0.5 ? '#fff' : 'var(--brown)';
        html += `<td style="padding:5px 3px;text-align:center;background:${bg};color:${color};border-radius:4px;font-weight:${val>0?'700':'400'};">${val > 0 ? val : ''}</td>`;
      });
      html += '</tr>';
    });
    html += '</table></div>';
    el.innerHTML = html;
  }

  function renderRetention(retention, cancellation) {
    const el = document.getElementById('retention-bars');
    if (!el) return;

    // Build cancellation map
    const cancelMap = {};
    cancellation.forEach(c => { cancelMap[c.month] = c; });

    el.innerHTML = retention.map(r => {
      const total = r.new_customers + r.returning_customers;
      const newPct = total > 0 ? Math.round(r.new_customers / total * 100) : 0;
      const c = cancelMap[r.month];
      const cancelPct = c && c.total > 0 ? Math.round(c.cancelled / c.total * 100) : 0;
      const monthLabel = new Date(r.month + '-15').toLocaleDateString('nl-NL', { month: 'short', year: '2-digit' });
      return `
        <div style="margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:5px;align-items:center;">
            <span style="font-size:12px;font-weight:700;color:var(--brown);">${monthLabel}</span>
            <span style="font-size:11px;color:var(--muted);">${total} boekingen · ${cancelPct}% geannuleerd</span>
          </div>
          <div style="height:10px;border-radius:5px;overflow:hidden;display:flex;">
            <div style="width:${newPct}%;background:var(--terra);transition:width .4s;" title="Nieuw: ${r.new_customers}"></div>
            <div style="width:${100-newPct}%;background:rgba(217,77,26,0.22);transition:width .4s;" title="Terugkerend: ${r.returning_customers}"></div>
          </div>
          <div style="display:flex;gap:12px;margin-top:4px;">
            <span style="font-size:10px;color:var(--terra);">■ Nieuw: ${r.new_customers}</span>
            <span style="font-size:10px;color:rgba(217,77,26,0.6);">■ Terugkerend: ${r.returning_customers}</span>
          </div>
        </div>
      `;
    }).join('') || '<p style="color:var(--muted);font-size:13px;">Nog geen data.</p>';
  }

  function renderForwardView(slots) {
    const el = document.getElementById('forward-view');
    if (!el) return;
    if (!slots.length) { el.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px;">Geen aankomende sessies.</p>'; return; }

    // Group by date
    const grouped = {};
    slots.forEach(s => { if (!grouped[s.date]) grouped[s.date] = []; grouped[s.date].push(s); });

    el.innerHTML = Object.keys(grouped).map(date => {
      const label = new Date(date + 'T12:00:00').toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
      const rows = grouped[date].map(s => {
        const pct = s.capacity > 0 ? Math.round(s.booked / s.capacity * 100) : 0;
        const fillColor = pct >= 85 ? '#2E7D32' : pct >= 50 ? '#F57F17' : 'var(--terra)';
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);">
            <div style="width:8px;height:8px;border-radius:50%;background:${s.color};flex-shrink:0;"></div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:var(--brown);">${s.session_name}</div>
              <div style="font-size:11px;color:var(--muted);">${s.start_time}–${s.end_time}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:12px;font-weight:700;color:${fillColor};">${pct}%</div>
              <div style="font-size:10px;color:var(--muted);">${s.booked}/${s.capacity}</div>
            </div>
            <div style="width:60px;height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:${fillColor};border-radius:3px;"></div>
            </div>
          </div>`;
      }).join('');
      return `<div style="margin-bottom:14px;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px;">${label}</div>${rows}</div>`;
    }).join('');
  }

  function renderSubscriptions(plans, mrr) {
    const el = document.getElementById('subscription-stats');
    if (!el) return;
    const total = plans.reduce((s, p) => s + p.active_count, 0);
    el.innerHTML = plans.map(p => {
      const isUnlimited = p.credits_per_month === null;
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-size:13px;font-weight:700;color:var(--brown);">${p.plan_name}</div>
            <div style="font-size:11px;color:var(--muted);">${isUnlimited ? 'Onbeperkt' : '4 credits/maand'} · ${formatEur(p.price_cents)}/maand</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:18px;font-weight:700;color:var(--brown);font-family:'Barlow Condensed',Arial,sans-serif;">${p.active_count}</div>
            <div style="font-size:11px;color:var(--muted);">leden</div>
          </div>
        </div>
      `;
    }).join('') + `<div style="padding-top:10px;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:13px;font-weight:700;color:var(--brown);">Totaal (${total} leden)</span>
      <span style="font-size:16px;font-weight:700;color:var(--terra);">${formatEur(mrr)}/maand</span>
    </div>`;
  }

  // ─── Bookings ─────────────────────────────────────────────────────────────
  async function loadBookings() {
    const from   = document.getElementById('filter-from').value;
    const to     = document.getElementById('filter-to').value;
    const status = document.getElementById('filter-status').value;

    let qs = '';
    if (from)   qs += '&from=' + from;
    if (to)     qs += '&to=' + to;
    if (status) qs += '&status=' + status;
    qs = qs ? '?' + qs.slice(1) : '';

    // Update export link
    document.getElementById('export-btn').href = '/api/admin/bookings/export.csv' + qs +
      (adminToken ? (qs ? '&' : '?') + '_token=' + encodeURIComponent(adminToken) : '');

    const bookings = await api('/bookings' + qs);
    const tbody = document.getElementById('bookings-table-body');

    if (!bookings.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:24px">Geen boekingen gevonden.</td></tr>';
      return;
    }

    tbody.innerHTML = bookings.map(b => `
      <tr>
        <td>${b.id}</td>
        <td>
          <div style="font-weight:600">${b.customer_name}</div>
          <div style="font-size:12px;color:var(--muted)">${b.customer_email}</div>
        </td>
        <td>${b.session_name}</td>
        <td>${formatDate(b.date)}</td>
        <td>${b.start_time}–${b.end_time}</td>
        <td>${b.group_size}</td>
        <td>${formatEur(b.total_cents)}</td>
        <td>${statusBadge(b.status)}</td>
        <td>
          ${b.status !== 'cancelled'
            ? `<button class="btn btn--danger btn--sm" onclick="cancelBooking(${b.id})">Annuleren</button>`
            : ''}
        </td>
      </tr>
    `).join('');
  }

  document.getElementById('filter-apply').addEventListener('click', loadBookings);

  window.cancelBooking = function (id) {
    showConfirm(
      'Boeking annuleren',
      'Weet je zeker dat je boeking #' + id + ' wilt annuleren?',
      async () => {
        await api('/bookings/' + id + '/cancel', { method: 'PATCH' });
        loadBookings();
      }
    );
  };

  // ─── Slots ────────────────────────────────────────────────────────────────
  async function loadSlots() {
    const from = document.getElementById('slot-filter-from').value;
    const to   = document.getElementById('slot-filter-to').value;
    let qs = '';
    if (from) qs += '&from=' + from;
    if (to)   qs += '&to=' + to;
    qs = qs ? '?' + qs.slice(1) : '';

    const slots = await api('/slots' + qs);
    const tbody = document.getElementById('slots-table-body');

    if (!slots.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">Geen slots gevonden.</td></tr>';
      return;
    }

    // Fetch waitlist counts in parallel
    const waitlistCounts = {};
    await Promise.all(slots.map(async s => {
      try {
        const list = await api('/waitlist/' + s.id);
        waitlistCounts[s.id] = Array.isArray(list) ? list.length : 0;
      } catch { waitlistCounts[s.id] = 0; }
    }));

    tbody.innerHTML = slots.map(s => {
      const wCount = waitlistCounts[s.id] || 0;
      const wBadge = wCount > 0
        ? `<span title="Op wachtlijst" style="display:inline-flex;align-items:center;gap:3px;background:#FFF3E0;color:#E65100;border-radius:100px;padding:2px 8px;font-size:11px;font-weight:700;margin-left:4px;">⏳ ${wCount}</span>`
        : '';
      return `
      <tr>
        <td>${s.id}</td>
        <td>${s.session_name}</td>
        <td>${formatDate(s.date)}</td>
        <td>${s.start_time}</td>
        <td>${s.end_time}</td>
        <td>${s.max_capacity || s.type_capacity}</td>
        <td>${s.booked}${wBadge}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn--outline btn--sm" onclick="editSlot(${s.id})">Bewerken</button>
          ${s.is_cancelled
            ? '<span style="font-size:12px;color:var(--muted)">Geannuleerd</span>'
            : `<button class="btn btn--danger btn--sm" onclick="cancelSlot(${s.id})">Annuleren</button>`}
        </td>
      </tr>`;
    }).join('');
  }

  document.getElementById('slot-filter-apply').addEventListener('click', loadSlots);

  // ─── Session types ────────────────────────────────────────────────────────
  async function loadSessionTypes() {
    sessionTypes = await api('/session-types');
    const sel = document.getElementById('slot-session-type');
    sel.innerHTML = sessionTypes.map(t =>
      `<option value="${t.id}">${t.name}</option>`
    ).join('');
  }

  // ─── Slot modal ───────────────────────────────────────────────────────────
  document.getElementById('add-slot-btn').addEventListener('click', () => openSlotModal());
  document.getElementById('slot-modal-cancel').addEventListener('click', closeSlotModal);

  function openSlotModal(slot) {
    document.getElementById('slot-modal-title').textContent = slot ? 'Slot bewerken' : 'Slot toevoegen';
    document.getElementById('slot-id').value       = slot ? slot.id : '';
    document.getElementById('slot-date').value     = slot ? slot.date : '';
    document.getElementById('slot-start').value    = slot ? slot.start_time : '';
    document.getElementById('slot-end').value      = slot ? slot.end_time : '';
    document.getElementById('slot-capacity').value = slot && slot.max_capacity ? slot.max_capacity : '';
    document.getElementById('slot-notes').value    = slot ? (slot.notes || '') : '';
    if (slot) document.getElementById('slot-session-type').value = slot.session_type_id;
    document.getElementById('slot-error').textContent = '';
    document.getElementById('slot-modal').classList.add('open');
  }

  function closeSlotModal() {
    document.getElementById('slot-modal').classList.remove('open');
  }

  document.getElementById('slot-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id       = document.getElementById('slot-id').value;
    const body = {
      session_type_id: +document.getElementById('slot-session-type').value,
      date:       document.getElementById('slot-date').value,
      start_time: document.getElementById('slot-start').value,
      end_time:   document.getElementById('slot-end').value,
      max_capacity: document.getElementById('slot-capacity').value || null,
      notes:      document.getElementById('slot-notes').value || null,
    };

    const btn = document.getElementById('slot-modal-submit');
    btn.disabled = true;
    try {
      if (id) {
        await api('/slots/' + id, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await api('/slots', { method: 'POST', body: JSON.stringify(body) });
      }
      closeSlotModal();
      loadSlots();
    } catch (err) {
      document.getElementById('slot-error').textContent = 'Fout bij opslaan.';
    }
    btn.disabled = false;
  });

  window.editSlot = async function (id) {
    const slots = await api('/slots?from=2000-01-01');
    const slot  = slots.find(s => s.id === id);
    if (slot) openSlotModal(slot);
  };

  window.cancelSlot = function (id) {
    showConfirm(
      'Slot annuleren',
      'Weet je zeker dat je slot #' + id + ' wilt annuleren? Alle bijhorende boekingen worden NIET automatisch geannuleerd.',
      async () => {
        await api('/slots/' + id, { method: 'DELETE' });
        loadSlots();
      }
    );
  };

  // ─── Schedule ─────────────────────────────────────────────────────────────
  (function initSchedule() {
    const input = document.getElementById('schedule-date');
    input.value = new Date().toISOString().slice(0, 10);

    document.getElementById('schedule-prev').addEventListener('click', () => {
      const d = new Date(input.value + 'T12:00:00');
      d.setDate(d.getDate() - 1);
      input.value = d.toISOString().slice(0, 10);
      loadSchedule();
    });
    document.getElementById('schedule-next').addEventListener('click', () => {
      const d = new Date(input.value + 'T12:00:00');
      d.setDate(d.getDate() + 1);
      input.value = d.toISOString().slice(0, 10);
      loadSchedule();
    });
    input.addEventListener('change', loadSchedule);
  })();

  async function loadSchedule() {
    const date = document.getElementById('schedule-date').value;
    const slotsEl   = document.getElementById('schedule-slots');
    const summaryEl = document.getElementById('schedule-summary');
    slotsEl.innerHTML = '<div class="loading">Laden…</div>';
    summaryEl.innerHTML = '';

    let rows;
    try {
      rows = await api('/schedule?date=' + date);
    } catch {
      slotsEl.innerHTML = '<p style="color:#C62828">Fout bij laden.</p>';
      return;
    }

    // Group rows by slot_id
    const slotMap = new Map();
    rows.forEach(r => {
      if (!slotMap.has(r.slot_id)) {
        slotMap.set(r.slot_id, {
          slot_id:      r.slot_id,
          session_name: r.session_name,
          color:        r.color,
          start_time:   r.start_time,
          end_time:     r.end_time,
          capacity:     r.capacity,
          bookings: [],
        });
      }
      if (r.booking_id) {
        slotMap.get(r.slot_id).bookings.push({
          id:            r.booking_id,
          customer_name: r.customer_name,
          customer_email:r.customer_email,
          group_size:    r.group_size,
          checked_in:    r.checked_in,
          admin_notes:   r.admin_notes || '',
        });
      }
    });

    const slots = [...slotMap.values()];

    if (!slots.length) {
      slotsEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">Geen sessies gepland op deze dag.</p>';
      return;
    }

    // Summary pills
    const totalPeople  = slots.reduce((s, sl) => s + sl.bookings.reduce((a, b) => a + b.group_size, 0), 0);
    const checkedIn    = slots.reduce((s, sl) => s + sl.bookings.filter(b => b.checked_in).reduce((a, b) => a + b.group_size, 0), 0);
    const totalSlots   = slots.length;
    const [wd, dm]     = new Date(date + 'T12:00:00').toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' }).split(' ').reduce((a, w, i) => { if (i === 0) a[0] = w; else a[1] = (a[1] ? a[1] + ' ' : '') + w; return a; }, ['','']);
    summaryEl.innerHTML = [
      `<div class="schedule-pill"><strong>${wd}</strong> ${dm}</div>`,
      `<div class="schedule-pill"><strong>${totalSlots}</strong> sessie${totalSlots !== 1 ? 's' : ''}</div>`,
      `<div class="schedule-pill"><strong>${totalPeople}</strong> verwacht</div>`,
      `<div class="schedule-pill"><strong>${checkedIn}</strong> ingecheckt</div>`,
    ].join('');

    slotsEl.innerHTML = slots.map(sl => {
      const booked   = sl.bookings.reduce((s, b) => s + b.group_size, 0);
      const pct      = sl.capacity ? Math.min(100, booked / sl.capacity * 100) : 0;
      const isFull   = sl.capacity && booked >= sl.capacity;

      const bookingRows = sl.bookings.length
        ? sl.bookings.map(b => `
            <div class="checkin-row ${b.checked_in ? 'checkin-row--in' : ''}" id="checkin-row-${b.id}">
              <div class="checkin-row__info">
                <div class="checkin-row__name">${b.customer_name}</div>
                <div class="checkin-row__meta">${b.customer_email} · ${b.group_size} ${b.group_size === 1 ? 'persoon' : 'personen'}</div>
                ${b.admin_notes ? `<div class="checkin-row__notes">📝 ${b.admin_notes.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` : ''}
              </div>
              <button class="checkin-btn ${b.checked_in ? 'checkin-btn--in' : ''}"
                      onclick="toggleCheckin(${b.id}, ${!b.checked_in})">
                ${b.checked_in ? '✓ Ingecheckt' : 'Check in'}
              </button>
            </div>
          `).join('')
        : '<div class="slot-empty">Geen boekingen</div>';

      return `
        <div class="slot-card">
          <div class="slot-card__header">
            <div class="slot-card__title">
              <div class="slot-color-dot" style="background:${sl.color}"></div>
              <div>
                <div class="slot-card__name">${sl.session_name}</div>
                <div class="slot-card__time">${sl.start_time} – ${sl.end_time}</div>
              </div>
            </div>
            <div class="slot-capacity-bar">
              <div class="capacity-track">
                <div class="capacity-fill ${isFull ? 'capacity-fill--full' : ''}" style="width:${pct}%"></div>
              </div>
              <span>${booked}${sl.capacity ? ' / ' + sl.capacity : ''} mensen</span>
            </div>
          </div>
          <div class="slot-card__body">${bookingRows}</div>
        </div>
      `;
    }).join('');
  }

  window.toggleCheckin = async function (bookingId, checkedIn) {
    await api('/bookings/' + bookingId + '/checkin', {
      method: 'PATCH',
      body: JSON.stringify({ checked_in: checkedIn }),
    });
    // Update UI without full reload
    const row = document.getElementById('checkin-row-' + bookingId);
    if (row) {
      row.classList.toggle('checkin-row--in', checkedIn);
      const btn = row.querySelector('.checkin-btn');
      btn.classList.toggle('checkin-btn--in', checkedIn);
      btn.textContent = checkedIn ? '✓ Ingecheckt' : 'Check in';
      btn.setAttribute('onclick', `toggleCheckin(${bookingId}, ${!checkedIn})`);
    }
    // Refresh summary counts
    loadSchedule();
  };

  // ─── Customers ────────────────────────────────────────────────────────────
  let allCustomers = [];

  async function loadCustomers() {
    const tbody = document.getElementById('customers-table-body');
    try {
      allCustomers = await api('/customers');
    } catch {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#C62828;padding:24px">Fout bij laden van klanten.</td></tr>';
      return;
    }

    if (!Array.isArray(allCustomers) || !allCustomers.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Geen klanten gevonden.</td></tr>';
      return;
    }

    tbody.innerHTML = allCustomers.map(c => `
      <tr style="cursor:pointer" onclick="openCustomerDetail(${c.id})">
        <td>${c.id}</td>
        <td style="font-weight:600">${c.name}</td>
        <td>${c.email}</td>
        <td>${formatDate(c.created_at ? c.created_at.slice(0, 10) : '')}</td>
        <td>${c.booking_count}</td>
        <td style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:13px">
          ${c.admin_notes ? c.admin_notes : '<em style="opacity:.4">–</em>'}
        </td>
        <td>
          <button class="btn btn--outline btn--sm" onclick="event.stopPropagation();openNotesModal(${c.id})">Notities</button>
        </td>
      </tr>
    `).join('');
  }

  // ─── Customer detail modal ─────────────────────────────────────────────────
  window.openCustomerDetail = async function (id) {
    const c = allCustomers.find(x => x.id === id);
    if (!c) return;

    document.getElementById('customer-modal-name').textContent = c.name;
    const waiverBadge = c.waiver_signed_at
      ? `<span style="background:#E8F5E9;color:#2E7D32;border-radius:100px;padding:2px 8px;font-size:11px;font-weight:700;margin-left:8px;">✓ Waiver</span>`
      : `<span style="background:#FFF3E0;color:#E65100;border-radius:100px;padding:2px 8px;font-size:11px;font-weight:700;margin-left:8px;">⚠ Geen waiver</span>`;
    document.getElementById('customer-modal-meta').innerHTML = c.email + ' · Lid sinds ' + formatDate(c.created_at ? c.created_at.slice(0, 10) : '') + waiverBadge;
    document.getElementById('customer-modal-bookings').innerHTML = '<div class="loading">Laden…</div>';
    document.getElementById('customer-modal').classList.add('open');

    // Wire GDPR delete button
    document.getElementById('customer-modal-delete').onclick = async function () {
      if (!confirm('GDPR: verwijder alle persoonsgegevens van ' + c.name + '? Boekingsgeschiedenis blijft bewaard voor financiële administratie.')) return;
      try {
        await api('/customers/' + c.id, { method: 'DELETE' });
        document.getElementById('customer-modal').classList.remove('open');
        loadCustomers();
      } catch { alert('Verwijderen mislukt.'); }
    };

    // Wire notes button
    document.getElementById('customer-modal-notes-btn').onclick = function () {
      document.getElementById('customer-modal').classList.remove('open');
      openNotesModal(id);
    };

    let bookings;
    try {
      bookings = await api('/customers/' + id);
    } catch {
      document.getElementById('customer-modal-bookings').innerHTML = '<p style="color:#C62828;font-size:13px">Fout bij laden.</p>';
      return;
    }

    if (!bookings.length) {
      document.getElementById('customer-modal-bookings').innerHTML = '<p style="color:var(--muted);font-size:13px">Geen boekingen gevonden.</p>';
      return;
    }

    const statusMap = { confirmed: ['Bevestigd','confirmed'], pending: ['In behandeling','pending'], cancelled: ['Geannuleerd','cancelled'] };

    document.getElementById('customer-modal-bookings').innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 10px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Sessie</th>
            <th style="text-align:left;padding:8px 10px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Datum</th>
            <th style="text-align:left;padding:8px 10px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Tijd</th>
            <th style="text-align:left;padding:8px 10px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Groep</th>
            <th style="text-align:left;padding:8px 10px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Totaal</th>
            <th style="text-align:left;padding:8px 10px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Status</th>
          </tr>
        </thead>
        <tbody>
          ${bookings.map(b => {
            const [label, cls] = statusMap[b.status] || ['–', 'pending'];
            return `<tr>
              <td style="padding:10px 10px;border-bottom:1px solid var(--border)">${b.session_name}</td>
              <td style="padding:10px 10px;border-bottom:1px solid var(--border)">${formatDate(b.date)}</td>
              <td style="padding:10px 10px;border-bottom:1px solid var(--border)">${b.start_time}–${b.end_time}</td>
              <td style="padding:10px 10px;border-bottom:1px solid var(--border)">${b.group_size}</td>
              <td style="padding:10px 10px;border-bottom:1px solid var(--border)">${formatEur(b.total_cents)}</td>
              <td style="padding:10px 10px;border-bottom:1px solid var(--border)"><span class="status-badge status-badge--${cls}">${label}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  };

  document.getElementById('customer-modal-close').addEventListener('click', () => {
    document.getElementById('customer-modal').classList.remove('open');
  });

  // ─── Notes modal ──────────────────────────────────────────────────────────
  window.openNotesModal = function (id) {
    const c = allCustomers.find(x => x.id === id);
    if (!c) return;
    document.getElementById('notes-modal-title').textContent = 'Notities – ' + c.name;
    document.getElementById('notes-user-id').value  = id;
    document.getElementById('notes-textarea').value = c.admin_notes || '';
    document.getElementById('notes-error').textContent = '';
    document.getElementById('notes-modal').classList.add('open');
  };

  document.getElementById('notes-modal-cancel').addEventListener('click', () => {
    document.getElementById('notes-modal').classList.remove('open');
  });

  document.getElementById('notes-modal-save').addEventListener('click', async () => {
    const id    = document.getElementById('notes-user-id').value;
    const notes = document.getElementById('notes-textarea').value.trim() || null;
    const btn   = document.getElementById('notes-modal-save');
    btn.disabled = true;
    try {
      await api('/customers/' + id + '/notes', {
        method: 'PATCH',
        body: JSON.stringify({ notes }),
      });
      document.getElementById('notes-modal').classList.remove('open');
      loadCustomers();
    } catch {
      document.getElementById('notes-error').textContent = 'Fout bij opslaan.';
    }
    btn.disabled = false;
  });

  // ─── Confirm modal ────────────────────────────────────────────────────────
  let confirmCallback = null;
  document.getElementById('confirm-modal-cancel').addEventListener('click', () => {
    document.getElementById('confirm-modal').classList.remove('open');
    confirmCallback = null;
  });
  document.getElementById('confirm-modal-ok').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    document.getElementById('confirm-modal').classList.remove('open');
    confirmCallback = null;
  });

  function showConfirm(title, body, cb) {
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-body').textContent  = body;
    confirmCallback = cb;
    document.getElementById('confirm-modal').classList.add('open');
  }

  // ─── Schedule generator ───────────────────────────────────────────────────

  function loadGenerate() {
    const sel = document.getElementById('gen-session-type');
    sel.innerHTML = sessionTypes.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    // Default date range: tomorrow → 8 weeks from now
    const from = new Date(); from.setDate(from.getDate() + 1);
    const to   = new Date(); to.setDate(to.getDate() + 56);
    document.getElementById('gen-from').value = from.toISOString().slice(0, 10);
    document.getElementById('gen-to').value   = to.toISOString().slice(0, 10);
    document.getElementById('gen-preview').style.display = 'none';
  }

  function buildSlotList() {
    const typeId    = parseInt(document.getElementById('gen-session-type').value);
    const startTime = document.getElementById('gen-start').value;
    const endTime   = document.getElementById('gen-end').value;
    const fromDate  = document.getElementById('gen-from').value;
    const toDate    = document.getElementById('gen-to').value;
    const capacity  = parseInt(document.getElementById('gen-capacity').value) || null;
    const days      = [...document.querySelectorAll('#gen-days input:checked')].map(i => parseInt(i.value));

    if (!typeId || !startTime || !endTime || !fromDate || !toDate || !days.length) return null;
    if (fromDate > toDate) return null;

    const slots = [];
    const cur = new Date(fromDate + 'T12:00:00');
    const end = new Date(toDate   + 'T12:00:00');
    while (cur <= end) {
      const dow = cur.getDay(); // 0=Sun…6=Sat
      if (days.includes(dow)) {
        slots.push({
          session_type_id: typeId,
          date:       cur.toISOString().slice(0, 10),
          start_time: startTime,
          end_time:   endTime,
          max_capacity: capacity,
        });
      }
      cur.setDate(cur.getDate() + 1);
    }
    return slots;
  }

  const DAY_NL = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];

  document.getElementById('gen-preview-btn').addEventListener('click', () => {
    const slots = buildSlotList();
    const resultEl = document.getElementById('gen-result');
    resultEl.textContent = '';
    if (!slots) {
      alert('Vul alle velden in en selecteer minimaal één dag.');
      return;
    }
    if (!slots.length) {
      alert('Geen slots gevonden voor de geselecteerde periode en dagen.');
      return;
    }

    const typeName = document.getElementById('gen-session-type').selectedOptions[0].text;
    document.getElementById('gen-preview-label').textContent = `${slots.length} slots om aan te maken`;
    document.getElementById('gen-preview-body').innerHTML = slots.map(s => {
      const d = new Date(s.date + 'T12:00:00');
      return `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid var(--border)">${s.date}</td>
        <td style="padding:7px 12px;border-bottom:1px solid var(--border)">${DAY_NL[d.getDay()]}</td>
        <td style="padding:7px 12px;border-bottom:1px solid var(--border)">${s.start_time} – ${s.end_time}</td>
        <td style="padding:7px 12px;border-bottom:1px solid var(--border)">${typeName}</td>
      </tr>`;
    }).join('');
    document.getElementById('gen-preview').style.display = 'block';
  });

  document.getElementById('gen-create-btn').addEventListener('click', async () => {
    const slots   = buildSlotList();
    const btn     = document.getElementById('gen-create-btn');
    const resultEl = document.getElementById('gen-result');
    if (!slots?.length) return;

    btn.disabled = true;
    btn.textContent = 'Aanmaken…';
    resultEl.textContent = '';

    try {
      const res = await api('/slots/bulk', {
        method: 'POST',
        body: JSON.stringify({ slots }),
      });
      if (res.error) {
        resultEl.style.color = '#C62828';
        resultEl.textContent = res.error;
      } else {
        resultEl.style.color = '#2E7D32';
        resultEl.textContent = `✓ ${res.created} slots aangemaakt${res.skipped ? `, ${res.skipped} overgeslagen` : ''}.`;
        document.getElementById('gen-preview').style.display = 'none';
      }
    } catch {
      resultEl.style.color = '#C62828';
      resultEl.textContent = 'Fout bij aanmaken.';
    }
    btn.disabled = false;
    btn.textContent = 'Alles aanmaken';
  });

  // ─── Messages ─────────────────────────────────────────────────────────────

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  async function refreshUnreadBadge() {
    try {
      const data = await api('/messages/unread-count');
      const badge = document.getElementById('unread-badge');
      if (data.count > 0) { badge.textContent = data.count; badge.style.display = ''; }
      else badge.style.display = 'none';
    } catch {}
  }

  async function loadMessages() {
    const container = document.getElementById('messages-inbox');
    container.innerHTML = '<div class="loading">Laden…</div>';
    await refreshUnreadBadge();

    const msgs = await api('/messages');

    if (!msgs.length) {
      container.innerHTML = '<p style="color:var(--muted);padding:24px;">Geen berichten.</p>';
      return;
    }

    container.innerHTML = msgs.map(m => {
      const replies = (m.replies || []).map(r => `
        <div class="msg-bubble msg-bubble--${r.from_admin ? 'admin' : 'customer'}">
          <div class="msg-bubble__from" style="color:${r.from_admin ? 'var(--terra)' : 'var(--muted)'}">
            ${r.from_admin ? 'Soki team' : escapeHtml(m.user_name)} · ${fmtDateTime(r.created_at)}
          </div>
          ${escapeHtml(r.body)}
        </div>
      `).join('');

      return `
        <div class="msg-thread ${m.is_read ? '' : 'msg-thread--unread'}" id="msg-${m.id}">
          <div class="msg-thread__header" onclick="toggleMsg(${m.id})">
            <div>
              <div class="msg-thread__subject">${escapeHtml(m.subject)}</div>
              <div class="msg-thread__meta">${escapeHtml(m.user_name)} (${escapeHtml(m.user_email)}) · ${fmtDateTime(m.created_at)}${m.is_read ? '' : ' · <strong style="color:var(--terra)">Ongelezen</strong>'}</div>
            </div>
            <span style="color:var(--muted);font-size:18px;" id="msg-chevron-${m.id}">▼</span>
          </div>
          <div class="msg-thread__body" id="msg-body-${m.id}" style="display:none">
            <div class="msg-thread__text">${escapeHtml(m.body)}</div>
            ${replies}
            <div class="msg-reply-form">
              <textarea id="msg-reply-text-${m.id}" placeholder="Schrijf een antwoord…"></textarea>
              <button class="btn btn--primary btn--sm" onclick="sendReply(${m.id})" style="align-self:flex-end">Sturen</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  window.toggleMsg = async function(id) {
    const body    = document.getElementById('msg-body-' + id);
    const chevron = document.getElementById('msg-chevron-' + id);
    const isOpen  = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    chevron.textContent = isOpen ? '▼' : '▲';
    if (!isOpen) {
      // Mark as read
      const thread = document.getElementById('msg-' + id);
      if (thread.classList.contains('msg-thread--unread')) {
        await api('/messages/' + id + '/read', { method: 'PATCH' });
        thread.classList.remove('msg-thread--unread');
        const meta = thread.querySelector('.msg-thread__meta');
        if (meta) meta.innerHTML = meta.innerHTML.replace(/ · <strong[^<]*<\/strong>/, '');
        refreshUnreadBadge();
      }
    }
  };

  window.sendReply = async function(id) {
    const textarea = document.getElementById('msg-reply-text-' + id);
    const body = textarea.value.trim();
    if (!body) return;
    textarea.disabled = true;
    try {
      await api('/messages/' + id + '/reply', {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      loadMessages(); // Reload to show new reply
    } catch {
      textarea.disabled = false;
    }
  };

  // ─── Staff management ─────────────────────────────────────────────────────

  const PERM_LABELS = {
    perm_revenue:   'Dashboard / Omzet',
    perm_bookings:  'Boekingen',
    perm_slots:     'Tijdslots beheren',
    perm_schedule:  'Rooster & inchecken',
    perm_customers: 'Klanten',
    perm_messages:  'Berichten',
    perm_generate:  'Slots genereren',
  };

  async function loadStaff() {
    const container = document.getElementById('staff-list');
    container.innerHTML = '<div class="loading">Laden…</div>';
    const staff = await api('/staff');
    if (!staff.length) {
      container.innerHTML = '<p style="color:var(--muted);padding:24px;">Nog geen medewerkers aangemaakt.</p>';
      return;
    }
    container.innerHTML = staff.map(s => {
      const perms = Object.keys(PERM_LABELS).filter(k => s[k]).map(k => PERM_LABELS[k]).join(', ') || 'Geen toegang';
      return `
        <div class="table-card" style="margin-bottom:16px;">
          <div class="table-card__header" style="cursor:pointer" onclick="toggleStaffRow(${s.id})">
            <div>
              <strong>${escapeHtml(s.name)}</strong>
              <span style="color:var(--muted);font-size:13px;margin-left:8px;">${escapeHtml(s.email)}</span>
              ${s.is_active ? '' : '<span style="margin-left:8px;font-size:11px;background:#FFEBEE;color:#C62828;padding:2px 8px;border-radius:100px;font-weight:700;">Inactief</span>'}
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:13px;color:var(--muted);">${perms}</span>
              <span style="color:var(--muted);">▼</span>
            </div>
          </div>
          <div id="staff-row-${s.id}" style="display:none;padding:24px;border-top:1px solid var(--border);">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
              ${Object.entries(PERM_LABELS).map(([k, label]) => `
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;">
                  <input type="checkbox" data-staff="${s.id}" data-perm="${k}" ${s[k] ? 'checked' : ''} onchange="saveStaffPerms(${s.id})">
                  ${label}
                </label>
              `).join('')}
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;">
                <input type="checkbox" data-staff="${s.id}" data-perm="is_active" ${s.is_active ? 'checked' : ''} onchange="saveStaffPerms(${s.id})">
                Account actief
              </label>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button class="btn btn--outline btn--sm" onclick="resetStaffPassword(${s.id}, '${escapeHtml(s.name)}')">Wachtwoord resetten</button>
            </div>
            <div id="staff-msg-${s.id}" style="font-size:13px;margin-top:10px;min-height:16px;"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  window.toggleStaffRow = function(id) {
    const row = document.getElementById('staff-row-' + id);
    row.style.display = row.style.display === 'none' ? 'block' : 'none';
  };

  window.saveStaffPerms = async function(id) {
    const fields = { is_active: false };
    Object.keys(PERM_LABELS).forEach(k => { fields[k] = false; });
    document.querySelectorAll(`input[data-staff="${id}"]`).forEach(cb => {
      fields[cb.dataset.perm] = cb.checked;
    });
    const msgEl = document.getElementById('staff-msg-' + id);
    try {
      const res = await api('/staff/' + id, { method: 'PATCH', body: JSON.stringify(fields) });
      if (res.error) { msgEl.style.color = '#C62828'; msgEl.textContent = res.error; }
      else { msgEl.style.color = '#2E7D32'; msgEl.textContent = '✓ Opgeslagen'; setTimeout(() => { msgEl.textContent = ''; }, 2500); }
    } catch { msgEl.style.color = '#C62828'; msgEl.textContent = 'Fout bij opslaan'; }
  };

  window.resetStaffPassword = async function(id, name) {
    const pw = prompt(`Nieuw wachtwoord voor ${name}:`);
    if (!pw || pw.length < 8) { if (pw !== null) alert('Wachtwoord moet minimaal 8 tekens zijn.'); return; }
    const msgEl = document.getElementById('staff-msg-' + id);
    const res = await api('/staff/' + id + '/reset-password', { method: 'POST', body: JSON.stringify({ password: pw }) });
    if (res.error) { msgEl.style.color = '#C62828'; msgEl.textContent = res.error; }
    else { msgEl.style.color = '#2E7D32'; msgEl.textContent = '✓ Wachtwoord bijgewerkt'; setTimeout(() => { msgEl.textContent = ''; }, 3000); }
  };

  document.getElementById('staff-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn    = e.target.querySelector('button[type=submit]');
    const errEl  = document.getElementById('staff-create-err');
    const name   = document.getElementById('staff-name').value.trim();
    const email  = document.getElementById('staff-email').value.trim();
    const pw     = document.getElementById('staff-pw').value;
    errEl.textContent = '';
    if (!name || !email || !pw) { errEl.textContent = 'Vul alle velden in.'; return; }
    if (pw.length < 8) { errEl.textContent = 'Wachtwoord moet minimaal 8 tekens zijn.'; return; }
    btn.disabled = true;
    const res = await api('/staff', { method: 'POST', body: JSON.stringify({ name, email, password: pw }) });
    btn.disabled = false;
    if (res.error) { errEl.textContent = res.error; return; }
    e.target.reset();
    errEl.style.color = '#2E7D32';
    errEl.textContent = '✓ Medewerker aangemaakt';
    loadStaff();
    setTimeout(() => { errEl.textContent = ''; errEl.style.color = ''; }, 3000);
  });

  // Change own password (for staff users)
  const changeOwnPwForm = document.getElementById('change-own-pw-form');
  if (changeOwnPwForm) {
    changeOwnPwForm.addEventListener('submit', async e => {
      e.preventDefault();
      const oldPw  = document.getElementById('own-pw-old').value;
      const newPw  = document.getElementById('own-pw-new').value;
      const errEl  = document.getElementById('own-pw-err');
      errEl.textContent = '';
      if (newPw.length < 8) { errEl.textContent = 'Nieuw wachtwoord moet minimaal 8 tekens zijn.'; return; }
      const res = await api('/staff/change-own-password', { method: 'POST', body: JSON.stringify({ old_password: oldPw, new_password: newPw }) });
      if (res.error) { errEl.style.color = '#C62828'; errEl.textContent = res.error; }
      else { errEl.style.color = '#2E7D32'; errEl.textContent = '✓ Wachtwoord gewijzigd'; e.target.reset(); }
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  if (adminToken) {
    showApp();
    if (isAdminUser) refreshUnreadBadge();
  }

})();
