/* ============================================================
   SOKI · Cookie consent + tracker loader
   ------------------------------------------------------------
   - Shows a bottom-sheet consent banner on first visit.
   - Stores {analytics, marketing, timestamp, version} in
     localStorage under 'soki_consent'.
   - Consent Mode v2 defaults are set to DENIED before any
     tracker loads. When the user grants consent we call
     gtag('consent','update', …).
   - Trackers only load when their category is granted.
   - IDs are pulled from /api/config; empty = tool disabled.
   - Exposes window.SOKI_CONSENT with getState(), update(),
     reopen(), version.
   ============================================================ */

(function () {
  'use strict';

  var STORAGE_KEY = 'soki_consent';
  var VERSION = 1; // Bump when tools change → banner reappears

  // --- Google Consent Mode v2 defaults (must run before any tracker) ---
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('consent', 'default', {
    ad_storage: 'denied',
    analytics_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted',
    wait_for_update: 500,
  });

  // --- State helpers ---
  function getState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s.version !== VERSION) return null; // Forces re-consent on version bump
      return s;
    } catch (e) { return null; }
  }

  function saveState(analytics, marketing) {
    var state = {
      version: VERSION,
      analytics: !!analytics,
      marketing: !!marketing,
      timestamp: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    applyConsent(state);
    return state;
  }

  // --- Apply consent: update Consent Mode + load / hold trackers ---
  function applyConsent(state) {
    gtag('consent', 'update', {
      analytics_storage:  state.analytics ? 'granted' : 'denied',
      ad_storage:         state.marketing ? 'granted' : 'denied',
      ad_user_data:       state.marketing ? 'granted' : 'denied',
      ad_personalization: state.marketing ? 'granted' : 'denied',
    });
    if (state.analytics) loadGA4();
    if (state.marketing) { loadMetaPixel(); loadTikTokPixel(); }
    document.dispatchEvent(new CustomEvent('soki:consent-change', { detail: state }));
  }

  // --- Config fetch (cached) ---
  var configPromise = null;
  function getConfig() {
    if (configPromise) return configPromise;
    configPromise = fetch('/api/config').then(function (r) { return r.json(); }).catch(function () { return {}; });
    return configPromise;
  }

  // --- Tracker: Google Analytics 4 ---
  var ga4Loaded = false;
  function loadGA4() {
    if (ga4Loaded) return;
    getConfig().then(function (cfg) {
      var id = cfg.ga4MeasurementId;
      if (!id) return; // ID not set → tool disabled
      ga4Loaded = true;
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
      document.head.appendChild(s);
      gtag('js', new Date());
      gtag('config', id, { anonymize_ip: true, allow_google_signals: false });
    });
  }

  // --- Tracker: Meta (Facebook) Pixel ---
  var metaLoaded = false;
  function loadMetaPixel() {
    if (metaLoaded) return;
    getConfig().then(function (cfg) {
      var id = cfg.metaPixelId;
      if (!id) return;
      metaLoaded = true;
      /* eslint-disable */
      !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
      /* eslint-enable */
      window.fbq('init', id);
      window.fbq('track', 'PageView');
    });
  }

  // --- Tracker: TikTok Pixel ---
  var tiktokLoaded = false;
  function loadTikTokPixel() {
    if (tiktokLoaded) return;
    getConfig().then(function (cfg) {
      var id = cfg.tiktokPixelId;
      if (!id) return;
      tiktokLoaded = true;
      /* eslint-disable */
      !function (w, d, t) {
        w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || [];
        ttq.methods = ["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];
        ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
        for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
        ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; };
        ttq.load = function (e, n) {
          var r = "https://analytics.tiktok.com/i18n/pixel/events.js"; var o = n && n.partner;
          ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r; ttq._t = ttq._t || {}; ttq._t[e] = +new Date; ttq._o = ttq._o || {}; ttq._o[e] = n || {};
          n = document.createElement("script"); n.type = "text/javascript"; n.async = !0; n.src = r + "?sdkid=" + e + "&lib=" + t;
          e = document.getElementsByTagName("script")[0]; e.parentNode.insertBefore(n, e);
        };
        ttq.load(id);
        ttq.page();
      }(window, document, 'ttq');
      /* eslint-enable */
    });
  }

  // --- Banner UI ---
  function bannerHTML() {
    var isNL = (localStorage.getItem('soki_lang') || 'en') === 'nl';
    var t = {
      title:    isNL ? 'Cookies bij SOKI'                                     : 'Cookies at SOKI',
      body:     isNL ? 'We gebruiken functionele cookies om de site en boekingen te laten werken. Met jouw toestemming meten we bezoek (analytics) en tonen we relevante advertenties (marketing).'
                     : 'We use functional cookies to run the site and bookings. With your consent we measure visits (analytics) and show relevant ads (marketing).',
      accept:   isNL ? 'Alles accepteren'  : 'Accept all',
      reject:   isNL ? 'Alleen noodzakelijk' : 'Only necessary',
      custom:   isNL ? 'Aanpassen'         : 'Customise',
      analytics_label: isNL ? 'Analytics' : 'Analytics',
      analytics_desc:  isNL ? 'Anoniem bezoek meten (Google Analytics 4).' : 'Anonymous visit measurement (Google Analytics 4).',
      marketing_label: isNL ? 'Marketing' : 'Marketing',
      marketing_desc:  isNL ? 'Advertentie-attributie (Meta Pixel, TikTok Pixel).' : 'Ad attribution (Meta Pixel, TikTok Pixel).',
      save:     isNL ? 'Voorkeuren opslaan' : 'Save preferences',
      more:     isNL ? 'Meer info in ons cookiebeleid' : 'More in our cookie policy',
    };
    return '' +
      '<div id="soki-consent" role="dialog" aria-label="' + t.title + '" style="position:fixed;bottom:16px;left:16px;right:16px;max-width:520px;margin-inline:auto;background:#fff;border-radius:20px;box-shadow:0 12px 40px rgba(0,0,0,0.18);padding:22px 22px 18px;font-family:inherit;z-index:2147483647;color:#4A1C0C;">' +
        '<div style="font-weight:700;font-size:15px;margin-bottom:6px;">' + t.title + '</div>' +
        '<p style="font-size:13px;line-height:1.5;color:#6B5548;margin:0 0 14px;">' + t.body + ' <a href="/cookies" style="color:#D94D1A;">' + t.more + '</a>.</p>' +
        '<div id="soki-consent-cats" style="display:none;margin-bottom:14px;font-size:13px;">' +
          '<label style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-top:1px solid rgba(0,0,0,.06);"><input type="checkbox" checked disabled style="margin-top:3px;"><span><strong>' + (isNL ? 'Noodzakelijk' : 'Necessary') + '</strong><br><span style="color:#6B5548;font-size:12px;">' + (isNL ? 'Nodig voor inloggen en boeken. Altijd aan.' : 'Required for login and bookings. Always on.') + '</span></span></label>' +
          '<label style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-top:1px solid rgba(0,0,0,.06);cursor:pointer;"><input type="checkbox" id="soki-consent-analytics" style="margin-top:3px;"><span><strong>' + t.analytics_label + '</strong><br><span style="color:#6B5548;font-size:12px;">' + t.analytics_desc + '</span></span></label>' +
          '<label style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-top:1px solid rgba(0,0,0,.06);cursor:pointer;"><input type="checkbox" id="soki-consent-marketing" style="margin-top:3px;"><span><strong>' + t.marketing_label + '</strong><br><span style="color:#6B5548;font-size:12px;">' + t.marketing_desc + '</span></span></label>' +
        '</div>' +
        '<div id="soki-consent-actions" style="display:flex;flex-wrap:wrap;gap:8px;">' +
          '<button type="button" id="soki-consent-reject" style="flex:1;min-width:120px;padding:11px 14px;border:1.5px solid rgba(74,28,12,.2);background:#fff;color:#4A1C0C;border-radius:100px;font-family:inherit;font-weight:600;font-size:13px;cursor:pointer;">' + t.reject + '</button>' +
          '<button type="button" id="soki-consent-custom" style="flex:1;min-width:110px;padding:11px 14px;border:1.5px solid rgba(74,28,12,.2);background:#fff;color:#4A1C0C;border-radius:100px;font-family:inherit;font-weight:600;font-size:13px;cursor:pointer;">' + t.custom + '</button>' +
          '<button type="button" id="soki-consent-accept" style="flex:1;min-width:130px;padding:11px 14px;border:none;background:#D94D1A;color:#fff;border-radius:100px;font-family:inherit;font-weight:700;font-size:13px;cursor:pointer;">' + t.accept + '</button>' +
        '</div>' +
        '<button type="button" id="soki-consent-save" style="display:none;width:100%;margin-top:10px;padding:11px 14px;border:none;background:#D94D1A;color:#fff;border-radius:100px;font-family:inherit;font-weight:700;font-size:13px;cursor:pointer;">' + t.save + '</button>' +
      '</div>';
  }

  function showBanner() {
    if (document.getElementById('soki-consent')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = bannerHTML();
    document.body.appendChild(wrap.firstChild);
    document.getElementById('soki-consent-accept').addEventListener('click', function () { saveState(true, true); hideBanner(); });
    document.getElementById('soki-consent-reject').addEventListener('click', function () { saveState(false, false); hideBanner(); });
    document.getElementById('soki-consent-custom').addEventListener('click', function () {
      document.getElementById('soki-consent-cats').style.display = 'block';
      document.getElementById('soki-consent-actions').style.display = 'none';
      document.getElementById('soki-consent-save').style.display = 'block';
    });
    document.getElementById('soki-consent-save').addEventListener('click', function () {
      var a = document.getElementById('soki-consent-analytics').checked;
      var m = document.getElementById('soki-consent-marketing').checked;
      saveState(a, m);
      hideBanner();
    });
  }

  function hideBanner() {
    var el = document.getElementById('soki-consent');
    if (el) el.remove();
  }

  // --- Public API ---
  window.SOKI_CONSENT = {
    version: VERSION,
    getState: getState,
    update: function (analytics, marketing) { return saveState(analytics, marketing); },
    reopen: function () { hideBanner(); showBanner(); },
  };

  // --- Init ---
  function init() {
    var state = getState();
    if (state) {
      applyConsent(state);
    } else {
      showBanner();
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
