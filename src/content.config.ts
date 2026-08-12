import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const guides = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    // `description` is card copy and nothing else: the gallery cards on / and
    // /guides/ are its only readers, and every page writes its own meta
    // description separately. The card clamps to 3 lines, and the narrowest the
    // blurb box ever gets is 219px, at the 640px two-column breakpoint. 85
    // characters is what survives three lines there, so the max() is a
    // build-time guard against copy that would silently lose its own tail.
    description: z.string().max(85),
    published: z.coerce.date(),
    updated: z.coerce.date(),
    // Gallery metadata (drives the homepage feature + /guides/ grid so a new
    // guide is a content change, not markup). Every field here has a reader in
    // src/. `status`, `tagline` and `featured` used to sit alongside them and
    // none of the three did: the card's status chip is computed from
    // `published`, the card shows `subjectTag` rather than a tagline, and the
    // gallery orders by `order` rather than promoting a featured guide. They
    // were removed rather than rendered, since all three described an internal
    // state the reader was never shown.
    theme: z.enum(['fg01', 'fg02', 'fg03', 'fg04']).optional(),
    subjectTag: z.string().optional(),
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
