'use strict';

// Classic pointer. X = outline, . = fill. Hotspot is the tip at (0, 0).
const ROWS = [
  'X',
  'XX',
  'X.X',
  'X..X',
  'X...X',
  'X....X',
  'X.....X',
  'X......X',
  'X.......X',
  'X........X',
  'X.........X',
  'X..........X',
  'X......XXXXXX',
  'X...X..X',
  'X..X X.X',
  'X.X  X.X',
  'XX    X.X',
  'X      XX'
];

function cursorOnThumbnail(point, bounds, thumbWidth, thumbHeight) {
  if (!point || !bounds || !thumbWidth || !thumbHeight) return null;
  const left = Number(bounds.x) || 0;
  const top = Number(bounds.y) || 0;
  const width = Number(bounds.width) || 0;
  const height = Number(bounds.height) || 0;
  if (width <= 0 || height <= 0) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < left || y < top || x >= left + width || y >= top + height) return null;
  return {
    x: Math.round((x - left) * (thumbWidth / width)),
    y: Math.round((y - top) * (thumbHeight / height))
  };
}

function pointerScale(thumbHeight) {
  return Number(thumbHeight) >= 1000 ? 3 : 2;
}

function plot(bitmap, width, height, x, y, b, g, r, a) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  if (a >= 255) {
    bitmap[i] = b;
    bitmap[i + 1] = g;
    bitmap[i + 2] = r;
    bitmap[i + 3] = 255;
    return;
  }
  const ia = 255 - a;
  bitmap[i] = Math.round((bitmap[i] * ia + b * a) / 255);
  bitmap[i + 1] = Math.round((bitmap[i + 1] * ia + g * a) / 255);
  bitmap[i + 2] = Math.round((bitmap[i + 2] * ia + r * a) / 255);
  bitmap[i + 3] = 255;
}

function blitPointer(bitmap, width, height, originX, originY, scale) {
  const step = Math.max(1, Number(scale) || 1);
  for (let row = 0; row < ROWS.length; row += 1) {
    const line = ROWS[row];
    for (let col = 0; col < line.length; col += 1) {
      const cell = line[col];
      if (cell !== 'X' && cell !== '.') continue;
      const b = cell === 'X' ? 12 : 255;
      const g = cell === 'X' ? 12 : 255;
      const r = cell === 'X' ? 12 : 255;
      for (let dy = 0; dy < step; dy += 1) {
        for (let dx = 0; dx < step; dx += 1) {
          plot(bitmap, width, height, originX + col * step + dx, originY + row * step + dy, b, g, r, 255);
        }
      }
    }
  }
}

function bitmapPixels(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  if (!bitmap || !size.width || !size.height) return null;
  const pixels = Math.floor(bitmap.length / 4);
  if (pixels === size.width * size.height) {
    return { bitmap, width: size.width, height: size.height, posScaleX: 1, posScaleY: 1 };
  }
  const scale = Math.sqrt(pixels / (size.width * size.height));
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  if (width * height !== pixels) return null;
  return { bitmap, width, height, posScaleX: width / size.width, posScaleY: height / size.height };
}

function overlayPointer(image, display, point, nativeImage) {
  if (!image || !nativeImage || typeof image.isEmpty !== 'function' || image.isEmpty()) return image;
  const size = image.getSize();
  const pos = cursorOnThumbnail(point, display && display.bounds, size.width, size.height);
  if (!pos) return image;
  const pixels = bitmapPixels(image);
  if (!pixels) return image;
  const copy = Buffer.from(pixels.bitmap);
  blitPointer(
    copy,
    pixels.width,
    pixels.height,
    Math.round(pos.x * pixels.posScaleX),
    Math.round(pos.y * pixels.posScaleY),
    pointerScale(pixels.height)
  );
  return nativeImage.createFromBitmap(copy, { width: pixels.width, height: pixels.height });
}

module.exports = {
  blitPointer,
  cursorOnThumbnail,
  overlayPointer,
  pointerScale
};
