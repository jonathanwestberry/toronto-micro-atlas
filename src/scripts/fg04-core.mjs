const BYTE_MAX = 255;
const WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066;

function assertByte(value, channel) {
  if (!Number.isInteger(value) || value < 0 || value > BYTE_MAX) {
    throw new RangeError(`${channel} must be an integer byte`);
  }
}

function bitPosition(hour, hourBits) {
  if (!Number.isInteger(hour)) {
    throw new RangeError('hour must be an integer clock hour');
  }
  const position = hourBits?.[String(hour)];
  if (!Number.isInteger(position) || position < 0 || position > 14) {
    throw new RangeError(`${hour}:00 is outside the modelled day`);
  }
  return position;
}

function unpackContract(unpack) {
  const redFactor = Number(unpack?.redFactor);
  const greenFactor = Number(unpack?.greenFactor);
  const blueFactor = Number(unpack?.blueFactor);
  const baseShift = Number(unpack?.baseShift);
  if (
    !Number.isFinite(redFactor)
    || !Number.isFinite(greenFactor)
    || !Number.isFinite(blueFactor)
    || !Number.isFinite(baseShift)
    || blueFactor <= 0
  ) {
    throw new TypeError('invalid packed elevation contract');
  }
  const countStep = Math.round(redFactor / blueFactor);
  const highStep = Math.round(greenFactor / blueFactor);
  if (countStep !== 65536 || highStep !== 256) {
    throw new RangeError('unsupported packed elevation factors');
  }
  return { blueFactor, baseShift, countStep };
}

export function decodeTilePixel(red, green, blue) {
  assertByte(red, 'red');
  assertByte(green, 'green');
  assertByte(blue, 'blue');
  return {
    count: red,
    mask: (green << 8) | blue,
  };
}

export function hourBit(mask, hour, hourBits) {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0x7fff) {
    throw new RangeError('mask must contain bits 0 to 14 only');
  }
  return ((mask >> bitPosition(hour, hourBits)) & 1) === 1;
}

export function decodePackedElevation(elevation, unpack) {
  if (!Number.isFinite(elevation)) {
    throw new TypeError('elevation must be finite');
  }
  const { blueFactor, baseShift, countStep } = unpackContract(unpack);
  const packed = Math.round((elevation + baseShift) / blueFactor);
  const count = Math.floor(packed / countStep);
  const mask = packed - count * countStep;
  if (count < 0 || count > 15 || mask < 0 || mask > 0x7fff) {
    throw new RangeError('elevation is outside the fg04 packed range');
  }
  return { count, mask };
}

export function selectedHourReliefExpression(hour, hourBits, unpack, colors) {
  const position = bitPosition(hour, hourBits);
  const { blueFactor, baseShift, countStep } = unpackContract(unpack);
  const shaded = colors?.shaded;
  const sunlit = colors?.sunlit;
  const noData = colors?.noData;
  if ([shaded, sunlit, noData].some((value) => typeof value !== 'string')) {
    throw new TypeError('selected-hour colors must be strings');
  }

  return [
    'let',
    'packed', ['round', ['/', ['+', ['elevation'], baseShift], blueFactor]],
    'count', ['floor', ['/', ['var', 'packed'], countStep]],
    'mask', ['%', ['var', 'packed'], countStep],
    [
      'case',
      ['==', ['var', 'count'], 0], noData,
      [
        '==',
        ['%', ['floor', ['/', ['var', 'mask'], 2 ** position]], 2],
        1,
      ], shaded,
      sunlit,
    ],
  ];
}

export function tileAddressForLngLat(longitude, latitude, zoom, tileSize = 256) {
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError('longitude is outside Web Mercator');
  }
  if (
    !Number.isFinite(latitude)
    || latitude < -WEB_MERCATOR_LATITUDE_LIMIT
    || latitude > WEB_MERCATOR_LATITUDE_LIMIT
  ) {
    throw new RangeError('latitude is outside Web Mercator');
  }
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 24) {
    throw new RangeError('zoom must be an integer from 0 to 24');
  }
  if (!Number.isInteger(tileSize) || tileSize <= 0) {
    throw new RangeError('tile size must be a positive integer');
  }

  const scale = 2 ** zoom;
  const worldX = ((longitude + 180) / 360) * scale;
  const latitudeRadians = latitude * Math.PI / 180;
  const worldY = (
    1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI
  ) / 2 * scale;
  const x = Math.min(scale - 1, Math.floor(worldX));
  const y = Math.min(scale - 1, Math.floor(worldY));
  const column = Math.min(tileSize - 1, Math.floor((worldX - x) * tileSize));
  const row = Math.min(tileSize - 1, Math.floor((worldY - y) * tileSize));
  return { zoom, x, y, column, row };
}
