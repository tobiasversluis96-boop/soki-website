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
      renderMessages();
    });
  }

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
          el.innerHTML = '<p style="color:var(--text-muted,#8C7B6B);font-size:14px;">No messages yet.</p>';
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
    if (!subject) { errEl.textContent = 'Please enter a subject.'; errEl.style.display = 'block'; return; }
    if (!body)    { errEl.textContent = 'Please write a message.'; errEl.style.display = 'block'; return; }

    var btn = document.getElementById('msg-send-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ subject: subject, body: body }),
    }).then(function(r) { return r.json(); }).then(function(res) {
      btn.disabled = false;
      btn.textContent = 'Send message';
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
