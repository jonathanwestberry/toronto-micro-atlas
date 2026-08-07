import { decodeTilePixel, tileAddressForLngLat } from './fg04-core.mjs';

export const CLASSIFICATION = Object.freeze({
  missing: 0,
  nonGround: 1,
  ground: 2,
  underCanopy: 3,
});

const ALL_HOURS = 0x7fff;

function fillTemplate(template, { zoom, x, y }) {
  if (typeof template !== 'string') {
    throw new TypeError('point tile template is missing');
  }
  return template
    .replace('{z}', String(zoom))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

export function pointTileRequest(lngLat, manifest) {
  if (!Array.isArray(lngLat) || lngLat.length !== 2) {
    throw new TypeError('point coordinate must be longitude and latitude');
  }
  const zoom = Number(manifest?.nativeZoom);
  const tileSize = Number(manifest?.tileSize);
  const address = tileAddressForLngLat(lngLat[0], lngLat[1], zoom, tileSize);
  return {
    ...address,
    urls: {
      measured: fillTemplate(manifest?.tileUrlTemplates?.raw, address),
      corrected: fillTemplate(manifest?.tileUrlTemplates?.corrected, address),
      classification: fillTemplate(
        manifest?.classification?.tileUrlTemplate, address,
      ),
    },
  };
}

async function browserDecodeTileBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('browser did not provide a tile canvas');
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      pixels: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
    };
  } finally {
    bitmap.close();
  }
}

function pixelAt(tile, row, column) {
  if (
    !tile
    || !Number.isInteger(tile.width)
    || !Number.isInteger(tile.height)
    || row < 0
    || column < 0
    || row >= tile.height
    || column >= tile.width
    || !tile.pixels
    || tile.pixels.length !== tile.width * tile.height * 4
  ) {
    throw new Error('decoded point tile has an invalid shape');
  }
  const offset = (row * tile.width + column) * 4;
  return Array.from(tile.pixels.slice(offset, offset + 3));
}

function cachedTile(url, cache, environment) {
  if (cache.has(url)) return cache.get(url);
  const fetchImpl = environment.fetchImpl ?? fetch;
  const decodeTileBlob = environment.decodeTileBlob ?? browserDecodeTileBlob;
  const pending = (async () => {
    const response = await fetchImpl(url);
    if (!response?.ok) {
      throw new Error(`point tile request failed with ${response?.status ?? 0}`);
    }
    return decodeTileBlob(await response.blob());
  })();
  cache.set(url, pending);
  pending.catch(() => cache.delete(url));
  return pending;
}

function maskProfile(mask, manifest) {
  const first = Number(manifest?.firstHour);
  const last = Number(manifest?.lastHour);
  if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) {
    throw new Error('manifest clock-hour range is invalid');
  }
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const hour = first + index;
    const position = manifest?.hourBits?.[String(hour)];
    if (!Number.isInteger(position)) {
      throw new Error(`manifest has no bit for ${hour}:00`);
    }
    return ((mask >> position) & 1) === 1;
  });
}

function emptyResult(status, coordinate, classValue = null) {
  return {
    status,
    coordinate,
    classValue,
    underCanopy: false,
    measured: null,
    corrected: null,
  };
}

export async function loadPointProfile(
  lngLat,
  manifest,
  cache = new Map(),
  environment = {},
) {
  const coordinate = [
    Number(Number(lngLat?.[0]).toFixed(5)),
    Number(Number(lngLat?.[1]).toFixed(5)),
  ];
  try {
    const request = pointTileRequest(lngLat, manifest);
    const [measuredTile, correctedTile, classTile] = await Promise.all([
      cachedTile(request.urls.measured, cache, environment),
      cachedTile(request.urls.corrected, cache, environment),
      cachedTile(request.urls.classification, cache, environment),
    ]);
    const classPixel = pixelAt(classTile, request.row, request.column);
    if (classPixel[1] !== 0 || classPixel[2] !== 0) {
      throw new Error('classification tile reserved channels are not zero');
    }
    const classValue = classPixel[0];
    if (classValue === CLASSIFICATION.missing) {
      return emptyResult('missing', coordinate, classValue);
    }
    if (classValue === CLASSIFICATION.nonGround) {
      return emptyResult('non-ground', coordinate, classValue);
    }
    if (
      classValue !== CLASSIFICATION.ground
      && classValue !== CLASSIFICATION.underCanopy
    ) {
      throw new Error('classification tile contains an unknown class');
    }

    const measured = decodeTilePixel(
      ...pixelAt(measuredTile, request.row, request.column),
    );
    const corrected = decodeTilePixel(
      ...pixelAt(correctedTile, request.row, request.column),
    );
    const underCanopy = classValue === CLASSIFICATION.underCanopy;
    return {
      status: 'ground',
      coordinate,
      classValue,
      underCanopy,
      measured: maskProfile(measured.mask, manifest),
      corrected: maskProfile(
        underCanopy ? ALL_HOURS : corrected.mask, manifest,
      ),
    };
  } catch {
    return emptyResult('error', coordinate);
  }
}

export function pointStateAtHour(profile, hour, manifest) {
  if (profile?.status !== 'ground') return null;
  const first = Number(manifest?.firstHour);
  const last = Number(manifest?.lastHour);
  if (!Number.isInteger(hour) || hour < first || hour > last) {
    throw new RangeError('selected point hour is outside the modelled day');
  }
  const index = hour - first;
  return {
    measured: profile.measured[index],
    corrected: profile.corrected[index],
  };
}

export function createLatestPointRequest(loader, commit) {
  if (typeof loader !== 'function' || typeof commit !== 'function') {
    throw new TypeError('latest point request needs loader and commit functions');
  }
  let generation = 0;
  return async (...args) => {
    generation += 1;
    const request = generation;
    const result = await loader(...args);
    if (request === generation) commit(result);
    return result;
  };
}
