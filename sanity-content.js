/* ============================================================
   sanity-content.js — Soki website
   Fetches content from Sanity CDN and updates the DOM.
   Falls back silently to static HTML if Sanity is unreachable
   or not yet configured.
   ============================================================ */

var SANITY_PROJECT_ID = 'g6ufx5h9';
var SANITY_DATASET    = 'production';
var SANITY_API_VER    = '2024-01-01';

async function loadSanityConfig() {
  try {
    var res = await fetch('/api/config');
    if (!res.ok) throw new Error('Config fetch failed: ' + res.status);
    var config = await res.json();
    if (config.sanityProjectId) SANITY_PROJECT_ID = config.sanityProjectId;
    if (config.sanityDataset)   SANITY_DATASET    = config.sanityDataset;
  } catch (e) {
    console.debug('[Sanity] Could not load /api/config:', e.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanityImageUrl(ref) {
  if (!ref) return null;
  // ref format: image-XXXX-WxH-ext
  var parts = ref.replace('image-', '').split('-');
  var ext   = parts.pop();
  var id    = parts.join('-');
  return 'https://cdn.sanity.io/images/' + SANITY_PROJECT_ID + '/' + SANITY_DATASET + '/' + id + '.' + ext;
}

function setText(selector, value) {
  if (!value) return;
  document.querySelectorAll(selector).forEach(function(el) { el.textContent = value; });
}

function setAttr(selector, attr, value) {
  if (!value) return;
  document.querySelectorAll(selector).forEach(function(el) { el.setAttribute(attr, value); });
}

async function fetchSanity(groq) {
  var url = 'https://' + SANITY_PROJECT_ID + '.api.sanity.io/v' + SANITY_API_VER +
            '/data/query/' + SANITY_DATASET + '?query=' + encodeURIComponent(groq);
  var res = await fetch(url);
  if (!res.ok) throw new Error('Sanity fetch failed: ' + res.status);
  var json = await res.json();
  return json.result;
}

// ─── Apply content per page ───────────────────────────────────────────────────

async function applyHomePage(data) {
  if (!data) return;

  // Hero
  if (data.heroImage && data.heroImage.asset) {
    var heroUrl = sanityImageUrl(data.heroImage.asset._ref);
    if (heroUrl) setAttr('.hero__bg img', 'src', heroUrl);
  }
  setText('[data-i18n="home.hero.h1"]',     data.heroHeading);
  setText('[data-i18n="home.hero.lead"]',   data.heroLead);

  // Intro
  setText('[data-i18n="home.intro.eyebrow"]', data.introEyebrow);
  setText('[data-i18n="home.intro.h2"]',      data.introHeading);
  setText('[data-i18n="home.intro.p1"]',      data.introParagraph1);
  setText('[data-i18n="home.intro.p2"]',      data.introParagraph2);
  setText('[data-i18n="home.intro.p3"]',      data.introParagraph3);

  if (data.introImage && data.introImage.asset) {
    var introUrl = sanityImageUrl(data.introImage.asset._ref);
    if (introUrl) setAttr('.intro-grid__image img', 'src', introUrl);
  }

  // Values
  setText('[data-i18n="home.values.h2"]', data.valuesHeading);
  if (data.values && data.values.length) {
    var items = document.querySelectorAll('.value-item');
    data.values.forEach(function(v, i) {
      if (!items[i]) return;
      var icon = items[i].querySelector('.value-item__icon');
      var h4   = items[i].querySelector('h4');
      var p    = items[i].querySelector('p');
      if (icon && v.icon)  icon.textContent = v.icon;
      if (h4   && v.title) h4.textContent   = v.title;
      if (p    && v.body)  p.textContent    = v.body;
    });
  }
}

async function applySessionTypes(types) {
  if (!types || !types.length) return;

  // Homepage type cards (.type-card)
  var cards = document.querySelectorAll('.type-card');
  cards.forEach(function(card) {
    var h3 = card.querySelector('h3');
    if (!h3) return;
    var match = types.find(function(t) {
      return h3.textContent.trim().toLowerCase().includes(t.name.toLowerCase().split(' ')[0].toLowerCase());
    });
    if (!match) return;
    var p = card.querySelector('p');
    if (p && match.description) p.textContent = match.description;
    if (match.image && match.image.asset) {
      var img = card.querySelector('img');
      var url = sanityImageUrl(match.image.asset._ref);
      if (img && url) img.src = url;
    }
  });

  // Sessions page type cards (.session-type-card)
  var sessionCards = document.querySelectorAll('.session-type-card');
  sessionCards.forEach(function(card) {
    var h3 = card.querySelector('h3');
    if (!h3) return;
    var match = types.find(function(t) {
      return h3.textContent.trim().toLowerCase().includes(t.name.toLowerCase().split(' ')[0].toLowerCase());
    });
    if (!match) return;
    var paras = card.querySelectorAll('.session-type-card__text p');
    if (match.description) {
      paras.forEach(function(p) { p.textContent = match.description; });
    }
    if (match.image && match.image.asset) {
      var img = card.querySelector('img');
      var url = sanityImageUrl(match.image.asset._ref);
      if (img && url) img.src = url;
    }
  });
}

async function applyGallery(images) {
  if (!images || !images.length) return;
  var grid = document.querySelector('.gallery-grid');
  if (!grid) return;

  grid.innerHTML = images.map(function(img) {
    var url  = sanityImageUrl(img.image.asset._ref);
    var wide = img.featured ? ' gallery-item--wide' : '';
    return '<div class="gallery-item' + wide + '" data-caption="' + (img.caption || '') + '">' +
      '<img src="' + url + '" alt="' + (img.alt || '') + '" loading="lazy" />' +
      '<div class="gallery-item__overlay"><span>' + (img.caption || '') + '</span></div>' +
    '</div>';
  }).join('');

  // Re-attach lightbox listeners (defined in main.js)
  if (typeof window.initGalleryLightbox === 'function') window.initGalleryLightbox();
}

async function applySiteSettings(settings) {
  if (!settings) return;
  if (settings.email) {
    document.querySelectorAll('a[href^="mailto:"]').forEach(function(a) {
      a.href        = 'mailto:' + settings.email;
      a.textContent = settings.email;
    });
  }
  if (settings.openingHours && settings.openingHours.length) {
    var hourEls = document.querySelectorAll('.footer__col ul li');
    // Only update hour-looking entries (contain colon + time)
    var hourItems = Array.from(hourEls).filter(function(li) {
      return li.textContent.match(/\d{2}:\d{2}/);
    });
    settings.openingHours.forEach(function(line, i) {
      if (hourItems[i]) hourItems[i].textContent = line;
    });
  }
  if (settings.footerTagline) {
    document.querySelectorAll('.footer__brand p').forEach(function(p) {
      p.textContent = settings.footerTagline;
    });
  }
}

async function applyAboutPage(data) {
  if (!data) return;
  if (data.heroHeading) setText('.page-hero h1', data.heroHeading);
  if (data.heroLead)    setText('.page-hero .lead', data.heroLead);
  if (data.storyHeading) setText('[data-i18n="about.story.h2"]', data.storyHeading);
  if (data.storyParagraphs && data.storyParagraphs.length) {
    var paras = document.querySelectorAll('.about-story p');
    data.storyParagraphs.forEach(function(text, i) {
      if (paras[i]) paras[i].textContent = text;
    });
  }
  if (data.storyImage && data.storyImage.asset) {
    var url = sanityImageUrl(data.storyImage.asset._ref);
    if (url) setAttr('.about-story img', 'src', url);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async function loadContent() {
  await loadSanityConfig();

  if (!SANITY_PROJECT_ID) return;

  try {
    var result = await fetchSanity(`{
      "home":      *[_type == "homePage"][0]   { heroHeading, heroLead, heroImage, introEyebrow, introHeading, introParagraph1, introParagraph2, introParagraph3, introImage, valuesHeading, values },
      "sessions":  *[_type == "sessionType"] | order(order asc) { name, description, image },
      "gallery":   *[_type == "galleryImage"] | order(order asc) { image, caption, alt, featured },
      "settings":  *[_type == "siteSettings"][0] { email, openingHours, footerTagline },
      "about":     *[_type == "aboutPage"][0]  { heroHeading, heroLead, storyHeading, storyParagraphs, storyImage }
    }`);

    if (!result) return;

    await applyHomePage(result.home);
    await applySessionTypes(result.sessions);
    await applyGallery(result.gallery);
    await applySiteSettings(result.settings);
    await applyAboutPage(result.about);

  } catch (e) {
    // Fail silently — static content remains visible
    console.debug('[Sanity] Could not load content:', e.message);
  }
})();
