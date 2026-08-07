import { serializeFg04State } from './fg04-state.mjs';

export function canonicalFg04Path(pathname, hash, state, localTiles = false) {
  const params = new URLSearchParams(serializeFg04State(state));
  if (localTiles) params.set('tiles', 'local');
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ''}${hash ?? ''}`;
}

export function writeFg04History(history, mode, url, state) {
  if (mode !== 'replace' && mode !== 'push') {
    throw new RangeError('history mode must be replace or push');
  }
  let existing = {};
  try {
    if (history.state && typeof history.state === 'object') {
      existing = history.state;
    }
  } catch {
    existing = {};
  }
  const snapshot = {
    ...state,
    map: state?.map === null || !Array.isArray(state?.map)
      ? null
      : [...state.map],
    point: state?.point === null || !Array.isArray(state?.point)
      ? null
      : [...state.point],
  };
  const nextState = { ...existing, fg04: snapshot };
  if (mode === 'push' && Number.isInteger(existing.index)) {
    nextState.index = existing.index + 1;
    nextState.scrollX = 0;
    nextState.scrollY = 0;
  }
  history[`${mode}State`](nextState, '', url);
}

function fallbackCopy(url, document) {
  if (!document?.body || typeof document.createElement !== 'function') {
    return false;
  }
  const field = document.createElement('textarea');
  field.value = url;
  field.setAttribute('readonly', '');
  field.setAttribute(
    'style',
    'position:fixed;inset:0 auto auto:-9999px;width:1px;height:1px',
  );
  document.body.append(field);
  try {
    field.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

export async function copyFg04Url(url, environment = {}) {
  const clipboard = environment.clipboard
    ?? globalThis.navigator?.clipboard
    ?? null;
  const document = environment.document ?? globalThis.document ?? null;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(url);
      return 'clipboard';
    } catch {
      // The browser may expose the API but deny it outside a user gesture.
    }
  }
  return fallbackCopy(url, document) ? 'fallback' : 'error';
}
