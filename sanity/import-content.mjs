/**
 * import-content.mjs
 * Populates Sanity with the existing website content.
 * Run once: node import-content.mjs
 */

import { createClient } from '@sanity/client';

const client = createClient({
  projectId: 'g6ufx5h9',
  dataset:   'production',
  apiVersion: '2024-01-01',
  useCdn:    false,
  token:     process.env.SANITY_TOKEN, // set via env or paste below
});

// ─── Homepage ────────────────────────────────────────────────────────────────
const homePage = {
  _id:   'homePage',
  _type: 'homePage',

  heroHeading: 'Sweat, relax, connect',
  heroLead:    'SOKI is a new kind of sauna space that fuses wellness with culture, music and community. A warm, inspiring place where wellbeing, creativity and genuine human connection come first.',

  introEyebrow:  'A hidden oasis just beyond the city limits',
  introHeading:  'Reshaping the sauna experience',
  introParagraph1: 'Step inside and leave the noise behind. This is a space to slow down, reconnect with yourself, meet others and break free from everyday constraints.',
  introParagraph2: "Instead of a silent, anonymous spa, we're building a living, breathing venue where you can sweat, relax and also discover art, talks, DJ sets or small performances.",
  introParagraph3: 'Our aim is to offer a true alternative to the usual social spaces like bars and clubs: a warm, inspiring place where wellbeing, creativity and genuine human connection come first.',

  valuesHeading: 'More than a sauna',
  values: [
    { _key: 'v1', icon: '♨️', title: 'Wellness without walls',  body: 'We want to make sauna sessions and cold plunges affordable and accessible to everyone in Utrecht. Not just a luxury, but a shared experience.' },
    { _key: 'v2', icon: '🎵', title: 'Culture & community',     body: "We're building a living, breathing venue, not a silent spa. Expect art, talks, DJ sets and small performances woven into the sauna experience." },
    { _key: 'v3', icon: '🤝', title: 'Real human connection',   body: "In today's digital world, we create space for genuine encounters. An alternative to bars and clubs where you can truly be yourself." },
  ],
};

// ─── Site Settings ────────────────────────────────────────────────────────────
const siteSettings = {
  _id:   'siteSettings',
  _type: 'siteSettings',

  address:      'Europalaan 2B, 3526 KS Utrecht',
  email:        'hello@sokisocialsauna.nl',
  instagram:    'sokisocialsauna',
  footerTagline: 'Social sauna, ice bath & listening space in Utrecht. Wellness, culture and community under one roof.',
  openingHours: [
    'Wed – Thu: 16:00 – 21:00',
    'Fri: 16:00 – 23:00',
    'Sat: 10:00 – 23:00',
    'Sun: 10:00 – 20:00',
    'Mon – Tue: Closed',
  ],
};

// ─── About Page ───────────────────────────────────────────────────────────────
const aboutPage = {
  _id:   'aboutPage',
  _type: 'aboutPage',

  heroHeading: 'We want to turn the sauna into a new form of socialising.',
  heroLead:    'Without loud music and alcohol, but with warmth, atmosphere, soft sounds and real encounters.',

  storyHeading: 'Two friends, one problem.',
  storyParagraphs: [
    "We're Luke and Tobias. We met eight years ago during an internship in the events industry and have been close friends ever since. Luke has a background as a calisthenics trainer and tour manager. Tobias works as a marketing manager with roots in hospitality.",
    "Together we've seen how art, music and human connection can help people thrive. But we've also seen how nightlife so often revolves around alcohol and other substances, leaving people more depleted than when they arrived.",
    "In London, Berlin and Copenhagen, a new generation of sauna spaces is proving there's another way. We wanted to bring that spirit to Utrecht, in our own way. To turn the sauna into a new form of socialising.",
    "We also want to make a positive social impact. Keeping sessions affordable and creating space for groups who don't always feel at home in traditional wellness environments. Our goal: a place where everyone feels welcome.",
  ],

  teamHeading: 'Meet Luke & Tobias',
  team: [
    {
      _key: 'luke',
      name: 'Luke',
      role: 'Co-founder',
      bio:  'Calisthenics trainer and tour manager. Luke brings the physical practice, the sauna ritual expertise and a deep understanding of what it means to bring people together through shared experience.',
    },
    {
      _key: 'tobias',
      name: 'Tobias',
      role: 'Co-founder',
      bio:  'Marketing manager with a background in hospitality. Tobias shapes how SOKI feels: the experience, the story, the warmth. Making sure the space is genuinely welcoming for every person who walks in.',
    },
  ],
};

// ─── Session Types ────────────────────────────────────────────────────────────
const sessionTypes = [
  {
    _id:   'sessionType-everyday',
    _type: 'sessionType',
    order: 1,
    name:  'Everyday Sauna',
    description: '50 minutes of access to our sauna and ice baths, plus unlimited time to unwind in our lounge. A free-flow experience: no fixed programme, just move at your own pace.',
  },
  {
    _id:   'sessionType-social',
    _type: 'sessionType',
    order: 2,
    name:  'Social Sauna',
    description: '1hr 20 minutes of access to our sauna and ice baths, plus unlimited lounge time. Curl up with a book, meditate, catch up with friends or meet someone new.',
  },
  {
    _id:   'sessionType-ambient',
    _type: 'sessionType',
    order: 3,
    name:  'Ambient Sauna',
    description: 'A curated DJ transforms the sauna into an immersive listening lounge. 70 minutes of sauna access, stay for the full 4-hour event with live music from 19:00–23:00.',
  },
  {
    _id:   'sessionType-aufguss',
    _type: 'sessionType',
    order: 4,
    name:  'Aufguss / Opgieting',
    description: 'A traditional sauna ritual led by one of our in-house sauna masters. Essential oils are poured over hot stones to create a burst of steam. Expect a visualisation and a homemade salt scrub.',
  },
];

// ─── Run ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!client.config().token) {
    console.error('❌  No SANITY_TOKEN set. Export it first:\n   export SANITY_TOKEN=sk...');
    process.exit(1);
  }

  const docs = [homePage, siteSettings, aboutPage, ...sessionTypes];

  for (const doc of docs) {
    await client.createOrReplace(doc);
    console.log(`✓  ${doc._type} (${doc._id})`);
  }

  console.log('\n✅  All content imported. Refresh the Sanity Studio to see it.');
}

run().catch(err => { console.error(err); process.exit(1); });
