import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalFg04Path,
  copyFg04Url,
  writeFg04History,
} from '../src/scripts/fg04-runtime.mjs';

test('canonical paths include only explorer state and the local tile opt-in', () => {
  const state = {
    hour: 16,
    map: [-79.38252, 43.64545, 15],
    point: null,
    street: 'york-street',
  };
  assert.equal(
    canonicalFg04Path('/guides/throwing-shade/', '#profile', state, false),
    '/guides/throwing-shade/?hour=16&map=-79.38252%2C43.64545%2C15.00&street=york-street#profile',
  );
  assert.equal(
    canonicalFg04Path('/guides/throwing-shade/', '', state, true),
    '/guides/throwing-shade/?hour=16&map=-79.38252%2C43.64545%2C15.00&street=york-street&tiles=local',
  );
});

test('history writes preserve host state and add one explorer snapshot', () => {
  const calls = [];
  const astroState = { index: 4, scroll: 120 };
  const history = {
    state: astroState,
    replaceState: (...args) => calls.push(['replace', ...args]),
    pushState: (...args) => calls.push(['push', ...args]),
  };

  const state = {
    hour: 16,
    map: [-79.4, 43.7, 15],
    point: null,
    street: 'york-street',
  };
  writeFg04History(history, 'replace', '/one', state);
  writeFg04History(history, 'push', '/two', state);
  const expectedState = {
    ...astroState,
    fg04: state,
  };
  assert.deepEqual(calls, [
    ['replace', expectedState, '', '/one'],
    ['push', {
      ...expectedState,
      index: 5,
      scrollX: 0,
      scrollY: 0,
    }, '', '/two'],
  ]);
  assert.notEqual(calls[0][1], astroState);
});

test('copy uses the clipboard without touching focus', async () => {
  const copied = [];
  const result = await copyFg04Url('https://example.test/?hour=16', {
    clipboard: { writeText: async (value) => copied.push(value) },
  });
  assert.equal(result, 'clipboard');
  assert.deepEqual(copied, ['https://example.test/?hour=16']);
});

test('copy falls back to a temporary selected field when clipboard fails', async () => {
  const actions = [];
  const field = {
    value: '',
    setAttribute: (...args) => actions.push(['attribute', ...args]),
    select: () => actions.push(['select']),
    remove: () => actions.push(['remove']),
  };
  const document = {
    createElement: () => field,
    body: { append: (element) => actions.push(['append', element]) },
    execCommand: (command) => {
      actions.push(['command', command]);
      return true;
    },
  };
  const result = await copyFg04Url('https://example.test/', {
    clipboard: { writeText: async () => { throw new Error('denied'); } },
    document,
  });
  assert.equal(result, 'fallback');
  assert.equal(field.value, 'https://example.test/');
  assert.deepEqual(actions.at(-2), ['command', 'copy']);
  assert.deepEqual(actions.at(-1), ['remove']);
});

test('copy reports an error when neither path can copy', async () => {
  const result = await copyFg04Url('https://example.test/', {
    clipboard: null,
    document: {
      createElement: () => ({
        value: '', setAttribute() {}, select() {}, remove() {},
      }),
      body: { append() {} },
      execCommand: () => false,
    },
  });
  assert.equal(result, 'error');
});
