/* ============================================
   SOKI — Sauna van de Stad
   main.js — Shared JavaScript
   ============================================ */

/* ===== I18N: language switcher ===== */
var SOKI_LANG = localStorage.getItem('soki_lang') || 'en';

function applyTranslations(lang) {
  var t = SOKI_I18N && SOKI_I18N[lang];
  if (!t) return;

  SOKI_LANG = lang;
  document.documentElement.lang = lang;
  localStorage.setItem('soki_lang', lang);

  // Text content
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    var key = el.getAttribute('data-i18n');
    if (t[key] !== undefined) el.textContent = t[key];
  });

  // HTML content (for elements with inline tags like <em> or <br>)
  document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-html');
    if (t[key] !== undefined) el.innerHTML = t[key];
  });

  // Placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-placeholder');
    if (t[key] !== undefined) el.placeholder = t[key];
  });

  // Toggle button label — shows the OTHER language (what you'll switch to)
  document.querySelectorAll('.lang-toggle').forEach(function(btn) {
    btn.textContent = lang === 'en' ? 'NL' : 'EN';
    btn.setAttribute('aria-label', lang === 'en' ? 'Switch to Dutch' : 'Overschakelen naar Engels');
  });
}

function toggleLang() {
  applyTranslations(SOKI_LANG === 'en' ? 'nl' : 'en');
}

// Apply on page load (after DOM is ready — translations.js must be loaded first)
document.addEventListener('DOMContentLoaded', function() {
  if (typeof SOKI_I18N !== 'undefined') applyTranslations(SOKI_LANG);
});

/* ===== NAV: scroll effect ===== */
const nav = document.getElementById('nav');

function updateNav() {
  if (window.scrollY > 40) {
    nav.classList.add('scrolled');
  } else {
    nav.classList.remove('scrolled');
  }
}

window.addEventListener('scroll', updateNav, { passive: true });
updateNav();


/* ===== NAV: mobile toggle ===== */
const navToggle  = document.getElementById('navToggle');
const navMobile  = document.getElementById('navMobile');

if (navToggle && navMobile) {
  navToggle.addEventListener('click', () => {
    const isOpen = navToggle.classList.toggle('open');
    navMobile.classList.toggle('open', isOpen);
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });

  // Close on link click
  navMobile.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      navToggle.classList.remove('open');
      navMobile.classList.remove('open');
      document.body.style.overflow = '';
    });
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!nav.contains(e.target) && !navMobile.contains(e.target)) {
      navToggle.classList.remove('open');
      navMobile.classList.remove('open');
      document.body.style.overflow = '';
    }
  });
}


/* ===== SESSIONS: filter buttons ===== */
const filterBtns   = document.querySelectorAll('.filter-btn');
const sessionCards = document.querySelectorAll('.session-card[data-type]');

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const filter = btn.dataset.filter;

    // Update active button
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Show/hide cards
    sessionCards.forEach(card => {
      if (filter === 'all') {
        card.style.display = '';
        return;
      }
      const types = card.dataset.type || '';
      card.style.display = types.includes(filter) ? '' : 'none';
    });

    // Show/hide month headers when all cards in that month are hidden
    document.querySelectorAll('.sessions-month').forEach(month => {
      const visible = [...month.querySelectorAll('.session-card')].some(
        c => c.style.display !== 'none'
      );
      month.style.display = visible ? '' : 'none';
    });
  });
});


/* ===== GALLERY: lightbox ===== */
const lightbox      = document.getElementById('lightbox');
const lightboxImg   = document.getElementById('lightboxImg');
const lightboxClose = document.getElementById('lightboxClose');
const galleryItems  = document.querySelectorAll('.gallery-item');

galleryItems.forEach(item => {
  item.addEventListener('click', () => {
    const img = item.querySelector('img');
    if (!img || !lightbox || !lightboxImg) return;
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
  });
});

if (lightboxClose) {
  lightboxClose.addEventListener('click', closeLightbox);
}

if (lightbox) {
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

function closeLightbox() {
  if (!lightbox) return;
  lightbox.classList.remove('open');
  document.body.style.overflow = '';
  setTimeout(() => {
    if (lightboxImg) lightboxImg.src = '';
  }, 300);
}


/* ===== NEWSLETTER: form submit ===== */
function handleSignup(e) {
  e.preventDefault();

  const form        = e.target;
  const formState   = document.getElementById('formState');
  const successState = document.getElementById('successState');

  // In production, replace this with your actual API call or form service
  console.log('Newsletter signup:', {
    name:  form.querySelector('[name="name"], [name="firstname"]')?.value,
    email: form.querySelector('[name="email"]')?.value,
  });

  // Show success state
  if (formState && successState) {
    formState.style.display = 'none';
    successState.classList.add('visible');
  } else {
    // Fallback: simple message for embedded forms
    form.innerHTML = `
      <div style="text-align:center; padding:1rem 0;">
        <div style="font-size:2rem; margin-bottom:0.5rem;">🔥</div>
        <p style="color: var(--white); font-weight:400;">You're in! We'll be in touch soon.</p>
      </div>
    `;
  }
}


/* ===== SCROLL REVEAL: fade-in on scroll ===== */
const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12 }
);

// Add reveal class to elements we want to animate
document.querySelectorAll(
  '.type-card, .session-card, .team-card, .gallery-item, .value-item, .receive-item'
).forEach((el, i) => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(24px)';
  el.style.transition = `opacity 0.55s ease ${i * 0.06}s, transform 0.55s ease ${i * 0.06}s`;
  el.classList.add('reveal-target');
  revealObserver.observe(el);
});

