/**
 * Guides under research, shown as muted "Forthcoming" cards in the gallery.
 * These have no page yet, so they carry no href. Promote one to a real guide
 * by adding a content file in src/content/guides/ and removing it here.
 *
 * Keep `description` to 85 characters, the same budget the guides collection
 * enforces in src/content.config.ts. The card clamps to 3 lines and the blurb
 * box narrows to 219px at the 640px breakpoint, so anything longer loses its
 * own tail. There is no schema here to enforce it, so it is enforced by eye.
 */
export interface ForthcomingGuide {
  title: string;
  description: string;
  tag: string;
}

export const forthcoming: ForthcomingGuide[] = [
  {
    title: 'Farmers Markets',
    tag: 'Food & season',
    description: "Toronto's outdoor markets, mapped by neighbourhood and season.",
  },
  {
    title: 'Quiet Third Places',
    tag: 'Rest & refuge',
    description: 'The libraries, lobbies, and garden corners that let you sit still.',
  },
];

/*
 * "Shade and Cooling" was removed on 2026-08-11. It was not a future guide, it
 * was the front door of a guide that had already shipped: its promise, "where
 * to find cover on a hot day", is exactly what Out of the Sun does. Showing
 * both told a visitor the finished work was still pending, and the forthcoming
 * card read better than the guide because it was the only one of the two that
 * said what a reader gets. That promise now lives in the guide's own lede.
 */
