'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const appName = process.argv[2];
if (!appName) {
  console.error('Usage: node scripts/prepare-app.js <admin-app|teammate-app>');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const src = path.join(root, 'lib');
const dest = path.join(root, appName, 'lib');
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });

const iconDir = path.join(root, appName, 'build');
fs.mkdirSync(iconDir, { recursive: true });
fs.writeFileSync(path.join(iconDir, 'icon.png'), circlePng(256, 61, 139, 253));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, checksum]);
}

function circlePng(size, red, green, blue) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const cx = x - size / 2 + 0.5;
      const cy = y - size / 2 + 0.5;
      const inside = (cx * cx) + (cy * cy) <= radius * radius;
      const i = row + 1 + x * 4;
      const screen = inside && cy > -radius * 0.2 && cy < radius * 0.55 && Math.abs(cx) < radius * 0.62;
      raw[i] = screen ? 244 : red;
      raw[i + 1] = screen ? 247 : green;
      raw[i + 2] = screen ? 252 : blue;
      raw[i + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
