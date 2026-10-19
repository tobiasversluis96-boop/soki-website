/**
 * email-check.js
 * Typocheck voor e-mailvelden: suggereert een correctie bij veelgemaakte
 * fouten (gmail.clom, hotmail.con, gmil.com, ...). Puur een klikbare
 * suggestie - nooit blokkerend, want ongebruikelijke domeinen bestaan echt.
 */
(function () {
  var DOMAINS = [
    'gmail.com', 'hotmail.com', 'hotmail.nl', 'hotmail.be', 'outlook.com',
    'live.nl', 'live.com', 'icloud.com', 'yahoo.com', 'ziggo.nl',
    'kpnmail.nl', 'hetnet.nl', 'xs4all.nl', 'planet.nl', 'upcmail.nl',
    'protonmail.com', 'proton.me', 'telenet.be',
  ];
  // Veelvoorkomende TLD-tikfouten (bewust zonder 'co': .co is een echte TLD)
  var TLD_FIXES = { con: 'com', clom: 'com', cmo: 'com', ocm: 'com', comm: 'com', coml: 'com', vom: 'com', nll: 'nl', bl: 'nl' };

  function levenshtein(a, b) {
    var m = a.length, n = b.length, i, j;
    if (!m) return n; if (!n) return m;
    var prev = [], cur = [];
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n];
  }

  function suggestEmailFix(email) {
    var m = String(email || '').trim().toLowerCase().match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
    if (!m) return null;
    var local = m[1], domain = m[2];
    if (DOMAINS.indexOf(domain) !== -1) return null;

    // 1. TLD-tikfout (werkt ook voor onbekende domeinen: bedrijf.clom → bedrijf.com)
    var parts = domain.split('.');
    var tld = parts[parts.length - 1];
    if (TLD_FIXES[tld]) {
      return local + '@' + parts.slice(0, -1).join('.') + '.' + TLD_FIXES[tld];
    }

    // 2. Dicht bij een bekend domein (max 2 toetsaanslagen ernaast)
    var best = null, bestDist = 3;
    for (var i = 0; i < DOMAINS.length; i++) {
      var d = levenshtein(domain, DOMAINS[i]);
      if (d < bestDist) { bestDist = d; best = DOMAINS[i]; }
    }
    if (best && bestDist <= 2) return local + '@' + best;
    return null;
  }

  // Hangt de check aan een e-mailinput: toont onder het veld een klikbare
  // suggestie ("Bedoelde je …?") die het veld corrigeert.
  function attachEmailCheck(input) {
    if (!input || input._emailCheckAttached) return;
    input._emailCheckAttached = true;

    var hint = document.createElement('p');
    hint.style.cssText = 'display:none;margin:0.35rem 0 0;font-size:0.85rem;color:#B3541E;';
    input.insertAdjacentElement('afterend', hint);

    function run() {
      var fix = suggestEmailFix(input.value);
      if (!fix || fix === input.value.trim().toLowerCase()) { hint.style.display = 'none'; return; }
      var isNl = (typeof SOKI_LANG !== 'undefined' ? SOKI_LANG : (localStorage.getItem('soki_lang') || 'nl')) === 'nl';
      hint.innerHTML = (isNl ? '⚠️ Bedoelde je ' : '⚠️ Did you mean ') +
        '<a href="#" style="color:#D94D1A;font-weight:700;text-decoration:underline;">' + fix.replace(/</g, '&lt;') + '</a>?';
      hint.style.display = 'block';
      hint.querySelector('a').addEventListener('click', function (e) {
        e.preventDefault();
        input.value = fix;
        hint.style.display = 'none';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    input.addEventListener('blur', run);
    var deb;
    input.addEventListener('input', function () { clearTimeout(deb); deb = setTimeout(run, 600); });
  }

  window.suggestEmailFix = suggestEmailFix;
  window.attachEmailCheck = attachEmailCheck;
})();
