export default {
  name:  'sessionType',
  title: 'Session Type',
  type:  'document',
  fields: [
    {
      name:  'name',
      title: 'Name',
      type:  'string',
      validation: R => R.required(),
    },
    {
      name:        'slug',
      title:       'Slug',
      type:        'slug',
      options:     { source: 'name' },
      description: 'Used to link this Sanity entry to the booking system. Use: everyday, social, ambient, or aufguss',
    },
    {
      name:  'tagline',
      title: 'Short tagline',
      type:  'string',
      description: 'One-liner shown on cards, e.g. "50 min · €15"',
    },
    {
      name:  'description',
      title: 'Description',
      type:  'text',
      rows:  4,
    },
    {
      name:    'image',
      title:   'Card image',
      type:    'image',
      options: { hotspot: true },
    },
    {
      name:  'order',
      title: 'Display order',
      type:  'number',
      description: '1 = first. Controls the order on the sessions page.',
    },
  ],
  orderings: [{ title: 'Display order', name: 'orderAsc', by: [{ field: 'order', direction: 'asc' }] }],
  preview:   { select: { title: 'name', media: 'image' } },
};
