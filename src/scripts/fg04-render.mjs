/**
 * Turn one decoded v3 shade tile into an ordinary RGBA raster tile.
 *
 * The implementation is deliberately test-first. MapLibre's color-relief
 * layer accepts the selected-hour expression but silently paints it
 * transparent, so the browser must materialize the binary shade state before
 * handing the tile back to MapLibre.
 */
export function renderShadePixels({
  pixels,
  classificationPixels,
  surface,
  hour,
  hourBits,
  colors,
}) {
  if (!(pixels instanceof Uint8ClampedArray) || pixels.length % 4 !== 0) {
    throw new TypeError('shade tile pixels must be RGBA bytes');
  }
  if (surface !== 'raw' && surface !== 'corrected') {
    throw new RangeError('unknown shade surface');
  }
  if (
    surface === 'corrected'
    && (
      !(classificationPixels instanceof Uint8ClampedArray)
      || classificationPixels.length !== pixels.length
    )
  ) {
    throw new TypeError('corrected shade tiles need matching classification pixels');
  }
  const position = hourBits?.[String(hour)];
  if (!Number.isInteger(position) || position < 0 || position > 14) {
    throw new RangeError('selected hour is outside the modelled day');
  }
  for (const name of ['shaded', 'sunlit', 'noData']) {
    if (!Array.isArray(colors?.[name]) || colors[name].length !== 4) {
      throw new TypeError(`${name} must be one RGBA color`);
    }
  }

  const output = new Uint8ClampedArray(pixels.length);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const underCanopy = surface === 'corrected'
      && classificationPixels[offset] === 3;
    const count = pixels[offset];
    const mask = (pixels[offset + 1] << 8) | pixels[offset + 2];
    const color = underCanopy
      ? colors.shaded
      : count === 0
        ? colors.noData
        : ((mask >> position) & 1) === 1
          ? colors.shaded
          : colors.sunlit;
    output.set(color, offset);
  }
  return output;
}

export function shadeTileTemplate(surface, hour) {
  if (surface !== 'raw' && surface !== 'corrected') {
    throw new RangeError('unknown shade surface');
  }
  if (!Number.isInteger(hour)) {
    throw new RangeError('selected hour must be an integer');
  }
  return `fg04shade://${surface}/{z}/{x}/{y}?hour=${hour}`;
}

function fillTemplate(template, address) {
  if (typeof template !== 'string') {
    throw new TypeError('shade tile template is missing');
  }
  return template
    .replace('{z}', address.z)
    .replace('{x}', address.x)
    .replace('{y}', address.y);
}

function parseProtocolUrl(value) {
  const url = new URL(value);
  const parts = url.pathname.split('/').filter(Boolean);
  const hour = Number(url.searchParams.get('hour'));
  if (
    (url.hostname !== 'raw' && url.hostname !== 'corrected')
    || parts.length !== 3
    || parts.some((part) => !/^\d+$/.test(part))
    || !Number.isInteger(hour)
  ) {
    throw new Error('invalid selected-hour tile URL');
  }
  return {
    surface: url.hostname,
    z: parts[0],
    x: parts[1],
    y: parts[2],
    hour,
  };
}

async function fetchTile(url, abortController, fetchImpl, decodeTileBlob) {
  const response = await fetchImpl(url, { signal: abortController?.signal });
  if (!response?.ok) {
    throw new Error(`shade tile request failed with ${response?.status ?? 0}`);
  }
  return decodeTileBlob(await response.blob());
}

export async function browserDecodeTileBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('browser did not provide a shade tile canvas');
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

export async function browserImageFromPixels({ width, height, pixels }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('browser did not provide an output tile canvas');
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  return createImageBitmap(canvas);
}

export function createShadeTileProtocol({
  manifest,
  colors,
  fetchImpl = fetch,
  decodeTileBlob = browserDecodeTileBlob,
  imageFromPixels = browserImageFromPixels,
}) {
  return async (request, abortController) => {
    const address = parseProtocolUrl(request.url);
    const shadeTemplate = manifest?.tileUrlTemplates?.[address.surface];
    const shadeUrl = fillTemplate(shadeTemplate, address);
    const shadePromise = fetchTile(
      shadeUrl, abortController, fetchImpl, decodeTileBlob,
    );
    const classPromise = address.surface === 'corrected'
      ? fetchTile(
          fillTemplate(manifest?.classification?.tileUrlTemplate, address),
          abortController,
          fetchImpl,
          decodeTileBlob,
        )
      : Promise.resolve(null);
    const [shadeTile, classTile] = await Promise.all([shadePromise, classPromise]);
    if (
      !shadeTile
      || !Number.isInteger(shadeTile.width)
      || !Number.isInteger(shadeTile.height)
      || (classTile && (
        classTile.width !== shadeTile.width
        || classTile.height !== shadeTile.height
      ))
    ) {
      throw new Error('selected-hour source tiles have incompatible dimensions');
    }
    const pixels = renderShadePixels({
      pixels: shadeTile.pixels,
      classificationPixels: classTile?.pixels ?? null,
      surface: address.surface,
      hour: address.hour,
      hourBits: manifest?.hourBits,
      colors,
    });
    return {
      data: await imageFromPixels({
        width: shadeTile.width,
        height: shadeTile.height,
        pixels,
      }),
    };
  };
}
