'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startTeamServer } = require('../lib/server');
const { Outbox } = require('../lib/outbox');
const { syncOnce, enrollRequest } = require('../lib/sync');
const { newSegmentId, newEventId } = require('../lib/token');

test('recordings stay queued while the admin is down, then upload once', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sync-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sync-out-'));
  const server = await startTeamServer({
    dataDir,
    port: 0,
    adminToken: 'admin-token-test-value',
    minFreeBytes: 0
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const enrolled = await enrollRequest(base, 'Offline-PC');
    const outbox = new Outbox(outDir);
    const segmentId = newSegmentId();
    const filePath = path.join(outDir, `${segmentId}.mp4`);
    const startedAt = new Date().toISOString();
    const endedAt = new Date(Date.now() + 5000).toISOString();
    fs.writeFileSync(filePath, 'local-recording');
    outbox.enqueueSegment({
      segmentId,
      filePath,
      meta: { displayIndex: 0, startedAt, endedAt, frameCount: 5, width: 1280, height: 720 }
    });
    const eventId = newEventId();
    outbox.enqueueActivity({
      id: eventId,
      at: new Date().toISOString(),
      app: 'Excel',
      title: 'sheet',
      displayIndex: 0
    });

    await server.close();
    const offline = await syncOnce({
      baseUrl: base,
      memberToken: enrolled.memberToken,
      outbox
    });
    assert.equal(offline.online, false);
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(outbox.stats().pendingSegments, 1);

    const restored = await startTeamServer({
      dataDir,
      port: server.port,
      adminToken: 'admin-token-test-value'
    });
    try {
      const uploaded = await syncOnce({
        baseUrl: `http://127.0.0.1:${restored.port}`,
        memberToken: enrolled.memberToken,
        outbox
      });
      assert.equal(uploaded.online, true);
      assert.equal(uploaded.uploadedActivities, 1);
      assert.equal(uploaded.uploadedSegments, 1);
      assert.equal(fs.existsSync(filePath), false);

      const again = await syncOnce({
        baseUrl: `http://127.0.0.1:${restored.port}`,
        memberToken: enrolled.memberToken,
        outbox
      });
      assert.equal(again.uploadedSegments, 0);
      const date = startedAt.slice(0, 10);
      const listed = restored.archive.listSegments({
        machineId: enrolled.machineId,
        displayIndex: 0
      });
      assert.equal(listed.length, 1);
      assert.equal(restored.archive.readSegment(segmentId).buffer.toString(), 'local-recording');
      assert.equal(restored.archive.listActivity(enrolled.machineId, listed[0].date).length, 1);
      assert.ok(date);
    } finally {
      await restored.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('a missing local file stays pending and does not block the next recording', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sync-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sync-out-'));
  const server = await startTeamServer({
    dataDir,
    port: 0,
    adminToken: 'admin-token-test-value',
    minFreeBytes: 0
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const enrolled = await enrollRequest(base, 'Offline-PC');
    const outbox = new Outbox(outDir);
    const missingId = newSegmentId();
    const presentId = newSegmentId();
    const filePath = path.join(outDir, `${presentId}.mp4`);
    fs.writeFileSync(filePath, 'present-recording');
    const meta = {
      displayIndex: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date(Date.now() + 1000).toISOString(),
      frameCount: 1,
      width: 320,
      height: 180
    };
    outbox.enqueueSegment({ segmentId: missingId, filePath: path.join(outDir, 'gone.mp4'), meta });
    outbox.enqueueSegment({ segmentId: presentId, filePath, meta });
    const uploaded = await syncOnce({
      baseUrl: base,
      memberToken: enrolled.memberToken,
      outbox
    });
    assert.equal(uploaded.uploadedSegments, 1);
    assert.match(uploaded.error, /missing/);
    assert.equal(outbox.nextPendingSegment().segmentId, missingId);
    assert.equal(outbox.stats().pendingSegments, 1);
    assert.equal(server.archive.hasSegment(presentId), true);
    assert.equal(server.archive.hasSegment(missingId), false);
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
