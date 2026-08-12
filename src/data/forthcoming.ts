/**
 * Guides under research, shown as muted "Forthcoming" cards in the gallery.
 * These have no page yet, so they carry no href. Promote one to a real guide
 * by adding a content file in src/content/guides/ and removing it here.
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
    description:
      "A rotating atlas of Toronto's outdoor markets, mapped by neighbourhood and season.",
  },
  {
    title: 'Quiet Third Places',
    tag: 'Rest & refuge',
    description:
      'The libraries, reading rooms, lobbies, and garden corners where the city lets you sit still.',
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
