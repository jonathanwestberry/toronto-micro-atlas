/**
 * The panel's tab stop, only when it is really a scroll container.
 *
 * The panel used to carry a hardcoded `tabindex="0"`. On a static container
 * that is a keyboard stop that lands nowhere and explains nothing. But the
 * panel is `overflow-y: auto` with a `max-height` on desktop and on the map
 * route at every width, and its resting state has no focusable children at
 * all, so when it *does* overflow, removing the stop would leave content a
 * keyboard user cannot scroll to (SC 2.1.1).
 *
 * Measured, not assumed, the same reasoning as --header-h in Phase 5. At
 * 1280x900 the resting panel does not overflow; at 1280x600 it does, by 122px,
 * and the map route's floating copy overflows on any phone. Nothing focuses
 * the panel programmatically, so there is no -1 stop to preserve.
 *
 * Shared by both fg01 routes because the panel is now shared. Underscore
 * prefixed so Astro treats it as a module, not a route endpoint.
 */

/** The shell that actually scrolls. The two state bands inside it do not. */
const PANEL_ID = 'guide-panel';

function wire(): () => void {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return () => {};

  const sync = () => {
    const scrolls = panel.scrollHeight > panel.clientHeight + 1;
    if (scrolls) panel.setAttribute('tabindex', '0');
    else panel.removeAttribute('tabindex');
  };

  sync();
  const observer = new ResizeObserver(sync);
  observer.observe(panel);
  return () => observer.disconnect();
}

export function wirePanelScrollStop(): void {
  let release = wire();

  document.addEventListener('astro:before-swap', () => release());

  // Release before re-wiring: on a first load `astro:page-load` fires after
  // this module has already run, so without the release the page would carry
  // two observers on the same element for the rest of its life.
  document.addEventListener('astro:page-load', () => {
    release();
    release = wire();
  });
}
