export default {
  name:  'siteSettings',
  title: 'Site Settings',
  type:  'document',
  fields: [
    {
      name: 'address', title: 'Address', type: 'string',
      description: 'E.g. Europalaan 2B, 3526 KS Utrecht',
    },
    {
      name:  'email',
      title: 'Contact email',
      type:  'string',
    },
    {
      name:  'instagram',
      title: 'Instagram handle',
      type:  'string',
      description: 'Without the @ symbol',
    },
    {
      name:  'openingHours',
      title: 'Opening hours',
      type:  'array',
      of:    [{ type: 'string' }],
      description: 'One line per entry, e.g. "Wed–Thu: 16:00–22:00"',
    },
    {
      name:  'footerTagline',
      title: 'Footer tagline',
      type:  'string',
    },
  ],
  preview: { select: { title: 'email' } },
};
