'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { blitPointer, cursorOnThumbnail, pointerScale } = require('../teammate-app/pointer');

test('cursor maps onto the thumbnail only when it is on that display', () => {
  const bounds = { x: 1920, y: 0, width: 1920, height: 1080 };
  assert.equal(cursorOnThumbnail({ x: 100, y: 100 }, bounds, 960, 540), null);
  assert.deepEqual(
    cursorOnThumbnail({ x: 1920 + 960, y: 540 }, bounds, 960, 540),
    { x: 480, y: 270 }
  );
});

test('pointer pixels are drawn at the hotspot', () => {
  const width = 40;
  const height = 40;
  const bitmap = Buffer.alloc(width * height * 4, 80);
  blitPointer(bitmap, width, height, 2, 3, 1);
  const i = (3 * width + 2) * 4;
  assert.equal(bitmap[i], 12);
  assert.equal(bitmap[i + 1], 12);
  assert.equal(bitmap[i + 2], 12);
  assert.equal(pointerScale(1280), 3);
  assert.equal(pointerScale(720), 2);
});
