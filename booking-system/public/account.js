/**
 * account.js
 * Customer profile page: upcoming & past bookings.
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

  var token = localStorage.getItem('soki_token');

  function api(path) {
    return fetch('/api' + path, {
      headers: { 'Authorization': 'Bearer ' + token },
    }).then(function (r) { return r.json(); });
  }

  function eur(cents) {
    return '€' + (cents / 100).toFixed(2).replace('.', ',');
  }

  function fmtDate(dateStr) {
    var p = dateStr.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(locale(), {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  function personStr(n) {
    return n + ' ' + (n === 1 ? t('booking.person') : t('booking.persons'));
  }

  function statusBadge(status) {
    var map = {
      confirmed: [t('account.status.confirmed'), 'confirmed'],
      pending:   [t('account.status.pending'),   'pending'],
      cancelled: [t('account.status.cancelled'), 'cancelled'],
    };
    var pair = map[status] || ['–', 'pending'];
    return '<span class="booking-status booking-status--' + pair[1] + '">' + pair[0] + '</span>';
  }

  function bookingCard(b, canCancel, isPast) {
    var cancelBtn = canCancel
      ? '<button class="btn btn--sm" style="background:#FFEBEE;color:#C62828;border:none;cursor:pointer;border-radius:100px;padding:6px 14px;font-size:12px;font-weight:700;font-family:inherit;margin-top:8px;" onclick="cancelBooking(' + b.id + ')">' + t('booking.cancel') + '</button>'
      : '';
    var qrBtn = (!isPast && b.status === 'confirmed')
      ? '<button class="btn btn--sm" style="background:rgba(217,77,26,0.08);color:#D94D1A;border:none;cursor:pointer;border-radius:100px;padding:6px 14px;font-size:12px;font-weight:700;font-family:inherit;margin-top:8px;" onclick="showQR(' + b.id + ')">QR</button>'
      : '';
    var bookAgainBtn = isPast && b.session_type_id
      ? '<a href="/booking?type=' + b.session_type_id + '" class="btn btn--sm" style="background:rgba(217,77,26,0.08);color:#D94D1A;border:none;cursor:pointer;border-radius:100px;padding:6px 14px;font-size:12px;font-weight:700;font-family:inherit;margin-top:8px;text-decoration:none;display:inline-block;">' + t('account.book.again') + '</a>'
      : '';
    return '<div class="history-item">' +
      '<div>' +
        '<div class="history-item__name">' + b.session_name + '</div>' +
        '<div class="history-item__meta">' +
          fmtDate(b.date) + ' · ' + b.start_time + '–' + b.end_time +
          ' · ' + personStr(b.group_size) +
        '</div>' +
        statusBadge(b.status) +
        cancelBtn +
        qrBtn +
        bookAgainBtn +
      '</div>' +
      '<div class="history-item__right">' +
        '<div class="history-item__price">' + eur(b.total_cents) + '</div>' +
      '</div>' +
    '</div>';
  }

  function emptyState(msg, showCta) {
    return '<div style="text-align:center;padding:var(--space-xl) var(--space-md);color:var(--text-muted);">' +
      '<p style="margin-bottom:1.5rem;">' + msg + '</p>' +
      (showCta ? '<a href="/booking" class="btn btn--primary">' + t('account.empty.book') + '</a>' : '') +
      '</div>';
  }

  function init() {
    if (!token) {
      document.getElementById('auth-gate').style.display = 'block';
      return;
    }

    api('/auth/me').then(function (user) {
      if (user.error || !user.id) {
        localStorage.removeItem('soki_token');
        document.getElementById('auth-gate').style.display = 'block';
        return;
      }

      document.getElementById('account-app').style.display = 'block';
      document.getElementById('account-name').textContent  = user.name;
      document.getElementById('account-email').textContent = user.email;

      // Update nav with first name
      var navEl = document.getElementById('navAccount');
      if (navEl) { navEl.textContent = user.name.split(' ')[0]; navEl.style.display = ''; }

      api('/bookings').then(function (bookings) {
        var now = new Date().toISOString().slice(0, 10);
        var pending  = bookings.filter(function (b) { return b.status === 'pending' && b.date >= now; });
        var upcoming = bookings.filter(function (b) { return b.date >= now && b.status === 'confirmed'; });
        var past     = bookings.filter(function (b) { return b.date < now || b.status === 'cancelled'; });

        // Pending / awaiting payment
        var pendingSection = document.getElementById('pending-section');
        if (pending.length) {
          pendingSection.style.display = '';
          // Update header with count
          var pendingH2 = pendingSection.querySelector('h2');
          if (pendingH2) pendingH2.textContent = t('pending.h2') + ' (' + pending.length + ')';
          document.getElementById('pending-bookings').innerHTML = pending.map(function(b) {
            var ageMs = b.created_at ? (Date.now() - new Date(b.created_at).getTime()) : 0;
            var expiringSoon = ageMs > 30 * 60 * 1000;
            var expiryBadge = expiringSoon
              ? '<span style="display:inline-block;background:#FFF3E0;color:#E65100;font-size:11px;font-weight:700;padding:2px 8px;border-radius:100px;text-transform:uppercase;letter-spacing:.04em;">Verloopt binnenkort</span>'
              : '';
            return '<div class="history-item" style="border-left:3px solid #F59E0B;padding-left:12px">' +
              '<div>' +
                '<div class="history-item__name">' + b.session_name + '</div>' +
                '<div class="history-item__meta">' +
                  fmtDate(b.date) + ' · ' + b.start_time + '–' + b.end_time +
                  ' · ' + personStr(b.group_size) +
                '</div>' +
                '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
                  statusBadge(b.status) +
                  expiryBadge +
                  '<a href="/booking?resume=' + b.id + '" class="btn btn--sm" style="background:#D94D1A;color:#fff;text-decoration:none;border-radius:100px;padding:8px 18px;font-size:13px;font-weight:700;font-family:inherit;display:inline-block">' + t('pending.cta') + '</a>' +
                '</div>' +
              '</div>' +
              '<div class="history-item__right"><div class="history-item__price">' + eur(b.total_cents) + '</div></div>' +
            '</div>';
          }).join('');
        } else {
          pendingSection.style.display = 'none';
        }

        document.getElementById('upcoming-bookings').innerHTML = upcoming.length
          ? upcoming.map(function(b) {
              var sessionDatetime = new Date(b.date + 'T' + b.start_time + ':00');
              var hoursUntil = (sessionDatetime - Date.now()) / 36e5;
              return bookingCard(b, hoursUntil >= 24);
            }).join('')
          : emptyState(t('account.empty.upcoming'), true);

        document.getElementById('past-bookings').innerHTML = past.length
          ? past.map(function(b) { return bookingCard(b, false, true); }).join('')
          : '<p style="color:var(--text-muted);">' + t('account.empty.past') + '</p>';
      });

      loadSubscription();
      loadWaitlist();
      loadMilestones();
      renderMessages();
    });
  }

  // ─── Waitlist ────────────────────────────────────────────────────────────
  async function loadWaitlist() {
    try {
      const entries = await fetch('/api/waitlist', { headers: { Authorization: 'Bearer ' + token } }).then(function(r) { return r.json(); });
      var section = document.getElementById('waitlist-section');
      var list    = document.getElementById('waitlist-list');
      if (!entries || !entries.length) { section.style.display = 'none'; return; }
      section.style.display = 'block';
      list.innerHTML = entries.map(function(e) {
        var paid    = e.stripe_payment_status === 'paid';
        var claimed = !!e.claimed_booking_id;
        var payBadge = claimed
          ? '<span style="font-size:11px;background:#E8F5E9;color:#2E7D32;padding:2px 8px;border-radius:100px;font-weight:700;">Ingeboekt</span>'
          : paid
            ? '<span style="font-size:11px;background:#E8F5E9;color:#2E7D32;padding:2px 8px;border-radius:100px;font-weight:700;">Betaald</span>'
            : '<span style="font-size:11px;background:#FFF8E1;color:#F57F17;padding:2px 8px;border-radius:100px;font-weight:700;">Betaling in behandeling</span>';
        var leaveBtn = claimed
          ? ''
          : '<button onclick="leaveWaitlist(' + e.time_slot_id + ',' + paid + ')" style="background:none;border:1px solid rgba(0,0,0,0.2);border-radius:100px;padding:4px 12px;font-size:12px;cursor:pointer;">Verlaten</button>';
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid rgba(0,0,0,0.07);">' +
          '<div>' +
            '<div style="font-weight:600;font-size:0.875rem;">' + e.session_name + '</div>' +
            '<div style="font-size:0.8rem;color:var(--text-muted);">' + e.date + ' \u00b7 ' + e.start_time + ' \u2013 ' + e.end_time + '</div>' +
            (e.total_cents ? '<div style="font-size:0.8rem;color:var(--text-muted);">\u20ac' + (e.total_cents / 100).toFixed(2) + ' \u00b7 ' + e.group_size + ' persoon/personen</div>' : '') +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;justify-content:flex-end;">' +
            '<span style="font-size:0.8rem;color:var(--terra);font-weight:700;">#' + e.queue_position + '</span>' +
            payBadge +
            leaveBtn +
          '</div>' +
        '</div>';
      }).join('');
    } catch(e) { /* silent */ }
  }

  window.leaveWaitlist = async function(slotId, isPaid) {
    var msg = isPaid
      ? 'Wachtlijst verlaten? Je betaling wordt teruggestort.'
      : 'Wachtlijst verlaten?';
    if (!confirm(msg)) return;
    const res = await fetch('/api/waitlist/' + slotId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }).then(function(r) { return r.json(); });
    if (res.error) { alert(res.error); return; }
    loadWaitlist();
  };

  // ─── Milestones ──────────────────────────────────────────────────────────

  async function loadMilestones() {
    try {
      var data = await fetch('/api/milestones', {
        headers: { Authorization: 'Bearer ' + token }
      }).then(function(r) { return r.json(); });

      if (data.error) return;

      // Visit count
      var countEl = document.getElementById('milestone-visit-count');
      if (countEl) countEl.textContent = data.total_visits;

      // Progress bar + next label
      var nextLabelEl = document.getElementById('milestone-next-label');
      var barWrap     = document.getElementById('milestone-progress-bar-wrap');
      var bar         = document.getElementById('milestone-progress-bar');

      if (data.next_milestone && nextLabelEl && barWrap && bar) {
        var next = data.next_milestone;
        var milestones = data.milestones || [];
        // Find previous milestone visits (the one just before next)
        var prevVisits = 0;
        for (var i = 0; i < milestones.length; i++) {
          if (milestones[i].visits < next.visits) prevVisits = milestones[i].visits;
        }
        var remaining = next.visits - data.total_visits;
        var lang = (typeof SOKI_LANG !== 'undefined') ? SOKI_LANG : 'en';
        var nextLabel = lang === 'nl'
          ? 'Nog ' + remaining + ' bezoek' + (remaining === 1 ? '' : 'en') + ' tot ' + next.label_nl + ' ' + next.emoji
          : remaining + ' visit' + (remaining === 1 ? '' : 's') + ' to go until ' + next.label_en + ' ' + next.emoji;
        nextLabelEl.textContent = nextLabel;

        var range    = next.visits - prevVisits;
        var progress = data.total_visits - prevVisits;
        var pct      = Math.min(100, Math.max(0, Math.round((progress / range) * 100)));
        barWrap.style.display = 'block';
        bar.style.width       = pct + '%';
      } else if (nextLabelEl) {
        var lang = (typeof SOKI_LANG !== 'undefined') ? SOKI_LANG : 'en';
        nextLabelEl.textContent = lang === 'nl' ? 'Je hebt alle mijlpalen bereikt!' : 'All milestones achieved!';
      }

      // Milestone list
      var listEl = document.getElementById('milestone-list');
      if (!listEl) return;

      var milestones = data.milestones || [];
      var claimed    = data.claimed || [];
      var lang       = (typeof SOKI_LANG !== 'undefined') ? SOKI_LANG : 'en';

      listEl.innerHTML = milestones.map(function(m) {
        var claimedEntry = null;
        for (var i = 0; i < claimed.length; i++) {
          if (claimed[i].milestone === m.visits) { claimedEntry = claimed[i]; break; }
        }

        var isAchieved = !!claimedEntry;
        var isCurrent  = !isAchieved && data.total_visits === m.visits;
        var isNext     = !isAchieved && !isCurrent && data.next_milestone && data.next_milestone.visits === m.visits;
        var isLocked   = !isAchieved && !isCurrent && !isNext;

        var bg, border, opacity;
        if (isAchieved)  { bg = '#F0FAF0'; border = '2px solid #4CAF50'; opacity = '1'; }
        else if (isCurrent){ bg = '#FFF3E0'; border = '2px solid #FF9800'; opacity = '1'; }
        else if (isNext)  { bg = 'rgba(217,77,26,0.04)'; border = '1.5px solid rgba(217,77,26,0.25)'; opacity = '1'; }
        else              { bg = 'rgba(0,0,0,0.02)'; border = '1.5px solid rgba(0,0,0,0.07)'; opacity = '0.55'; }

        var label  = lang === 'nl' ? m.label_nl  : m.label_en;
        var reward = lang === 'nl' ? m.reward_nl : m.reward_en;

        var statusBadgeHtml = '';
        if (isAchieved)  statusBadgeHtml = '<span style="background:#E8F5E9;color:#2E7D32;font-size:11px;font-weight:700;padding:2px 10px;border-radius:100px;text-transform:uppercase;letter-spacing:.04em;">' + t('account.milestones.claimed') + '</span>';
        else if (isCurrent) statusBadgeHtml = '<span style="background:#FFF3E0;color:#E65100;font-size:11px;font-weight:700;padding:2px 10px;border-radius:100px;text-transform:uppercase;letter-spacing:.04em;">' + (lang === 'nl' ? 'Zojuist behaald!' : 'Just achieved!') + '</span>';
        else if (isNext)  statusBadgeHtml = '<span style="background:rgba(217,77,26,0.1);color:#D94D1A;font-size:11px;font-weight:700;padding:2px 10px;border-radius:100px;text-transform:uppercase;letter-spacing:.04em;">' + t('account.milestones.next') + '</span>';
        else              statusBadgeHtml = '<span style="background:rgba(0,0,0,0.05);color:#999;font-size:11px;font-weight:700;padding:2px 10px;border-radius:100px;text-transform:uppercase;letter-spacing:.04em;">' + (m.visits - data.total_visits) + ' ' + t('account.milestones.locked') + '</span>';

        var promoHtml = '';
        if (isAchieved && claimedEntry && claimedEntry.promo_code) {
          promoHtml = '<div style="margin-top:10px;background:#fff;border:1.5px dashed #D94D1A;border-radius:10px;padding:10px 16px;display:inline-block;">' +
            '<span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#999;">' + t('account.milestones.promo') + '</span> ' +
            '<span style="font-size:15px;font-weight:800;letter-spacing:.08em;color:#D94D1A;">' + claimedEntry.promo_code + '</span>' +
            '</div>';
        }

        var achievedDate = '';
        if (isAchieved && claimedEntry.achieved_at) {
          achievedDate = '<div style="font-size:11px;color:#999;margin-top:4px;">' +
            new Date(claimedEntry.achieved_at).toLocaleDateString(lang === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) +
            '</div>';
        }

        return '<div style="display:flex;gap:16px;align-items:flex-start;background:' + bg + ';border:' + border + ';border-radius:16px;padding:18px 20px;margin-bottom:12px;opacity:' + opacity + ';">' +
          '<div style="font-size:2rem;line-height:1;flex-shrink:0;margin-top:2px;">' + m.emoji + '</div>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">' +
              '<span style="font-weight:700;font-size:1rem;color:var(--brown,#4A1C0C);">' + label + '</span>' +
              statusBadgeHtml +
            '</div>' +
            '<div style="font-size:12px;color:var(--text-muted,#8C7B6B);margin-bottom:4px;">' + (lang === 'nl' ? 'bij ' + m.visits + ' bezoeken' : 'at ' + m.visits + ' visits') + '</div>' +
            '<div style="font-size:13px;color:#555;">' + reward + '</div>' +
            achievedDate +
            promoHtml +
          '</div>' +
        '</div>';
      }).join('');

    } catch (e) { /* silent */ }
  }

  // ─── QR Code ────────────────────────────────────────────────────────────
  window.showQR = async function(bookingId) {
    var existingModal = document.getElementById('qr-modal');
    if (existingModal) existingModal.remove();

    var modal = document.createElement('div');
    modal.id = 'qr-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;padding:1rem;';
    modal.innerHTML = '<div style="background:#fff;border-radius:24px;padding:2rem;max-width:320px;width:100%;text-align:center;">' +
      '<h3 style="margin:0 0 0.5rem;">QR-code</h3>' +
      '<p style="font-size:0.875rem;color:var(--text-muted);margin-bottom:1.5rem;">Boekingsnummer <strong>#' + bookingId + '</strong></p>' +
      '<canvas id="qr-canvas"></canvas>' +
      '<p style="font-size:0.8rem;color:var(--text-muted);margin-top:1rem;">Toon dit scherm bij de ingang.</p>' +
      '<button onclick="document.getElementById(\'qr-modal\').remove()" style="margin-top:1.5rem;width:100%;padding:12px;border-radius:100px;border:1.5px solid rgba(74,28,12,0.2);background:none;cursor:pointer;font-weight:600;">Sluiten</button>' +
    '</div>';
    document.body.appendChild(modal);

    // Close on backdrop click
    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.remove();
    });

    try {
      var data = await fetch('/api/bookings/' + bookingId + '/qr', {
        headers: { Authorization: 'Bearer ' + token }
      }).then(function(r) { return r.json(); });
      if (data.url && typeof QRCode !== 'undefined') {
        QRCode.toCanvas(document.getElementById('qr-canvas'), data.url, { width: 200, margin: 2 });
      } else {
        var canvas = document.getElementById('qr-canvas');
        if (canvas) canvas.outerHTML = '<p style="font-size:13px;color:var(--terra);">Boekingsnummer: #' + bookingId + '</p>';
      }
    } catch(e) {
      var canvas = document.getElementById('qr-canvas');
      if (canvas) canvas.outerHTML = '<p style="font-size:13px;color:var(--terra);">Boekingsnummer: #' + bookingId + '</p>';
    }
  };

  // ─── Subscription ──────────────────────────────────────────────────────────

  function loadSubscription() {
    fetch('/api/subscriptions/my', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r) { return r.json(); })
      .then(function(sub) {
        var el = document.getElementById('subscription-section');
        if (!sub) {
          el.innerHTML = '<div style="background:rgba(217,77,26,0.05);border:1.5px solid rgba(217,77,26,0.2);border-radius:16px;padding:24px;text-align:center;">' +
            '<h3 style="font-family:\'Barlow Condensed\',Arial,sans-serif;font-weight:700;text-transform:uppercase;font-size:20px;color:var(--brown,#4A1C0C);margin-bottom:8px;">Become a member</h3>' +
            '<p style="color:var(--text-muted,#8C7B6B);margin-bottom:16px;font-size:14px;">Save with a monthly membership. From \u20ac39/month.</p>' +
            '<a href="/membership" class="btn btn--primary">View memberships</a>' +
            '</div>';
          return;
        }

        var isUnlimited = sub.credits_per_month === null;
        var creditsHtml = isUnlimited
          ? '<span style="color:#2E7D32;font-weight:700;">Unlimited access</span>'
          : '<span style="font-weight:700;font-size:18px;">' + (sub.credits_remaining || 0) + '</span> credits remaining this month';

        var cancelHtml = sub.cancel_at_period_end
          ? '<p style="color:#C62828;font-size:13px;margin-top:8px;">Cancels on ' + new Date(sub.current_period_end).toLocaleDateString() + '</p>'
          : '<button onclick="cancelSubscription()" class="btn btn--sm" style="background:#FFEBEE;color:#C62828;border:none;cursor:pointer;border-radius:100px;padding:6px 14px;font-size:12px;font-weight:700;font-family:inherit;margin-top:8px;">Cancel membership</button>';

        el.innerHTML = '<div style="background:#fff;border:1.5px solid rgba(217,77,26,0.2);border-radius:16px;padding:24px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">' +
            '<div>' +
              '<span style="background:var(--terra,#D94D1A);color:#fff;border-radius:100px;padding:3px 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">' + sub.plan_name + '</span>' +
              '<div style="margin-top:12px;font-size:15px;">' + creditsHtml + '</div>' +
              (!isUnlimited && sub.credits_reset_at ? '<div style="font-size:12px;color:var(--text-muted,#8C7B6B);margin-top:4px;">Resets on ' + new Date(sub.credits_reset_at).toLocaleDateString() + '</div>' : '') +
            '</div>' +
          '</div>' +
          cancelHtml +
          '</div>';
      });
  }

  window.cancelSubscription = function() {
    if (!confirm('Are you sure you want to cancel your membership? You will keep access until the end of the billing period.')) return;
    fetch('/api/subscriptions/cancel', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
    }).then(function(r) { return r.json(); }).then(function(res) {
      if (res.error) { alert(res.error); return; }
      loadSubscription();
    });
  };

  // ─── Messages ─────────────────────────────────────────────────────────────

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderMessages() {
    fetch('/api/messages', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r) { return r.json(); })
      .then(function(msgs) {
        var el = document.getElementById('messages-list');
        if (!msgs.length) {
          el.innerHTML = '<p style="color:var(--text-muted,#8C7B6B);font-size:14px;">' + t('account.messages.empty') + '</p>';
          return;
        }
        el.innerHTML = msgs.map(function(m) {
          var replies = (m.replies || []).map(function(r) {
            return '<div style="margin-top:10px;padding:12px 14px;border-radius:10px;background:' +
              (r.from_admin ? 'rgba(217,77,26,0.06)' : '#F8F4F0') + ';border-left:3px solid ' +
              (r.from_admin ? '#D94D1A' : '#C4A882') + ';">' +
              '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:' +
              (r.from_admin ? '#D94D1A' : '#8C7B6B') + ';margin-bottom:4px;">' +
              (r.from_admin ? 'Soki team' : 'You') + ' · ' + fmtDateTime(r.created_at) + '</div>' +
              '<div style="font-size:14px;white-space:pre-wrap;">' + r.body.replace(/</g,'&lt;') + '</div></div>';
          }).join('');
          return '<div style="background:#fff;border:1px solid var(--border-color,#E8D5BF);border-radius:14px;padding:20px;margin-bottom:12px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">' +
              '<div><div style="font-weight:700;font-size:15px;color:var(--brown,#4A1C0C);">' + m.subject.replace(/</g,'&lt;') + '</div>' +
              '<div style="font-size:12px;color:var(--text-muted,#8C7B6B);margin-top:2px;">' + fmtDateTime(m.created_at) + '</div></div>' +
            '</div>' +
            '<div style="margin-top:10px;font-size:14px;white-space:pre-wrap;">' + m.body.replace(/</g,'&lt;') + '</div>' +
            (replies ? '<div>' + replies + '</div>' : '') +
            '</div>';
        }).join('');
      });
  }

  document.getElementById('msg-send-btn').addEventListener('click', function() {
    var subject = document.getElementById('msg-subject').value.trim();
    var body    = document.getElementById('msg-body').value.trim();
    var errEl   = document.getElementById('msg-error');
    errEl.style.display = 'none';
    if (!subject) { errEl.textContent = t('account.messages.err.subject'); errEl.style.display = 'block'; return; }
    if (!body)    { errEl.textContent = t('account.messages.err.body'); errEl.style.display = 'block'; return; }

    var btn = document.getElementById('msg-send-btn');
    btn.disabled = true;
    btn.textContent = t('account.messages.sending');

    fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ subject: subject, body: body }),
    }).then(function(r) { return r.json(); }).then(function(res) {
      btn.disabled = false;
      btn.textContent = t('account.messages.submit');
      if (res.error) { errEl.textContent = res.error; errEl.style.display = 'block'; return; }
      document.getElementById('msg-subject').value = '';
      document.getElementById('msg-body').value = '';
      renderMessages();
    });
  });

  document.getElementById('logout-btn').addEventListener('click', function () {
    localStorage.removeItem('soki_token');
    window.location.href = '/';
  });

  document.getElementById('export-data-btn').addEventListener('click', async function () {
    const token = localStorage.getItem('soki_token');
    const res = await fetch('/api/auth/me/export', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) { document.getElementById('gdpr-msg').textContent = 'Export failed. Please try again.'; return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'my-soki-data.json'; a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('delete-account-btn').addEventListener('click', async function () {
    const msg = document.getElementById('gdpr-msg');
    if (!confirm('This will permanently delete your personal data. Booking history is retained for financial compliance. Continue?')) return;
    const token = localStorage.getItem('soki_token');
    const res = await fetch('/api/auth/me', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) { msg.textContent = 'Deletion failed. Please contact us at hello@sokisocialsauna.nl'; msg.style.color = '#C62828'; return; }
    localStorage.removeItem('soki_token');
    window.location.href = '/';
  });

  init();

  // Cancel booking
  var cancelConfirmId = null;
  window.cancelBooking = function(id) {
    cancelConfirmId = id;
    document.getElementById('cancel-modal').style.display = 'flex';
  };

  document.getElementById('cancel-modal-no').addEventListener('click', function() {
    document.getElementById('cancel-modal').style.display = 'none';
    cancelConfirmId = null;
  });

  document.getElementById('cancel-modal-yes').addEventListener('click', async function() {
    if (!cancelConfirmId) return;
    var btn = document.getElementById('cancel-modal-yes');
    btn.disabled = true;
    var token = localStorage.getItem('soki_token');
    var res = await fetch('/api/bookings/' + cancelConfirmId + '/cancel', {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token },
    }).then(function(r) { return r.json(); });
    btn.disabled = false;
    document.getElementById('cancel-modal').style.display = 'none';
    cancelConfirmId = null;
    if (res.error) {
      document.getElementById('cancel-error').textContent = res.error;
      document.getElementById('cancel-error').style.display = 'block';
      setTimeout(function() { document.getElementById('cancel-error').style.display = 'none'; }, 5000);
    } else {
      init(); // reload bookings
    }
  });
})();
