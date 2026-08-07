import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classificationReliefExpression,
  decodePackedElevation,
  decodeTilePixel,
  hourBit,
  resolveFg04TileTemplate,
  selectedHourLayerContracts,
  selectedHourReliefExpression,
  tileAddressForLngLat,
} from '../src/scripts/fg04-core.mjs';

const HOURS = Object.freeze({
  6: 0, 7: 1, 8: 2, 9: 3, 10: 4, 11: 5, 12: 6, 13: 7,
  14: 8, 15: 9, 16: 10, 17: 11, 18: 12, 19: 13, 20: 14,
});

const UNPACK = Object.freeze({
  redFactor: 6553.6,
  greenFactor: 25.6,
  blueFactor: 0.1,
  baseShift: 10000,
});

function evaluate(expression, elevation, scope = new Map()) {
  if (!Array.isArray(expression)) return expression;
  const [operator, ...args] = expression;
  switch (operator) {
    case 'elevation': return elevation;
    case '+': return evaluate(args[0], elevation, scope) + evaluate(args[1], elevation, scope);
    case '/': return evaluate(args[0], elevation, scope) / evaluate(args[1], elevation, scope);
    case '%': return evaluate(args[0], elevation, scope) % evaluate(args[1], elevation, scope);
    case 'round': return Math.round(evaluate(args[0], elevation, scope));
    case 'floor': return Math.floor(evaluate(args[0], elevation, scope));
    case '==': return evaluate(args[0], elevation, scope) === evaluate(args[1], elevation, scope);
    case '>=': return evaluate(args[0], elevation, scope) >= evaluate(args[1], elevation, scope);
    case '<': return evaluate(args[0], elevation, scope) < evaluate(args[1], elevation, scope);
    case 'all': return args.every((value) => evaluate(value, elevation, scope));
    case 'var': return scope.get(args[0]);
    case 'case': {
      for (let index = 0; index < args.length - 1; index += 2) {
        if (evaluate(args[index], elevation, scope)) {
          return evaluate(args[index + 1], elevation, scope);
        }
      }
      return evaluate(args.at(-1), elevation, scope);
    }
    case 'let': {
      const local = new Map(scope);
      for (let index = 0; index < args.length - 1; index += 2) {
        local.set(args[index], evaluate(args[index + 1], elevation, local));
      }
      return evaluate(args.at(-1), elevation, local);
    }
    default: throw new Error(`test evaluator does not support ${operator}`);
  }
}

test('a real v3 pixel decodes to the Python reference mask', () => {
  assert.deepEqual(
    decodeTilePixel(11, 112, 255),
    { count: 11, mask: 0x70ff },
  );
  assert.equal(hourBit(0x70ff, 13, HOURS), true);

  assert.deepEqual(
    decodeTilePixel(10, 124, 103),
    { count: 10, mask: 0x7c67 },
  );
  assert.equal(hourBit(0x7c67, 13, HOURS), false);
});

test('invalid channel bytes are rejected instead of truncated', () => {
  for (const channels of [
    [-1, 0, 0], [256, 0, 0], [1.5, 0, 0], [0, Number.NaN, 0],
  ]) {
    assert.throws(() => decodeTilePixel(...channels), RangeError);
  }
});

test('MapLibre elevation decodes to the same real masks', () => {
  assert.deepEqual(
    decodePackedElevation(64982.3, UNPACK),
    { count: 11, mask: 0x70ff },
  );
  assert.deepEqual(
    decodePackedElevation(58720.7, UNPACK),
    { count: 10, mask: 0x7c67 },
  );
});

test('the selected-hour relief expression classifies real elevations', () => {
  const colors = {
    shaded: 'blocked',
    sunlit: 'sunlit',
    noData: 'no-data',
  };
  const expression = selectedHourReliefExpression(13, HOURS, UNPACK, colors);

  assert.equal(evaluate(expression, 64982.3), 'blocked');
  assert.equal(evaluate(expression, 58720.7), 'sunlit');
  assert.equal(evaluate(expression, -10000), 'no-data');
});

