export default {
  name:  'galleryImage',
  title: 'Gallery Image',
  type:  'document',
  fields: [
    {
      name:    'image',
      title:   'Image',
      type:    'image',
      options: { hotspot: true },
      validation: R => R.required(),
    },
    {
      name:  'caption',
      title: 'Caption',
      type:  'string',
      description: 'Shown on hover over the image.',
    },
    {
      name:  'alt',
      title: 'Alt text',
      type:  'string',
      description: 'Describe the image for accessibility and SEO.',
      validation: R => R.required(),
    },
    {
      name:  'featured',
      title: 'Featured (wide)',
      type:  'boolean',
      description: 'Featured images span two columns in the gallery grid.',
      initialValue: false,
    },
    {
      name:  'order',
      title: 'Display order',
      type:  'number',
      description: 'Lower numbers appear first.',
    },
  ],
  orderings: [{ title: 'Display order', name: 'orderAsc', by: [{ field: 'order', direction: 'asc' }] }],
  preview:   { select: { title: 'caption', media: 'image' } },
};
