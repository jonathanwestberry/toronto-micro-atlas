import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const guides = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    published: z.coerce.date(),
    updated: z.coerce.date(),
    status: z.enum(['live', 'under-observation']),
    // Gallery metadata (drives the homepage feature + /guides/ grid so a new
    // guide is a content change, not markup).
    theme: z.enum(['fg01', 'fg02', 'fg03', 'fg04']).optional(),
    subjectTag: z.string().optional(),
    tagline: z.string().optional(),
    featured: z.boolean().default(false),
    order: z.number().default(0),
    cover: z.string().optional(),
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
    // `preview` is editorial prose and renders in the guide's map panel, so it
    // runs long by design. Search results cut a description around 155
    // characters, which silently discarded the tail of all eight of these. The
    // meta description is therefore its own field rather than a truncation of
    // the prose, and the max() is a build-time guard so it cannot drift back.
    metaDescription: z.string().max(155).optional(),
    sources: z.array(
      z.object({
        label: z.string(),
        url: z.string(),
      })
    ),
  }),
});

export const collections = { guides, locations };
