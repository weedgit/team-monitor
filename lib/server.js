'use strict';

const http = require('http');
const fs = require('fs');
const express = require('express');
const { Server } = require('socket.io');
const { EventEmitter } = require('events');
const path = require('path');
const { Archive } = require('./archive');
const { MemberStore } = require('./members');
const { tokenEqual, loadOrCreateAdminToken, newToken } = require('./token');
const { MAX_MEMBERS, MIN_FREE_BYTES, normalizeQuality, qualityProfile } = require('./protocol');
const { isLocalAddress } = require('./localnet');

function bearer(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : '';
}

function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : (value || '');
}

async function startTeamServer(options) {
  const dataDir = options.dataDir;
  const adminToken = options.adminToken || loadOrCreateAdminToken(path.join(dataDir, 'admin-token.txt'));
  const members = new MemberStore(path.join(dataDir, 'members.json'), {
    maxMembers: options.maxMembers || MAX_MEMBERS
  });
  const minFreeBytes = Number.isFinite(Number(options.minFreeBytes))
    ? Number(options.minFreeBytes)
    : MIN_FREE_BYTES;
  const events = new EventEmitter();
  events.setMaxListeners(30);
  const focus = { machineId: null, displayIndex: 0 };
  const socketsByMachine = new Map();
  const lastFrameAt = new Map();
  const qualityFile = path.join(dataDir, 'quality.json');
  const defaultArchiveDir = path.join(dataDir, 'archive');

  function readPersisted() {
    try {
      return JSON.parse(fs.readFileSync(qualityFile, 'utf8'));
    } catch (_error) {
      return {};
    }
  }

  function sameDir(left, right) {
    return path.resolve(left).replace(/\\/g, '/').toLowerCase()
      === path.resolve(right).replace(/\\/g, '/').toLowerCase();
  }

  function safeArchiveDir(requested) {
    const raw = String(requested || '').trim();
    if (!raw) return { root: defaultArchiveDir, error: '' };
    const resolved = path.resolve(raw);
    try {
      fs.mkdirSync(resolved, { recursive: true });
      fs.accessSync(resolved, fs.constants.W_OK);
      return { root: resolved, error: '' };
    } catch (_error) {
      return {
        root: archive ? archive.root : defaultArchiveDir,
        error: 'That folder cannot be used. Recordings stay in the current location.'
      };
    }
  }

  const persisted = readPersisted();
  let settings = normalizeQuality({
    ...persisted,
    retentionDays: options.retentionDays || persisted.retentionDays
  });
  let retentionDays = settings.retentionDays;
  let archive = null;
  let archiveError = '';
  const initialArchive = safeArchiveDir(settings.archiveDir);
  archiveError = initialArchive.error;
  archive = new Archive(initialArchive.root);
  members.identities().forEach((row) => archive.saveIdentity(row));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    if (!isLocalAddress(req.socket && req.socket.remoteAddress)) {
      res.status(403).json({ error: 'local network only' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  function emitMembers() {
    events.emit('members', members.list());
  }

  function freeBytes(dir) {
    try {
      const stats = fs.statfsSync(dir);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (_error) {
      return null;
    }
  }

  function diskStatus() {
    const free = freeBytes(archive ? archive.root : defaultArchiveDir);
    return {
      freeGb: free == null ? null : Math.round((free / (1024 ** 3)) * 10) / 10,
      diskLow: free != null && free < minFreeBytes
    };
  }

  function requireAdmin(req, res) {
    if (tokenEqual(bearer(req), adminToken)) return true;
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }

  function memberFromRequest(req, res) {
    const member = members.byToken(bearer(req));
    if (member) return member;
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'team-monitor' });
  });

  app.get('/', (_req, res) => {
    res.json({ ok: true, service: 'team-monitor' });
  });

  function dropMembers(ids) {
    (ids || []).forEach((machineId) => {
      const socket = socketsByMachine.get(machineId);
      if (socket) socket.disconnect(true);
      socketsByMachine.delete(machineId);
      if (focus.machineId === machineId) {
        focus.machineId = null;
        focus.displayIndex = 0;
      }
    });
  }

  app.post('/api/enroll', (req, res) => {
    try {
      const pcId = req.body && req.body.pcId;
      const machineId = req.body && req.body.machineId;
      let remembered = archive.findIdentity(pcId);
      if (!remembered && machineId) remembered = archive.readIdentity(machineId);
      if (!remembered && archive.hasMachine(machineId)) {
        remembered = { machineId, memberToken: newToken(), pcId };
      }
      const member = members.enroll({
        hostname: req.body && req.body.hostname,
        pcId,
        machineId,
        remembered
      });
      archive.saveIdentity(member);
      emitMembers();
      res.json({
        machineId: member.machineId,
        memberToken: member.memberToken,
        hostname: member.hostname
      });
    } catch (error) {
      res.status(error.status || 500).json({
        error: error.status ? error.message : 'server error'
      });
    }
  });

  app.post('/api/leave', (req, res) => {
    const member = memberFromRequest(req, res);
    if (!member) return;
    members.remove(member.machineId);
    dropMembers([member.machineId]);
    emitMembers();
    res.json({ ok: true });
  });

  app.post('/api/segments', express.raw({ type: '*/*', limit: '512mb' }), (req, res) => {
    const member = memberFromRequest(req, res);
    if (!member) return;
    const incoming = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const free = freeBytes(archive.root);
    if (free != null && free - incoming.length < minFreeBytes) {
      res.status(507).json({ error: 'Admin disk is low. This recording stays on the teammate PC.' });
      return;
    }
    try {
      const saved = archive.saveSegment({
        machineId: member.machineId,
        segmentId: header(req, 'x-segment-id'),
        displayIndex: header(req, 'x-display-index'),
        startedAt: header(req, 'x-started-at'),
        endedAt: header(req, 'x-ended-at'),
        frameCount: header(req, 'x-frame-count'),
        width: header(req, 'x-width'),
        height: header(req, 'x-height'),
        hostname: member.hostname,
        buffer: incoming
      });
      res.json({ ok: true, duplicate: saved.duplicate, segmentId: saved.segmentId });
    } catch (error) {
      const status = /invalid|empty/.test(error.message) ? 400 : 500;
      res.status(status).json({ error: status === 400 ? error.message : 'server error' });
    }
  });

  app.post('/api/activity', (req, res) => {
    const member = memberFromRequest(req, res);
    if (!member) return;
    try {
      const accepted = archive.appendActivity(member.machineId, req.body && req.body.events, member.hostname);
      res.json({ ok: true, accepted });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/admin/members', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ members: members.list(), retentionDays });
  });

  app.post('/api/admin/members/:machineId/remove', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!removeMember(req.params.machineId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/admin/members/:machineId/command', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const result = await commandMember(req.params.machineId, req.body && req.body.action);
      res.json(result);
    } catch (error) {
      res.status(error.status || 500).json({
        error: error.status ? error.message : 'server error'
      });
    }
  });

  app.get('/api/admin/recordings', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({
        segments: archive.listSegments({
          machineId: req.query.machineId,
          date: req.query.date,
          displayIndex: req.query.displayIndex
        })
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/admin/activity', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({
        events: archive.listActivity(req.query.machineId, req.query.date)
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/admin/segments/:segmentId', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const found = archive.readSegment(req.params.segmentId);
      if (!found) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.setHeader('content-type', 'video/mp4');
      res.send(found.buffer);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.use((error, _req, res, _next) => {
    if (error && error.type === 'entity.too.large') {
      res.status(413).json({ error: 'upload too large' });
      return;
    }
    res.status(500).json({ error: 'server error' });
  });

  const httpServer = http.createServer(app);
  const openSockets = new Set();
  httpServer.on('connection', (socket) => {
    if (!isLocalAddress(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  const io = new Server(httpServer, {
    maxHttpBufferSize: 12e6,
    cors: { origin: false }
  });

  function profileFor(machineId) {
    const focused = focus.machineId === machineId;
    return qualityProfile(focused ? focus.displayIndex : null, settings);
  }

  function sendProfile(machineId) {
    const socket = socketsByMachine.get(machineId);
    if (socket) socket.emit('profile', profileFor(machineId));
  }

  function broadcastProfiles() {
    socketsByMachine.forEach((_socket, id) => sendProfile(id));
  }

  function setFocus(machineId, displayIndex) {
    focus.machineId = machineId || null;
    focus.displayIndex = Number.isInteger(Number(displayIndex)) ? Number(displayIndex) : 0;
    broadcastProfiles();
  }

  function publicSettings() {
    const usingDefault = sameDir(archive.root, defaultArchiveDir);
    return {
      ...settings,
      archiveDir: usingDefault ? '' : archive.root,
      archivePath: archive.root,
      archivePreset: usingDefault ? 'default' : 'custom',
      archiveError,
      ...diskStatus()
    };
  }

  function commandMember(machineId, action) {
    if (action !== 'stop' && action !== 'uninstall') {
      const error = new Error('Unknown command.');
      error.status = 400;
      throw error;
    }
    if (!members.byId(machineId)) {
      const error = new Error('not found');
      error.status = 404;
      throw error;
    }
    const socket = socketsByMachine.get(machineId);
    if (!socket) {
      const error = new Error('This teammate is offline.');
      error.status = 409;
      throw error;
    }
    return new Promise((resolve, reject) => {
      socket.timeout(8000).emit('control', { action }, (timedOut, result) => {
        if (timedOut || !result || !result.ok) {
          const failure = new Error((result && result.error) || 'This teammate did not respond.');
          failure.status = 409;
          reject(failure);
          return;
        }
        resolve({ ok: true, action });
      });
    });
  }

  function removeMember(machineId) {
    const removed = members.remove(machineId);
    if (!removed) return false;
    dropMembers([machineId]);
    emitMembers();
    return true;
  }

  function persistSettings() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(qualityFile, `${JSON.stringify({
      liveQuality: settings.liveQuality,
      recordFps: settings.recordFps,
      recordWidth: settings.recordWidth,
      segmentMinutes: settings.segmentMinutes,
      grid: settings.grid,
      retentionDays: settings.retentionDays,
      archiveDir: settings.archiveDir
    }, null, 2)}\n`);
  }

  function setSettings(next) {
    const previous = settings;
    settings = normalizeQuality({ ...settings, ...next });
    retentionDays = settings.retentionDays;
    const picked = safeArchiveDir(settings.archiveDir);
    archiveError = picked.error;
    if (!picked.error) {
      settings.archiveDir = sameDir(picked.root, defaultArchiveDir) ? '' : picked.root;
      if (!sameDir(picked.root, archive.root)) {
        archive = new Archive(picked.root);
        members.identities().forEach((row) => archive.saveIdentity(row));
      }
    } else {
      settings.archiveDir = sameDir(archive.root, defaultArchiveDir) ? '' : archive.root;
    }
    persistSettings();
    const qualityChanged = previous.liveQuality !== settings.liveQuality
      || previous.recordFps !== settings.recordFps
      || previous.recordWidth !== settings.recordWidth
      || previous.segmentMinutes !== settings.segmentMinutes;
    if (qualityChanged) broadcastProfiles();
    archive.prune(retentionDays);
    return publicSettings();
  }

  function setQuality(next) {
    return setSettings(next);
  }

  io.use((socket, next) => {
    const peer = socket.handshake.address
      || (socket.request && socket.request.socket && socket.request.socket.remoteAddress);
    if (!isLocalAddress(peer)) {
      next(new Error('local network only'));
      return;
    }
    const auth = socket.handshake.auth || {};
    if (auth.role === 'admin' && tokenEqual(auth.token, adminToken)) {
      socket.data.role = 'admin';
      return next();
    }
    if (auth.role === 'member') {
      const member = members.byToken(auth.token);
      if (member) {
        socket.data.role = 'member';
        socket.data.machineId = member.machineId;
        return next();
      }
    }
    next(new Error('unauthorized'));
  });

  io.on('connection', (socket) => {
    if (socket.data.role === 'admin') {
      socket.emit('members', members.list());
      return;
    }

    const machineId = socket.data.machineId;
    const previous = socketsByMachine.get(machineId);
    if (previous && previous !== socket) previous.disconnect(true);
    socketsByMachine.set(machineId, socket);
    const joined = members.byId(machineId);
    members.update(machineId, { online: true, lastSeen: new Date().toISOString() });
    const removed = members.takeStale({
      pcId: joined && joined.pcId,
      keepId: machineId
    });
    dropMembers(removed);
    emitMembers();
    sendProfile(machineId);

    function parseDisplays(list) {
      const displays = Array.isArray(list) ? list.slice(0, 16) : [];
      return displays.map((display, index) => ({
        index: Number.isInteger(Number(display && display.index)) ? Number(display.index) : index,
        width: Number(display && display.width) || 0,
        height: Number(display && display.height) || 0,
        id: String(display && display.id || '')
      })).filter((display) => display.index >= 0 && display.index <= 15);
    }

    socket.on('hello', (payload) => {
      const patch = { displays: parseDisplays(payload && payload.displays), lastSeen: new Date().toISOString() };
      if (payload && payload.hostname) {
        patch.hostname = String(payload.hostname).replace(/[\r\n]/g, ' ').slice(0, 64);
      }
      members.update(machineId, patch);
      emitMembers();
    });

    socket.on('presence', (payload) => {
      const capture = String(payload && payload.capture || '');
      const allowed = new Set(['recording', 'paused-disk', 'locked', 'stopped', 'offline']);
      const patch = {
        capture: allowed.has(capture) ? capture : 'recording',
        pendingSegments: Math.max(0, Number(payload && payload.pendingSegments) || 0),
        holdNetwork: Boolean(payload && payload.holdNetwork),
        lastSeen: new Date().toISOString(),
        online: true
      };
      if (Array.isArray(payload && payload.displays) && payload.displays.length) {
        patch.displays = parseDisplays(payload.displays);
      }
      members.update(machineId, patch);
      emitMembers();
    });

    socket.on('frame', (meta, jpeg) => {
      const displayIndex = Number(meta && meta.displayIndex);
      if (!Number.isInteger(displayIndex) || displayIndex < 0 || displayIndex > 15) return;
      const buffer = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(jpeg || []);
      if (buffer.length < 4 || buffer.length > 8_000_000) return;
      const key = `${machineId}:${displayIndex}`;
      const now = Date.now();
      if (now - (lastFrameAt.get(key) || 0) < 40) return;
      lastFrameAt.set(key, now);
      members.update(machineId, { lastSeen: new Date(now).toISOString(), online: true }, { persist: false });
      events.emit('frame', {
        machineId,
        displayIndex,
        jpeg: buffer,
        width: Number(meta && meta.width) || 0,
        height: Number(meta && meta.height) || 0,
        at: now
      });
    });

    socket.on('disconnect', () => {
      if (socketsByMachine.get(machineId) === socket) {
        socketsByMachine.delete(machineId);
        members.update(machineId, { online: false });
        emitMembers();
      }
    });
  });

  archive.prune(retentionDays);
  const pruneTimer = setInterval(() => archive.prune(retentionDays), 60 * 60 * 1000);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

  try {
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(options.port ?? 0, '0.0.0.0', () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(pruneTimer);
    io.close();
    httpServer.close();
    throw error;
  }

  async function close() {
    clearInterval(pruneTimer);
    io.close();
    for (const socket of openSockets) socket.destroy();
    if (httpServer.listening) {
      await new Promise((resolve) => httpServer.close(() => resolve()));
    }
  }

  return {
    port: httpServer.address().port,
    adminToken,
    get archive() { return archive; },
    members,
    events,
    get retentionDays() { return retentionDays; },
    setFocus,
    getQuality: () => publicSettings(),
    getSettings: () => publicSettings(),
    setQuality,
    setSettings,
    removeMember,
    commandMember,
    diskStatus,
    close
  };
}

module.exports = { startTeamServer };
