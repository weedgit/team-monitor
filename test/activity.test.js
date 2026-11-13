'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { displayIndexForWindow } = require('../lib/activity');
const { memberTiles, seekWithin } = require('../lib/review');
const { normalizeServerUrl, resolveLocalServerUrl, checkHealth, syncOnce } = require('../lib/sync');

test('a window center maps onto the display that contains it, including scaled pixels', () => {
  const displays = [
    { index: 0, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { index: 1, scaleFactor: 1, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
    { index: 2, scaleFactor: 1, bounds: { x: 0, y: 1080, width: 1280, height: 720 } }
  ];
  assert.equal(displayIndexForWindow({ left: 10, top: 10, right: 30, bottom: 30 }, displays), 0);
  assert.equal(displayIndexForWindow({ left: 2000, top: 10, right: 2100, bottom: 40 }, displays), 1);
  assert.equal(displayIndexForWindow({ left: 20, top: 1200, right: 80, bottom: 1280 }, displays), 2);

  const scaled = [
    { index: 0, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { index: 1, scaleFactor: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
  ];
  assert.equal(displayIndexForWindow({ left: 3900, top: 80, right: 3980, bottom: 160 }, scaled), 1);
});

test('member tiles keep every display, and seek stays inside the segment', () => {
  const tiles = memberTiles([{
    machineId: 'm_0123456789abcdef',
    hostname: 'LAPTOP',
    online: true,
    capture: 'recording',
    displays: [{ index: 0 }, { index: 1 }, { index: 2 }]
  }]);
  assert.deepEqual(tiles[0].displays.map((display) => display.label), ['Display 1', 'Display 2', 'Display 3']);
  const segment = {
    startedAt: '2026-10-12T10:00:00.000Z',
    endedAt: '2026-10-12T10:01:00.000Z'
  };
  assert.equal(seekWithin(segment, '2026-10-12T10:00:03.000Z'), 3);
  assert.equal(seekWithin(segment, '2026-10-12T09:00:00.000Z'), 0);
  assert.equal(seekWithin(segment, '2026-10-12T11:00:00.000Z'), 60);
});

test('server addresses are reduced to origin', () => {
  assert.equal(normalizeServerUrl('127.0.0.1:3921'), 'http://127.0.0.1:3921');
  assert.equal(normalizeServerUrl('http://192.168.1.20:3921/ignored'), 'http://192.168.1.20:3921');
  assert.equal(normalizeServerUrl('ADMIN-PC:3921'), 'http://admin-pc:3921');
  assert.throws(() => normalizeServerUrl(''));
  assert.throws(() => normalizeServerUrl('http://8.8.8.8:3921'));
  assert.throws(() => normalizeServerUrl('https://example.com:3921'));
});

test('teammate will not enroll or upload to an internet address', async () => {
  assert.equal(await resolveLocalServerUrl('http://127.0.0.1:3921'), 'http://127.0.0.1:3921');
  await assert.rejects(() => resolveLocalServerUrl('http://8.8.8.8:3921'));
  await assert.rejects(() => resolveLocalServerUrl('https://example.com'));
  assert.equal(await checkHealth('http://8.8.8.8:3921'), false);
  const blocked = await syncOnce({
    baseUrl: 'http://1.1.1.1:3921',
    memberToken: 'x',
    outbox: { pendingActivities: () => [], nextPendingSegment: () => null }
  });
  assert.equal(blocked.online, false);
  assert.match(blocked.error, /local address/i);
});

test('foreground script returns the active window', async () => {
  const { spawn } = require('child_process');
  const script = path.join(__dirname, '..', 'teammate-app', 'foreground.ps1');
  const result = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write('\n');
    child.stdin.end();
  });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(typeof body.app, 'string');
  assert.equal(typeof body.title, 'string');
  assert.equal(typeof body.left, 'number');
});
