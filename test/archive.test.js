'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Archive, localDateString } = require('../lib/archive');
const { newMachineId, newSegmentId, newEventId } = require('../lib/token');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-archive-'));
}

test('archive stores a segment by date and display, and ignores a duplicate id', () => {
  const root = tempDir();
  const archive = new Archive(root);
  const machineId = newMachineId();
  const segmentId = newSegmentId();
  const startedAt = new Date('2026-10-12T15:04:05').toISOString();
  const saved = archive.saveSegment({
    machineId,
    segmentId,
    displayIndex: 2,
    startedAt,
    endedAt: new Date('2026-10-12T15:05:05').toISOString(),
    frameCount: 60,
    width: 1280,
    height: 720,
    buffer: Buffer.from('mp4-bytes')
  });
  assert.equal(saved.duplicate, false);
  assert.equal(saved.date, localDateString(startedAt));
  const again = archive.saveSegment({
    machineId,
    segmentId,
    displayIndex: 2,
    startedAt,
    endedAt: startedAt,
    buffer: Buffer.from('other')
  });
  assert.equal(again.duplicate, true);
  const listed = archive.listSegments({ machineId, date: saved.date, displayIndex: 2 });
  assert.equal(listed.length, 1);
  const read = archive.readSegment(segmentId);
  assert.equal(read.buffer.toString(), 'mp4-bytes');
  const folder = path.join(root, 'Teammate', 'Display 3', saved.date);
  const names = fs.readdirSync(folder);
  assert.equal(names.length, 2);
  assert.match(names.find((name) => name.endsWith('.mp4')), /^\d{2}-\d{2}-\d{2}\.mp4$/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('recording folders use the teammate name, display, and time', () => {
  const root = tempDir();
  const archive = new Archive(root);
  const kevin = newMachineId();
  const otherKevin = newMachineId();
  const startedAt = new Date(2026, 9, 12, 14, 30, 22).toISOString();
  const saved = archive.saveSegment({
    machineId: kevin,
    hostname: 'Kevin',
    segmentId: newSegmentId(),
    displayIndex: 0,
    startedAt,
    endedAt: new Date(2026, 9, 12, 14, 31, 22).toISOString(),
    buffer: Buffer.from('kevin-video')
  });
  const folder = path.join(root, 'Kevin', 'Display 1', saved.date);
  assert.equal(fs.existsSync(path.join(folder, '14-30-22.mp4')), true);
  archive.saveSegment({
    machineId: otherKevin,
    hostname: 'Kevin',
    segmentId: newSegmentId(),
    displayIndex: 0,
    startedAt,
    endedAt: startedAt,
    buffer: Buffer.from('other-kevin')
  });
  assert.equal(fs.existsSync(path.join(root, 'Kevin (2)', 'Display 1', saved.date)), true);
  archive.saveSegment({
    machineId: kevin,
    hostname: 'Alex',
    segmentId: newSegmentId(),
    displayIndex: 1,
    startedAt: new Date(2026, 9, 12, 15, 0, 0).toISOString(),
    endedAt: new Date(2026, 9, 12, 15, 1, 0).toISOString(),
    buffer: Buffer.from('alex-video')
  });
  assert.equal(fs.existsSync(path.join(root, 'Kevin')), false);
  assert.equal(fs.existsSync(path.join(root, 'Alex', 'Display 1', saved.date, '14-30-22.mp4')), true);
  assert.equal(archive.readSegment(saved.segmentId).buffer.toString(), 'kevin-video');
  fs.rmSync(root, { recursive: true, force: true });
});

test('archive rejects path traversal ids and empty files', () => {
  const root = tempDir();
  const archive = new Archive(root);
  assert.throws(() => archive.saveSegment({
    machineId: '../outside',
    segmentId: newSegmentId(),
    displayIndex: 0,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    buffer: Buffer.from('x')
  }));
  assert.throws(() => archive.saveSegment({
    machineId: newMachineId(),
    segmentId: newSegmentId(),
    displayIndex: 0,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    buffer: Buffer.alloc(0)
  }));
  fs.rmSync(root, { recursive: true, force: true });
});

test('activity upload is idempotent and a timestamp finds the covering segment', () => {
  const root = tempDir();
  const archive = new Archive(root);
  const machineId = newMachineId();
  const startedAt = new Date();
  const endedAt = new Date(startedAt.getTime() + 60000);
  const segmentId = newSegmentId();
  archive.saveSegment({
    machineId,
    segmentId,
    displayIndex: 1,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    frameCount: 60,
    buffer: Buffer.from('video')
  });
  const eventId = newEventId();
  const at = new Date(startedAt.getTime() + 15000).toISOString();
  const first = archive.appendActivity(machineId, [{
    id: eventId,
    at,
    app: 'Code',
    title: 'plan.md',
    displayIndex: 1
  }]);
  const second = archive.appendActivity(machineId, [{
    id: eventId,
    at,
    app: 'Code',
    title: 'plan.md',
    displayIndex: 1
  }]);
  assert.deepEqual(first, [eventId]);
  assert.deepEqual(second, [eventId]);
  const date = localDateString(at);
  assert.equal(archive.listActivity(machineId, date).length, 1);
  const covering = archive.findCovering(machineId, 1, at);
  assert.equal(covering.segmentId, segmentId);
  assert.equal(archive.findCovering(machineId, 0, at), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a clip that crosses midnight opens from the next morning', () => {
  const root = tempDir();
  const archive = new Archive(root);
  const machineId = newMachineId();
  const segmentId = newSegmentId();
  const startedAt = new Date(2026, 9, 12, 23, 50, 0);
  const endedAt = new Date(2026, 9, 13, 0, 10, 0);
  archive.saveSegment({
    machineId,
    segmentId,
    displayIndex: 0,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    buffer: Buffer.from('overnight')
  });
  const at = new Date(2026, 9, 13, 0, 2, 0).toISOString();
  assert.equal(archive.findCovering(machineId, 0, at).segmentId, segmentId);
  fs.rmSync(root, { recursive: true, force: true });
});

test('prune removes recordings and activity older than the retention window', () => {
  const root = tempDir();
  const archive = new Archive(root);
  const machineId = newMachineId();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const segmentId = newSegmentId();
  archive.saveSegment({
    machineId,
    segmentId,
    displayIndex: 0,
    startedAt: old.toISOString(),
    endedAt: new Date(old.getTime() + 1000).toISOString(),
    buffer: Buffer.from('old')
  });
  archive.appendActivity(machineId, [{
    id: newEventId(),
    at: old.toISOString(),
    app: 'old',
    title: '',
    displayIndex: 0
  }]);
  const recentId = newSegmentId();
  archive.saveSegment({
    machineId,
    segmentId: recentId,
    displayIndex: 0,
    startedAt: new Date().toISOString(),
    endedAt: new Date(Date.now() + 1000).toISOString(),
    buffer: Buffer.from('new')
  });
  const removed = archive.prune(14);
  assert.deepEqual(removed, [segmentId]);
  assert.equal(archive.hasSegment(recentId), true);
  assert.equal(archive.listActivity(machineId, localDateString(old)).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
