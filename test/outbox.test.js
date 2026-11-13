'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Outbox } = require('../lib/outbox');
const { newSegmentId, newEventId } = require('../lib/token');

test('an upload that was interrupted is pending again after restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-outbox-'));
  const first = new Outbox(directory);
  const segmentId = newSegmentId();
  const filePath = path.join(directory, 'clip.mp4');
  fs.writeFileSync(filePath, 'video');
  first.enqueueSegment({
    segmentId,
    filePath,
    meta: { displayIndex: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }
  });
  first.markSegment(segmentId, 'uploading');
  const reopened = new Outbox(directory);
  assert.equal(reopened.nextPendingSegment().segmentId, segmentId);
  assert.equal(reopened.stats().pendingSegments, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('activity rows leave the queue once they are acknowledged', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-outbox-'));
  const outbox = new Outbox(directory);
  const id = newEventId();
  outbox.enqueueActivity({ id, at: new Date().toISOString(), app: 'Code', title: 'a', displayIndex: 0 });
  outbox.enqueueActivity({ id, at: new Date().toISOString(), app: 'Code', title: 'a', displayIndex: 0 });
  assert.equal(outbox.pendingActivities().length, 1);
  outbox.ackActivities([id]);
  assert.equal(outbox.stats().pendingActivities, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});
