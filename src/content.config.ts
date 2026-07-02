import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const guides = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    published: z.date(),
    updated: z.date(),
    status: z.enum(['live', 'under-observation']),
  }),
});

const locations = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/locations' }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    guide: z.string(),
    thresholdType: z.enum([
      'stair-descent',
      'trail-entrance',
      'bridge',
      'underpass',
      'park-edge',
      'path-ending',
      'slope-overlook',
    ]),
    thresholdLabel: z.string(),
    order: z.number(),
    lat: z.number(),
    lng: z.number(),
    neighbourhood: z.string(),
    landscapeSystem: z.string(),
    preview: z.string(),
    sources: z.array(
      z.object({
        label: z.string(),
        url: z.string(),
      })
    ),
  }),
});

export const collections = { guides, locations };
