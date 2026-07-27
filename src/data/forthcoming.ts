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
  {
    title: 'Shade and Cooling',
    tag: 'Heat & cover',
    description:
      'Where to find cover on a hot day: a taxonomy of trees, awnings, tunnels, and water in the urban surface.',
  },
];
