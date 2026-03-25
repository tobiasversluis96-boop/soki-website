export default {
  name:  'homePage',
  title: 'Homepage',
  type:  'document',
  fields: [
    // ── Hero ─────────────────────────────────────────────────────────────────
    {
      name:  'heroHeading',
      title: 'Hero — Heading',
      type:  'string',
      description: 'Large heading on the hero image. E.g. "Sweat, relax, connect"',
    },
    {
      name:  'heroLead',
      title: 'Hero — Lead text',
      type:  'text',
      rows:  3,
    },
    {
      name:    'heroImage',
      title:   'Hero — Background image',
      type:    'image',
      options: { hotspot: true },
    },

    // ── Intro ─────────────────────────────────────────────────────────────────
    {
      name:  'introEyebrow',
      title: 'Intro — Eyebrow text',
      type:  'string',
    },
    {
      name:  'introHeading',
      title: 'Intro — Heading',
      type:  'string',
    },
    {
      name:  'introParagraph1',
      title: 'Intro — Paragraph 1',
      type:  'text',
      rows:  3,
    },
    {
      name:  'introParagraph2',
      title: 'Intro — Paragraph 2',
      type:  'text',
      rows:  3,
    },
    {
      name:  'introParagraph3',
      title: 'Intro — Paragraph 3',
      type:  'text',
      rows:  3,
    },
    {
      name:    'introImage',
      title:   'Intro — Image',
      type:    'image',
      options: { hotspot: true },
    },

    // ── Values ────────────────────────────────────────────────────────────────
    {
      name:  'valuesHeading',
      title: 'Values — Heading',
      type:  'string',
    },
    {
      name:  'values',
      title: 'Values — Items',
      type:  'array',
      of: [{
        type:   'object',
        fields: [
          { name: 'icon',  title: 'Emoji icon', type: 'string' },
          { name: 'title', title: 'Title',      type: 'string' },
          { name: 'body',  title: 'Body text',  type: 'text', rows: 2 },
        ],
        preview: { select: { title: 'title', subtitle: 'icon' } },
      }],
    },
  ],
  preview: { prepare: () => ({ title: 'Homepage' }) },
};