// Add revealed styles
const revealStyle = document.createElement('style');
revealStyle.textContent = `.reveal-target.revealed { opacity: 1 !important; transform: translateY(0) !important; }`;
document.head.appendChild(revealStyle);


/* ===== AUTH: show account link when logged in, login link when not ===== */
(function checkAuth() {
  function showLogin() {
    var el = document.getElementById('navAccount');
    if (el) { el.textContent = 'Log in'; el.href = '/login'; el.style.display = ''; }
    var elMob = document.getElementById('navAccountMobile');
    if (elMob) { elMob.textContent = 'Log in'; elMob.href = '/login'; elMob.style.display = ''; }
  }

  var token = localStorage.getItem('soki_token');
  if (!token) { showLogin(); return; }

  fetch('/api/auth/me', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(function (r) {
    if (!r.ok) throw new Error('unauth');
    return r.json();
  }).then(function (user) {
    if (!user || !user.id) { showLogin(); return; }

    var firstName = user.name.split(' ')[0];

    var el = document.getElementById('navAccount');
    if (el) { el.textContent = firstName; el.style.display = ''; }

    var elMob = document.getElementById('navAccountMobile');
    if (elMob) {
      var navAccLabel = (typeof SOKI_I18N !== 'undefined' && SOKI_I18N[SOKI_LANG || 'en'])
        ? (SOKI_I18N[SOKI_LANG || 'en']['nav.account'] || 'My account')
        : 'My account';
      elMob.textContent = navAccLabel;
      elMob.style.display = '';
    }
  }).catch(function () {
    localStorage.removeItem('soki_token');
    showLogin();
  });
})();


/* ===== UPCOMING SLOTS: dynamic homepage widget ===== */
(function loadUpcomingSlots() {
  var listEl = document.getElementById('upcoming-slots-list');
  if (!listEl) return;

  var MONTH_NL = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];

  function eur(cents) {
    return '€' + (cents / 100).toFixed(2).replace('.', ',');
  }

  function spotsClass(n) {
    if (n <= 0) return 'spots-badge--full';
    if (n <= 3) return 'spots-badge--low';
    return '';
  }

  function spotsLabel(n) {
    var lang = SOKI_LANG || 'en';
    if (n <= 0) return lang === 'nl' ? 'Volgeboekt' : 'Fully booked';
    if (n === 1) return lang === 'nl' ? '1 plek vrij' : '1 spot left';
    return lang === 'nl' ? (n + ' plekken vrij') : (n + ' spots left');
  }

  function buildCard(s) {
    var parts = s.date.split('-').map(Number);
    var day   = parts[2];
    var mon   = MONTH_NL[parts[1] - 1];
    var dots  = spotsLabel(s.spots_left);
    var cls   = spotsClass(s.spots_left);

    return '<div class="session-card">' +
      '<div class="session-card__date">' +
        '<div class="day">' + day + '</div>' +
        '<div class="month">' + mon + '</div>' +
      '</div>' +
      '<div class="session-card__sep"></div>' +
      '<div class="session-card__info">' +
        '<h4>' + s.session_name + '</h4>' +
        '<div class="session-card__meta">' +
          '<span class="time">' + s.start_time + ' – ' + s.end_time + '</span>' +
          '<span class="location">Gietijzerstraat 3, Utrecht</span>' +
        '</div>' +
        '<div class="session-card__meta" style="margin-top:6px;">' +
          '<span class="tag tag--mixed">' + eur(s.price_cents) + ' · ' + s.duration_min + ' min</span>' +
          '<span class="spots-badge ' + cls + '">' + dots + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="session-card__action">' +
        (s.spots_left > 0
          ? '<a href="/booking?slot=' + s.id + '" class="btn btn--outline">' + (SOKI_LANG === 'nl' ? 'Boek nu' : 'Book now') + '</a>'
          : '<span class="btn btn--outline" style="opacity:.45;cursor:default;">' + (SOKI_LANG === 'nl' ? 'Vol' : 'Full') + '</span>') +
      '</div>' +
    '</div>';
  }

  fetch('/api/upcoming-slots?limit=3').then(function (r) { return r.json(); }).then(function (slots) {
    if (!slots || !slots.length) {
      listEl.innerHTML = '<p class="slots-loading">' + (SOKI_LANG === 'nl' ? 'Geen aankomende sessies gevonden.' : 'No upcoming sessions found.') + '</p>';
      return;
    }
    listEl.innerHTML = slots.map(buildCard).join('');

    // Re-run reveal observer on new elements
    listEl.querySelectorAll('.session-card').forEach(function (el, i) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(24px)';
      el.style.transition = 'opacity 0.55s ease ' + (i * 0.08) + 's, transform 0.55s ease ' + (i * 0.08) + 's';
      el.classList.add('reveal-target');
      revealObserver.observe(el);
    });
  }).catch(function () {
    listEl.innerHTML = '<p class="slots-loading">' + (SOKI_LANG === 'nl' ? 'Kan sessies niet laden.' : 'Could not load sessions.') + '</p>';
  });
})();


/* ===== SESSIONS PAGE: auto-link "Book now" buttons ===== */
(function linkBookingButtons() {
  var typeMap = { everyday: 1, social: 2, ambient: 3, aufguss: 4 };

  // Programme list cards (data-type attribute)
  document.querySelectorAll('.session-card[data-type] .session-card__action a').forEach(function (btn) {
    var card = btn.closest('.session-card[data-type]');
    if (!card) return;
    var type = card.dataset.type;
    var id   = typeMap[type];
    if (id) btn.href = '/booking?type=' + id;
  });
})();
