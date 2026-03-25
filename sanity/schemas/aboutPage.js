export default {
  name:  'aboutPage',
  title: 'About Page',
  type:  'document',
  fields: [
    {
      name:  'heroHeading',
      title: 'Hero — Heading',
      type:  'string',
    },
    {
      name:  'heroLead',
      title: 'Hero — Lead text',
      type:  'text',
      rows:  2,
    },
    {
      name:  'storyHeading',
      title: 'Story — Heading',
      type:  'string',
    },
    {
      name:  'storyParagraphs',
      title: 'Story — Paragraphs',
      type:  'array',
      of:    [{ type: 'text' }],
      description: 'Each item is one paragraph of the origin story.',
    },
    {
      name:    'storyImage',
      title:   'Story — Image',
      type:    'image',
      options: { hotspot: true },
    },
    {
      name:  'teamHeading',
      title: 'Team — Heading',
      type:  'string',
    },
    {
      name:  'team',
      title: 'Team — Members',
      type:  'array',
      of: [{
        type:   'object',
        fields: [
          { name: 'name',  title: 'Name',  type: 'string' },
          { name: 'role',  title: 'Role',  type: 'string' },
          { name: 'bio',   title: 'Bio',   type: 'text', rows: 3 },
          { name: 'photo', title: 'Photo', type: 'image', options: { hotspot: true } },
        ],
        preview: { select: { title: 'name', subtitle: 'role' } },
      }],
    },
  ],
  preview: { prepare: () => ({ title: 'About Page' }) },
};
