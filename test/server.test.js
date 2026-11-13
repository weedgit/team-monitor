'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startTeamServer } = require('../lib/server');
const { newSegmentId, newEventId } = require('../lib/token');

async function listen() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-server-'));
  const server = await startTeamServer({
    dataDir,
    port: 0,
    adminToken: 'admin-token-test-value',
    maxMembers: 2,
    minFreeBytes: 0
  });
  return { server, dataDir, base: `http://127.0.0.1:${server.port}` };
}

test('enrollment, upload, and admin reads require the right token', async () => {
  const { server, dataDir, base } = await listen();
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal((await health.json()).ok, true);

    const enrolled = await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Laptop-A' })
    });
    const member = await enrolled.json();
    assert.equal(enrolled.status, 200);
    assert.match(member.machineId, /^m_[a-f0-9]{16}$/);

    await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Laptop-B' })
    });
    const full = await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Laptop-C' })
    });
    assert.equal(full.status, 403);

    const startedAt = new Date().toISOString();
    const endedAt = new Date(Date.now() + 60000).toISOString();
    const segmentId = newSegmentId();
    const upload = await fetch(`${base}/api/segments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${member.memberToken}`,
        'content-type': 'application/octet-stream',
        'x-segment-id': segmentId,
        'x-display-index': '1',
        'x-started-at': startedAt,
        'x-ended-at': endedAt,
        'x-frame-count': '10',
        'x-width': '1280',
        'x-height': '720'
      },
      body: Buffer.from('segment-bytes')
    });
    assert.equal(upload.status, 200, await upload.clone().text());
    const duplicate = await fetch(`${base}/api/segments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${member.memberToken}`,
        'content-type': 'application/octet-stream',
        'x-segment-id': segmentId,
        'x-display-index': '1',
        'x-started-at': startedAt,
        'x-ended-at': endedAt
      },
      body: Buffer.from('segment-bytes-2')
    });
    assert.equal((await duplicate.json()).duplicate, true);

    const stranger = await fetch(`${base}/api/admin/recordings?machineId=${member.machineId}`);
    assert.equal(stranger.status, 401);
    const recordings = await fetch(`${base}/api/admin/recordings?machineId=${member.machineId}&displayIndex=1`, {
      headers: { authorization: 'Bearer admin-token-test-value' }
    });
    const listed = await recordings.json();
    assert.equal(listed.segments.length, 1);
    assert.equal(listed.segments[0].segmentId, segmentId);

    const media = await fetch(`${base}/api/admin/segments/${segmentId}`, {
      headers: { authorization: 'Bearer admin-token-test-value' }
    });
    assert.equal(Buffer.from(await media.arrayBuffer()).toString(), 'segment-bytes');

    const eventId = newEventId();
    const activity = await fetch(`${base}/api/activity`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${member.memberToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        events: [{ id: eventId, at: new Date(Date.now() + 1000).toISOString(), app: 'Code', title: 'doc', displayIndex: 1 }]
      })
    });
    assert.equal((await activity.json()).accepted.length, 1);

    const memberDenied = await fetch(`${base}/api/admin/members`, {
      headers: { authorization: `Bearer ${member.memberToken}` }
    });
    assert.equal(memberDenied.status, 401);
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the same PC keeps its machine id, and a shared name does not replace anyone', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-server-'));
  const server = await startTeamServer({
    dataDir,
    port: 0,
    adminToken: 'admin-token-test-value',
    maxMembers: 4,
    minFreeBytes: 0
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const pcId = `pc_${'ab'.repeat(16)}`;
    const first = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Kevin', pcId })
    })).json();
    await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Bru' })
    });
    const left = await fetch(`${base}/api/leave`, {
      method: 'POST',
      headers: { authorization: `Bearer ${first.memberToken}` }
    });
    assert.equal(left.status, 200);
    assert.equal(server.members.list().some((member) => member.machineId === first.machineId), false);
    assert.equal(server.members.byToken(first.memberToken), null);

    const again = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Kevin', pcId })
    })).json();
    assert.equal(again.machineId, first.machineId);
    assert.equal(again.memberToken, first.memberToken);
    const names = server.members.list().map((member) => member.hostname).sort();
    assert.deepEqual(names, ['Bru', 'Kevin']);

    const offline = server.members.byId(again.machineId);
    offline.online = false;
    const other = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Kevin' })
    })).json();
    assert.notEqual(other.machineId, again.machineId);
    assert.equal(server.members.list().filter((member) => member.hostname === 'Kevin').length, 2);
    assert.equal(server.members.list().some((member) => member.machineId === again.machineId), true);
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('removing a teammate frees the slot and keeps the archive', async () => {
  const { server, dataDir, base } = await listen();
  try {
    const pcId = `pc_${'cd'.repeat(16)}`;
    const enrolled = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Desk', pcId })
    })).json();
    const segmentId = newSegmentId();
    const uploaded = await fetch(`${base}/api/segments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${enrolled.memberToken}`,
        'content-type': 'application/octet-stream',
        'x-segment-id': segmentId,
        'x-display-index': '0',
        'x-started-at': new Date().toISOString(),
        'x-ended-at': new Date(Date.now() + 1000).toISOString()
      },
      body: Buffer.from('kept-bytes')
    });
    assert.equal(uploaded.status, 200);
    const removed = await fetch(`${base}/api/admin/members/${enrolled.machineId}/remove`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token-test-value' }
    });
    assert.equal(removed.status, 200);
    assert.equal(server.members.list().length, 0);
    assert.equal(server.archive.readSegment(segmentId).buffer.toString(), 'kept-bytes');
    const back = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Desk', pcId })
    })).json();
    assert.equal(back.machineId, enrolled.machineId);
    assert.equal(server.archive.listSegments({ machineId: back.machineId }).length, 1);
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a returning PC keeps its recordings after the roster file is replaced', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-server-'));
  const options = {
    dataDir,
    port: 0,
    adminToken: 'admin-token-test-value',
    maxMembers: 4,
    minFreeBytes: 0
  };
  let server = await startTeamServer(options);
  try {
    const pcId = `pc_${'ef'.repeat(16)}`;
    const enrolled = await (await fetch(`http://127.0.0.1:${server.port}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Desk', pcId })
    })).json();
    const plain = await (await fetch(`http://127.0.0.1:${server.port}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Plain' })
    })).json();
    const claimed = await (await fetch(`http://127.0.0.1:${server.port}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Plain', pcId: `pc_${'11'.repeat(16)}`, machineId: plain.machineId })
    })).json();
    assert.equal(claimed.machineId, plain.machineId);
    assert.equal(claimed.memberToken, plain.memberToken);
    const segmentId = newSegmentId();
    const uploaded = await fetch(`http://127.0.0.1:${server.port}/api/segments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${enrolled.memberToken}`,
        'content-type': 'application/octet-stream',
        'x-segment-id': segmentId,
        'x-display-index': '0',
        'x-started-at': new Date().toISOString(),
        'x-ended-at': new Date(Date.now() + 1000).toISOString()
      },
      body: Buffer.from('kept-bytes')
    });
    assert.equal(uploaded.status, 200);
    await server.close();
    fs.writeFileSync(path.join(dataDir, 'members.json'), JSON.stringify({ members: [], retired: {} }));
    server = await startTeamServer(options);
    const again = await (await fetch(`http://127.0.0.1:${server.port}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Desk', pcId })
    })).json();
    assert.equal(again.machineId, enrolled.machineId);
    assert.equal(again.memberToken, enrolled.memberToken);
    assert.equal(server.archive.listSegments({ machineId: again.machineId }).length, 1);
    const thief = await (await fetch(`http://127.0.0.1:${server.port}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Other', pcId: `pc_${'22'.repeat(16)}`, machineId: enrolled.machineId })
    })).json();
    assert.notEqual(thief.machineId, enrolled.machineId);
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a low admin disk refuses the upload and leaves it unacked', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-server-'));
  const server = await startTeamServer({
    dataDir,
    port: 0,
    adminToken: 'admin-token-test-value',
    minFreeBytes: Number.MAX_SAFE_INTEGER
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const enrolled = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Desk' })
    })).json();
    const segmentId = newSegmentId();
    const upload = await fetch(`${base}/api/segments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${enrolled.memberToken}`,
        'content-type': 'application/octet-stream',
        'x-segment-id': segmentId,
        'x-display-index': '0',
        'x-started-at': new Date().toISOString(),
        'x-ended-at': new Date(Date.now() + 1000).toISOString()
      },
      body: Buffer.from('pending-bytes')
    });
    assert.equal(upload.status, 507);
    assert.equal(server.archive.hasSegment(segmentId), false);
    assert.match((await upload.json()).error, /disk is low/i);
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('only an admin can stop a connected teammate', async () => {
  const { server, dataDir, base } = await listen();
  try {
    const enrolled = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Desk' })
    })).json();
    const offline = await fetch(`${base}/api/admin/members/${enrolled.machineId}/command`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token-test-value',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ action: 'stop' })
    });
    assert.equal(offline.status, 409);

    const denied = await fetch(`${base}/api/admin/members/${enrolled.machineId}/command`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${enrolled.memberToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ action: 'stop' })
    });
    assert.equal(denied.status, 401);

    let received = null;
    const socket = io(base, {
      auth: { role: 'member', token: enrolled.memberToken },
      reconnection: false,
      timeout: 4000
    });
    socket.on('control', (payload, ack) => {
      received = payload;
      ack({ ok: true });
    });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    const stopped = await fetch(`${base}/api/admin/members/${enrolled.machineId}/command`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token-test-value',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ action: 'stop' })
    });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).action, 'stop');
    assert.deepEqual(received, { action: 'stop' });
    assert.equal(server.members.list().some((member) => member.machineId === enrolled.machineId), true);
    socket.close();
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a teammate socket can publish a frame only after it enrolls', async () => {
  const { server, dataDir, base } = await listen();
  try {
    const enrolled = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Desk' })
    })).json();

    const denied = io(base, {
      auth: { role: 'member', token: 'nope' },
      reconnection: false,
      timeout: 4000
    });
    await new Promise((resolve, reject) => {
      denied.on('connect_error', () => resolve());
      denied.on('connect', () => reject(new Error('unauthorized socket was accepted')));
    });
    denied.close();

    const socket = io(base, {
      auth: { role: 'member', token: enrolled.memberToken },
      reconnection: false,
      timeout: 4000
    });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    const frame = new Promise((resolve) => server.events.once('frame', resolve));
    const renamed = new Promise((resolve) => {
      const onMembers = (list) => {
        const row = list.find((item) => item.machineId === enrolled.machineId);
        if (row && row.hostname === 'Alex') {
          server.events.off('members', onMembers);
          resolve(row);
        }
      };
      server.events.on('members', onMembers);
    });
    socket.emit('hello', { hostname: 'Alex', displays: [{ index: 0, width: 1920, height: 1080 }, { index: 1, width: 1920, height: 1080 }] });
    const named = await renamed;
    assert.equal(named.hostname, 'Alex');
    assert.equal(named.displays.length, 2);
    assert.equal(named.displays[1].index, 1);
    socket.emit('frame', { displayIndex: 1, width: 480, height: 270 }, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const received = await frame;
    assert.equal(received.machineId, enrolled.machineId);
    assert.equal(received.displayIndex, 1);

    const held = new Promise((resolve) => {
      const onMembers = (list) => {
        const row = list.find((item) => item.machineId === enrolled.machineId);
        if (row && row.holdNetwork) {
          server.events.off('members', onMembers);
          resolve(row);
        }
      };
      server.events.on('members', onMembers);
    });
    socket.emit('presence', { capture: 'recording', pendingSegments: 2, holdNetwork: true });
    const hold = await held;
    assert.equal(hold.holdNetwork, true);
    assert.equal(hold.pendingSegments, 2);
    socket.close();
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('admin quality settings persist and are sent on the teammate profile', async () => {
  const { server, dataDir, base } = await listen();
  try {
    const enrolled = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'Desk' })
    })).json();

    const socket = io(base, {
      auth: { role: 'member', token: enrolled.memberToken },
      reconnection: false,
      timeout: 4000
    });
    const firstProfile = new Promise((resolve) => socket.once('profile', resolve));
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    const first = await firstProfile;
    assert.equal(first.liveQuality, 'low');
    assert.equal(first.gridWidth, 640);
    assert.equal(first.focusWidth, 1280);
    assert.equal(first.jpegQuality, 70);
    assert.equal(first.liveIntervalMs, 500);
    assert.equal(first.tileIntervalMs, 1000);
    assert.equal(first.recordFps, 10);
    assert.equal(first.recordWidth, 1920);
    assert.equal(first.segmentMinutes, 1);
    assert.equal(first.segmentMs, 60 * 1000);

    const nextProfile = new Promise((resolve) => socket.once('profile', resolve));
    const saved = server.setQuality({ liveQuality: 'ultra', recordFps: 15, recordWidth: 2560, segmentMinutes: 5 });
    assert.equal(saved.liveQuality, 'ultra');
    assert.equal(saved.recordFps, 15);
    assert.equal(saved.segmentMinutes, 5);
    const updated = await nextProfile;
    assert.equal(updated.liveQuality, 'ultra');
    assert.equal(updated.jpegQuality, 95);
    assert.equal(updated.recordWidth, 2560);
    assert.equal(updated.recordFps, 15);
    assert.equal(updated.segmentMinutes, 5);
    assert.equal(updated.segmentMs, 5 * 60 * 1000);

    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'quality.json'), 'utf8'));
    assert.equal(disk.liveQuality, 'ultra');
    assert.equal(disk.recordFps, 15);
    assert.equal(disk.recordWidth, 2560);
    assert.equal(disk.segmentMinutes, 5);
    socket.close();
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('grid, save period, and archive folder persist', async () => {
  const { server, dataDir } = await listen();
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-archive-'));
  try {
    const saved = server.setSettings({
      grid: '3x3',
      retentionDays: 30,
      archiveDir: custom
    });
    assert.equal(saved.grid, '3x3');
    assert.equal(saved.gridCols, 3);
    assert.equal(saved.retentionDays, 30);
    assert.equal(saved.archivePreset, 'custom');
    assert.equal(path.resolve(saved.archivePath), path.resolve(custom));
    assert.equal(server.retentionDays, 30);
    assert.equal(path.resolve(server.archive.root), path.resolve(custom));

    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'quality.json'), 'utf8'));
    assert.equal(disk.grid, '3x3');
    assert.equal(disk.retentionDays, 30);
    assert.equal(path.resolve(disk.archiveDir), path.resolve(custom));

    const back = server.setSettings({ grid: '2x3', archiveDir: '' });
    assert.equal(back.grid, '2x3');
    assert.equal(back.gridCols, 2);
    assert.equal(back.gridRows, 3);
    assert.equal(back.retentionDays, 30);
    assert.equal(back.archivePreset, 'default');
    assert.equal(path.resolve(server.archive.root), path.resolve(path.join(dataDir, 'archive')));
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(custom, { recursive: true, force: true });
  }
});