test('every declared clock hour selects only its own bit', () => {
  for (const [hourText, position] of Object.entries(HOURS)) {
    const hour = Number(hourText);
    const mask = 1 << position;
    assert.equal(hourBit(mask, hour, HOURS), true);
    for (const other of Object.keys(HOURS).map(Number)) {
      if (other !== hour) assert.equal(hourBit(mask, other, HOURS), false);
    }
  }
});

test('unknown clock hours are rejected', () => {
  for (const hour of [5, 21, 13.5, '13', null]) {
    assert.throws(() => hourBit(0x7fff, hour, HOURS), RangeError);
  }
});

test('the proof coordinate resolves to its real z16 tile pixel', () => {
  assert.deepEqual(
    tileAddressForLngLat(-79.3844497203827, 43.653954970269545, 16, 256),
    { zoom: 16, x: 18316, y: 23917, column: 128, row: 128 },
  );
});

test('tile addressing rejects unsafe coordinates and zooms', () => {
  for (const args of [
    [181, 43.65, 16, 256],
    [-79.38, 86, 16, 256],
    [-79.38, 43.65, -1, 256],
    [-79.38, 43.65, 16.5, 256],
    [-79.38, 43.65, 16, 0],
  ]) {
    assert.throws(() => tileAddressForLngLat(...args), RangeError);
  }
});

test('the corrected canopy expression shades only class three', () => {
  const expression = classificationReliefExpression(
    {
      0: -10000,
      1: -3446.4,
      2: 3107.2,
      3: 9660.8,
      4: 16214.4,
    },
    { shaded: 'blocked', other: 'clear' },
  );

  assert.equal(evaluate(expression, -10000), 'clear');
  assert.equal(evaluate(expression, -3446.4), 'clear');
  assert.equal(evaluate(expression, 3107.2), 'clear');
  assert.equal(evaluate(expression, 9660.8), 'blocked');
});

test('both surfaces receive the same hour and only corrected gets canopy', () => {
  const manifest = {
    hourBits: HOURS,
    demUnpack: UNPACK,
    classification: {
      classBandStarts: {
        0: -10000,
        1: -3446.4,
        2: 3107.2,
        3: 9660.8,
        4: 16214.4,
      },
    },
  };
  const colors = {
    shaded: 'blocked', sunlit: 'sunlit', noData: 'clear',
  };

  const measured = selectedHourLayerContracts('raw', 16, manifest, colors);
  const corrected = selectedHourLayerContracts(
    'corrected', 16, manifest, colors,
  );

  assert.deepEqual(measured.map((layer) => layer.id), ['shade-selected-hour']);
  assert.deepEqual(
    corrected.map((layer) => layer.id),
    ['shade-selected-hour', 'shade-under-canopy'],
  );
  assert.deepEqual(
    measured[0].paint['color-relief-color'],
    corrected[0].paint['color-relief-color'],
  );
  assert.equal(
    evaluate(measured[0].paint['color-relief-color'], 71499.9),
    'blocked',
  );
});

test('R2 is the default even on localhost and local tiles require opt in', () => {
  const manifest = {
    tileUrlTemplates: { raw: 'https://tiles.example/raw/{z}/{x}/{y}.webp' },
    localTileUrlTemplates: { raw: '/data/raw/{z}/{x}/{y}.webp' },
  };

  assert.equal(
    resolveFg04TileTemplate(manifest, 'raw', {
      hostname: 'localhost', search: '',
    }),
    manifest.tileUrlTemplates.raw,
  );
  assert.equal(
    resolveFg04TileTemplate(manifest, 'raw', {
      hostname: 'localhost', search: '?tiles=local',
    }),
    manifest.localTileUrlTemplates.raw,
  );
  assert.equal(
    resolveFg04TileTemplate(manifest, 'raw', {
      hostname: 'torontomicroatlas.com', search: '?tiles=local',
    }),
    manifest.tileUrlTemplates.raw,
  );
  assert.equal(
    resolveFg04TileTemplate(manifest, 'raw', {
      hostname: '127.0.0.1', search: '?tiles=local&tiles=local',
    }),
    manifest.tileUrlTemplates.raw,
  );
});
