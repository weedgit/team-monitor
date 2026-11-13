'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, desktopCapturer, powerMonitor
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const { io } = require('socket.io-client');

app.setName('Team Monitor Teammate');
app.setAppUserModelId('com.gange.teammonitor.teammate');

const { SegmentRecorder } = loadLib('recorder');
const { Outbox } = loadLib('outbox');
const { enrollRequest, leaveRequest, syncOnce, resolveLocalServerUrl } = loadLib('sync');
const { localDnsLookup, LOCAL_ONLY } = loadLib('localnet');
const { displayIndexForWindow } = loadLib('activity');
const { newEventId } = loadLib('token');
const { RECORD_WIDTH, GRID_WIDTH, FOCUS_WIDTH, MIN_FREE_BYTES, DEFAULT_QUALITY } = loadLib('protocol');
const { applyAutoStart, clearAutoStart, startedHidden } = loadLib('autostart');
const { uninstallTargetFromReg, uninstallKeysFromSearch } = loadLib('uninstall');
const { pauseFlag, allowUninstallFlag, writeFlag, removeFlag, installGuard, clearGuard } = loadLib('guard');
const { startCaptureLoop } = require('./capture');
const { overlayPointer } = require('./pointer');

function loadLib(name) {
  const packaged = __dirname.includes('app.asar');
  const target = packaged
    ? path.join(__dirname, 'lib', name)
    : path.join(__dirname, '..', 'lib', name);
  return require(target);
}

let mainWindow = null;
let tray = null;
let config = { serverUrl: '', machineId: '', memberToken: '', displayName: '', holdNetwork: false };
let outbox = null;
let recorder = null;
let stopCapture = null;
let socket = null;
let profile = { focusDisplay: null, ...DEFAULT_QUALITY };
let displays = [];
let online = false;
let captureState = 'stopped';
let lastError = '';
let captureError = '';
let screenLocked = false;
let lastActivityKey = '';
let quitting = false;
let workersStarted = false;
let enrolling = false;
let rejoining = false;
let rejoinAttempts = 0;
let sendNextLive = false;
let syncing = false;
let syncAgain = false;
let activityChild = null;
let activityStdout = '';
let activityBusy = false;
const timers = [];

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return { serverUrl: '', machineId: '', memberToken: '', displayName: '', holdNetwork: false, ...parsed };
    }
  } catch (_error) { /* first run */ }
  return { serverUrl: '', machineId: '', memberToken: '', displayName: '', holdNetwork: false };
}

function holdNetwork() {
  return Boolean(config.holdNetwork);
}

function setHoldNetwork(on) {
  saveConfig({ ...config, holdNetwork: Boolean(on) });
  sendPresence();
  pushStatus();
  if (!holdNetwork()) void runSync();
  return holdNetwork();
}

function sanitizeName(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').trim().slice(0, 64);
}

function displayName() {
  return sanitizeName(config.displayName) || os.hostname();
}

function identityFile() {
  return path.join(app.getPath('appData'), 'Team Monitor', 'teammate-id.json');
}

function readStableId() {
  try {
    const parsed = JSON.parse(fs.readFileSync(identityFile(), 'utf8'));
    if (parsed && /^pc_[a-f0-9]{32}$/.test(String(parsed.pcId || ''))) return parsed;
  } catch (_error) { /* first run, or the file is not readable yet */ }
  return null;
}

function writeStableId(pcId, machineId) {
  if (!/^pc_[a-f0-9]{32}$/.test(String(pcId || ''))) return;
  const file = identityFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const previous = readStableId() || {};
  const next = {
    pcId,
    machineId: machineId || previous.machineId || ''
  };
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
  fs.renameSync(temporary, file);
}

function ensurePcId() {
  if (/^pc_[a-f0-9]{32}$/.test(String(config.pcId || ''))) {
    writeStableId(config.pcId, config.machineId);
    return config.pcId;
  }
  const stable = readStableId();
  if (stable) {
    saveConfig({
      ...config,
      pcId: stable.pcId,
      machineId: config.machineId || stable.machineId || ''
    });
    return stable.pcId;
  }
  const pcId = `pc_${crypto.randomBytes(16).toString('hex')}`;
  saveConfig({ ...config, pcId });
  writeStableId(pcId, config.machineId);
  return pcId;
}

function saveConfig(next) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const temporary = `${configPath()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
  fs.renameSync(temporary, configPath());
  config = next;
}

function freeBytes() {
  try {
    const stats = fs.statfsSync(app.getPath('userData'));
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (_error) {
    return null;
  }
}

function statusPayload() {
  const stats = outbox ? outbox.stats() : { pendingSegments: 0, pendingActivities: 0 };
  const free = freeBytes();
  return {
    enrolled: Boolean(config.memberToken),
    serverUrl: config.serverUrl || '',
    machineId: config.machineId || '',
    hostname: os.hostname(),
    displayName: displayName(),
    live: online,
    holdNetwork: holdNetwork(),
    capture: captureState,
    pendingSegments: stats.pendingSegments,
    pendingActivities: stats.pendingActivities,
    displays: displays.map((display) => ({
      index: display.index,
      width: display.width,
      height: display.height
    })),
    freeGb: free == null ? null : Math.round((free / (1024 ** 3)) * 10) / 10,
    lastError
  };
}

function pushStatus() {
  updateTray();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', statusPayload());
  }
}

function png(size, red, green, blue) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size / 2 - 0.5;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const cx = x - size / 2 + 0.5;
      const cy = y - size / 2 + 0.5;
      const inside = (cx * cx) + (cy * cy) <= radius * radius;
      const i = row + 1 + x * 4;
      raw[i] = red;
      raw[i + 1] = green;
      raw[i + 2] = blue;
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

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  let crc = 0xffffffff;
  const body = Buffer.concat([name, data]);
  for (let i = 0; i < body.length; i += 1) {
    crc ^= body[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([length, name, data, checksum]);
}

function updateTray() {
  if (!tray) return;
  const recording = captureState === 'recording';
  tray.setImage(nativeImage.createFromBuffer(png(16, recording ? 214 : 120, recording ? 69 : 128, recording ? 69 : 138)));
  const upload = statusPayload();
  let line = 'Not enrolled';
  if (config.memberToken) {
    if (captureState === 'paused-disk') line = 'Recording paused — disk is low';
    else if (captureState === 'locked') line = 'Paused — screen locked';
    else if (captureState === 'recording') line = 'Recording';
    else line = 'Not recording';
    if (holdNetwork()) line += ' — holding network';
    else if (!online) line += ' — admin unreachable';
    else if (upload.pendingSegments > 0) line += ` — ${upload.pendingSegments} to upload`;
    else line += ' — upload caught up';
  }
  tray.setToolTip(`Team Monitor — ${line}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Team Monitor', click: () => showWindow() },
    {
      label: 'Hold network',
      type: 'checkbox',
      checked: holdNetwork(),
      enabled: Boolean(config.memberToken),
      click: (item) => setHoldNetwork(item.checked)
    }
  ]));
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
  pushStatus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 700,
    show: false,
    backgroundColor: '#07090f',
    autoHideMenuBar: true,
    title: 'Team Monitor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function listDisplays() {
  return screen.getAllDisplays()
    .slice()
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((display, index) => ({
      index,
      id: String(display.id),
      width: display.size.width,
      height: display.size.height,
      scaleFactor: display.scaleFactor || 1,
      bounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height
      }
    }));
}

async function grab(width) {
  const current = listDisplays();
  const box = Math.max(320, Math.min(2560, Number(width) || 1280));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: box, height: box },
    fetchWindowIcons: false
  });
  let point = { x: Number.NaN, y: Number.NaN };
  try {
    point = screen.getCursorScreenPoint();
  } catch (_error) { /* keep going without a pointer */ }
  return current.map((display) => {
    let source = sources.find((item) => String(item.display_id) === display.id);
    if (!source) source = sources[display.index];
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
      return { display, image: null, signature: null, jpeg: null, width: 0, height: 0 };
    }
    const raw = source.thumbnail;
    const rawSize = raw.getSize();
    let signature = null;
    if (rawSize.width && rawSize.height) {
      const thumb = raw.resize({ width: 320, height: 180 });
      const bitmap = thumb.toBitmap();
      signature = bitmap.length ? bitmap : null;
    }
    const image = overlayPointer(raw, display, point, nativeImage);
    const size = image.getSize();
    return {
      display,
      image,
      signature,
      jpeg: null,
      width: size.width,
      height: size.height
    };
  });
}

function applyLogin() {
  applyAutoStart(app, {
    hidden: Boolean(config.memberToken),
    aumid: 'com.gange.teammonitor.teammate'
  });
}

async function connectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
  if (!config.memberToken || !config.serverUrl) return;
  let origin;
  try {
    origin = await resolveLocalServerUrl(config.serverUrl);
  } catch (_error) {
    online = false;
    lastError = LOCAL_ONLY;
    pushStatus();
    return;
  }
  socket = io(origin, {
    auth: { role: 'member', token: config.memberToken },
    reconnection: true,
    reconnectionDelay: 1000,
    timeout: 8000,
    maxHttpBufferSize: 12e6,
    lookup: localDnsLookup
  });
  socket.on('connect', () => {
    online = true;
    lastError = '';
    rejoinAttempts = 0;
    sendNextLive = true;
    sendHello();
    sendPresence();
    pushStatus();
  });
  socket.on('profile', (next) => {
    profile = next && typeof next === 'object'
      ? { ...DEFAULT_QUALITY, ...next }
      : { focusDisplay: null, ...DEFAULT_QUALITY };
    if (recorder) {
      recorder.configure({
        fps: profile.recordFps,
        crf: profile.recordCrf,
        segmentMs: profile.segmentMs
      });
    }
  });
  socket.on('disconnect', () => {
    online = false;
    pushStatus();
  });
  socket.on('control', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const action = payload && payload.action;
    if (action === 'stop') {
      reply({ ok: true });
      setTimeout(() => { void stopFromAdmin(); }, 300);
      return;
    }
    if (action === 'uninstall') {
      const target = findUninstaller();
      if (!target) {
        reply({ ok: false, error: 'This PC has no installer to remove. Use Stop to close the app.' });
        return;
      }
      reply({ ok: true });
      setTimeout(() => { void uninstallFromAdmin(target); }, 300);
      return;
    }
    reply({ ok: false, error: 'Unknown command.' });
  });
  socket.on('connect_error', (error) => {
    online = false;
    const message = String(error && error.message || '');
    if (/unauthorized/i.test(message) && rejoinAttempts < 1) {
      rejoinAttempts += 1;
      lastError = 'Reconnecting to the admin…';
      pushStatus();
      void rejoin();
      return;
    }
    lastError = /unauthorized/i.test(message)
      ? 'The admin does not recognize this PC yet. Connect again from this window.'
      : /ENOTLOCAL|local address|internet/i.test(message)
        ? LOCAL_ONLY
        : 'Reconnecting to the admin…';
    pushStatus();
  });
}

async function rejoin() {
  if (rejoining || enrolling || !config.serverUrl) return;
  const pcId = ensurePcId();
  if (!pcId && !config.machineId) return;
  rejoining = true;
  try {
    const result = await enrollRequest(config.serverUrl, displayName(), pcId, config.machineId);
    saveConfig({
      ...config,
      serverUrl: result.serverUrl,
      machineId: result.machineId,
      memberToken: result.memberToken,
      pcId
    });
    writeStableId(pcId, result.machineId);
    lastError = '';
    if (socket) {
      socket.removeAllListeners();
      socket.close();
      socket = null;
    }
    connectSocket();
  } catch (error) {
    lastError = error.message || 'Reconnecting to the admin…';
  } finally {
    rejoining = false;
    pushStatus();
  }
}

function displaysKey(list) {
  return (list || []).map((display) => `${display.index}:${display.id}:${display.width}x${display.height}`).join('|');
}

function setDisplays(next) {
  const list = Array.isArray(next) ? next : [];
  if (displaysKey(list) === displaysKey(displays)) {
    displays = list;
    return;
  }
  displays = list;
  sendHello();
  sendPresence();
  pushStatus();
}

function sendHello() {
  if (!socket || !socket.connected) return;
  socket.emit('hello', { hostname: displayName(), displays });
}

function sendPresence() {
  if (!socket || !socket.connected) return;
  const stats = outbox.stats();
  socket.emit('presence', {
    capture: captureState,
    pendingSegments: stats.pendingSegments,
    holdNetwork: holdNetwork(),
    displays
  });
}

async function runSync() {
  if (!config.memberToken || holdNetwork()) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    do {
      syncAgain = false;
      const result = await syncOnce({
        baseUrl: config.serverUrl,
        memberToken: config.memberToken,
        outbox
      });
      if (result.error) lastError = result.error;
      else if (result.online && (lastError.startsWith('Recording upload') || lastError.startsWith('Admin disk') || lastError.startsWith('A local recording'))) {
        lastError = '';
      }
      pushStatus();
    } while (syncAgain && config.memberToken && !holdNetwork());
  } finally {
    syncing = false;
  }
}

function diskPaused() {
  const free = freeBytes();
  return free != null && free < MIN_FREE_BYTES;
}

function foregroundScript() {
  const destination = path.join(app.getPath('userData'), 'foreground.ps1');
  const bundled = path.join(__dirname, 'foreground.ps1');
  fs.writeFileSync(destination, fs.readFileSync(bundled));
  return destination;
}

function acceptActivity(line) {
  activityBusy = false;
  try {
    const body = JSON.parse(String(line || '').replace(/^\uFEFF/, '').trim());
    const displayIndex = displayIndexForWindow(body, displays);
    const key = `${body.app}|${body.title}|${displayIndex}`;
    if (key === lastActivityKey) return;
    lastActivityKey = key;
    if (!outbox) return;
    outbox.enqueueActivity({
      id: newEventId(),
      at: new Date().toISOString(),
      app: body.app || 'unknown',
      title: body.title || '',
      displayIndex
    });
    pushStatus();
  } catch (_error) { /* the next sample asks again */ }
}

function ensureActivity() {
  if (activityChild && activityChild.exitCode == null) return activityChild;
  activityStdout = '';
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', foregroundScript()
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  activityChild = child;
  child.stdout.on('data', (chunk) => {
    activityStdout += chunk.toString('utf8');
    let newline = activityStdout.indexOf('\n');
    while (newline !== -1) {
      const line = activityStdout.slice(0, newline);
      activityStdout = activityStdout.slice(newline + 1);
      acceptActivity(line);
      newline = activityStdout.indexOf('\n');
    }
  });
  child.on('exit', () => {
    if (activityChild === child) activityChild = null;
    activityBusy = false;
  });
  return child;
}

function sampleActivity() {
  if (!config.memberToken || captureState === 'stopped') return;
  if (activityBusy) return;
  const child = ensureActivity();
  if (!child.stdin || !child.stdin.writable) return;
  activityBusy = true;
  try {
    child.stdin.write('\n');
  } catch (_error) {
    activityBusy = false;
  }
}

function stopActivity() {
  const child = activityChild;
  activityChild = null;
  activityBusy = false;
  activityStdout = '';
  if (!child) return;
  try { child.stdin.end(); } catch (_error) { /* already closed */ }
  try { child.kill(); } catch (_error) { /* already closed */ }
}

function setScreenLocked(locked) {
  screenLocked = locked;
  if (!workersStarted) return;
  captureState = locked ? 'locked' : (diskPaused() ? 'paused-disk' : 'recording');
  if (!locked) sendNextLive = true;
  sendPresence();
  pushStatus();
}

async function startWorkers() {
  if (workersStarted || !config.memberToken) {
    captureState = config.memberToken ? captureState : 'stopped';
    pushStatus();
    return;
  }
  workersStarted = true;
  const root = path.join(app.getPath('userData'), 'outbox');
  outbox = new Outbox(root);
  const ffmpegPath = String(require('ffmpeg-static') || '').replace('app.asar', 'app.asar.unpacked');
  recorder = new SegmentRecorder({
    ffmpegPath,
    directory: path.join(root, 'files'),
    segmentMs: Number(process.env.TEAM_MONITOR_SEGMENT_MS) || Number(profile.segmentMs) || 60 * 1000,
    fps: profile.recordFps,
    crf: profile.recordCrf,
    onSegment: async (segment) => outbox.enqueueSegment(segment),
    onError: (error) => {
      lastError = error.message || 'Recording failed.';
      pushStatus();
    }
  });
  if (!ffmpegPath) lastError = 'Video encoder is not installed.';
  captureState = screenLocked ? 'locked' : 'recording';
  stopCapture = startCaptureLoop({
    recordWidth: RECORD_WIDTH,
    gridWidth: GRID_WIDTH,
    focusWidth: FOCUS_WIDTH,
    grab,
    isLocked: () => screenLocked,
    isPaused: () => {
      const paused = diskPaused();
      captureState = paused ? 'paused-disk' : 'recording';
      return paused;
    },
    isOnline: () => Boolean(socket && socket.connected) && !holdNetwork(),
    forceLive: () => {
      const force = sendNextLive;
      sendNextLive = false;
      return force;
    },
    getProfile: () => profile,
    onDisplays: (next) => setDisplays(next),
    onRecord: (shot, at, changed) => {
      recorder.push(shot.display.index, changed ? shot.jpeg : null, at, {
        width: shot.width,
        height: shot.height,
        changed: Boolean(changed)
      });
    },
    onLive: (shot) => {
      if (holdNetwork() || !socket || !socket.connected) return;
      socket.emit('frame', {
        displayIndex: shot.display.index,
        width: shot.width,
        height: shot.height
      }, shot.jpeg);
    },
    onOk: () => {
      if (!captureError) return;
      if (lastError === captureError) lastError = '';
      captureError = '';
      pushStatus();
    },
    onError: (error) => {
      captureError = error.message || 'Screen capture failed.';
      lastError = captureError;
      pushStatus();
    }
  });
  setDisplays(listDisplays());
  await connectSocket();
  timers.push(setInterval(() => { void runSync(); }, 3000));
  timers.push(setInterval(() => sampleActivity(), 5000));
  timers.push(setInterval(() => {
    sendPresence();
    pushStatus();
  }, 2000));
  void runSync();
  pushStatus();
}

async function stopWorkers({ clearQueue }) {
  timers.splice(0).forEach((timer) => clearInterval(timer));
  stopActivity();
  if (stopCapture) stopCapture();
  stopCapture = null;
  if (recorder) {
    await recorder.stop();
    recorder = null;
  }
  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
  online = false;
  if (clearQueue && outbox) outbox.clearFiles();
  workersStarted = false;
  captureState = 'stopped';
  displays = [];
}

async function shutdown() {
  await stopWorkers({ clearQueue: false });
  if (config.memberToken && outbox) {
    await syncOnce({
      baseUrl: config.serverUrl,
      memberToken: config.memberToken,
      outbox
    }).catch(() => {});
  }
}

ipcMain.handle('status', () => statusPayload());

ipcMain.handle('enroll', async (_event, payload) => {
  if (enrolling) return { ok: false, error: 'Already connecting…' };
  enrolling = true;
  try {
    const name = sanitizeName(payload && payload.name) || os.hostname();
    const pcId = ensurePcId();
    const result = await enrollRequest(payload && payload.serverUrl, name, pcId, config.machineId);
    saveConfig({
      serverUrl: result.serverUrl,
      machineId: result.machineId,
      memberToken: result.memberToken,
      displayName: name,
      holdNetwork: false,
      pcId
    });
    writeStableId(pcId, result.machineId);
    lastError = '';
    applyLogin();
    await startWorkers();
    return { ok: true, machineId: result.machineId };
  } catch (error) {
    lastError = error.message;
    pushStatus();
    return { ok: false, error: error.message };
  } finally {
    enrolling = false;
  }
});

ipcMain.handle('set-name', (_event, name) => {
  const next = sanitizeName(name) || os.hostname();
  saveConfig({ ...config, displayName: next });
  sendHello();
  pushStatus();
  return { ok: true, displayName: next };
});

ipcMain.handle('set-hold-network', (_event, on) => {
  return { ok: true, holdNetwork: setHoldNetwork(on) };
});

function uninstallerFromKey(key) {
  const result = spawnSync('reg.exe', ['query', key, '/v', 'UninstallString'], {
    windowsHide: true,
    encoding: 'utf8'
  });
  const target = uninstallTargetFromReg(result.stdout || '');
  if (target && fs.existsSync(target.file)) return target;
  return null;
}

function findUninstaller() {
  if (process.platform === 'win32') {
    const listed = spawnSync('reg.exe', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      '/f',
      'Team Monitor Teammate',
      '/s'
    ], { windowsHide: true, encoding: 'utf8' });
    const keys = uninstallKeysFromSearch(listed.stdout || '');
    keys.push(
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.gange.teammonitor.teammate',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.gange.teammonitor.teammate',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.gange.teammonitor.teammate'
    );
    for (const key of keys) {
      const target = uninstallerFromKey(key);
      if (target) return target;
    }
  }
  if (app.isPackaged) {
    const beside = path.join(path.dirname(process.execPath), 'Uninstall Team Monitor Teammate.exe');
    if (fs.existsSync(beside)) return { file: beside, args: ['/S'] };
  }
  return null;
}

function scheduleUninstall(target) {
  const args = (target.args || ['/S']).filter((arg) => /^[/A-Za-z0-9_-]+$/.test(arg));
  const argList = (args.length ? args : ['/S']).map((arg) => `'${arg}'`).join(',');
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Sleep -Seconds 2; Start-Process -FilePath $env:TM_UNINSTALL -ArgumentList ${argList} -Verb RunAs`
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, TM_UNINSTALL: target.file }
  });
  child.unref();
}

async function quitFromAdmin() {
  if (quitting) return;
  quitting = true;
  await shutdown();
  app.quit();
}

async function stopFromAdmin() {
  try { writeFlag(pauseFlag()); } catch (_error) { /* still close; sign-in will start it again */ }
  await quitFromAdmin();
}

function armUninstall() {
  try { writeFlag(pauseFlag()); } catch (_error) { /* the uninstaller still removes the files */ }
  try { writeFlag(allowUninstallFlag()); } catch (_error) { /* Windows will block a manual uninstall */ }
  try { clearGuard(); } catch (_error) { /* autostart is cleared next */ }
}

async function uninstallFromAdmin(target) {
  armUninstall();
  scheduleUninstall(target);
  if (config.memberToken && config.serverUrl) {
    await leaveRequest(config.serverUrl, config.memberToken).catch(() => {});
  }
  clearAutoStart(app, { aumid: 'com.gange.teammonitor.teammate' });
  await quitFromAdmin();
}

function restoreGuard() {
  try { removeFlag(pauseFlag()); } catch (_error) { /* the next launch tries again */ }
  try { removeFlag(allowUninstallFlag()); } catch (_error) { /* a leftover flag only matters while this copy is closed */ }
  if (app.isPackaged) installGuard(process.execPath);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(async () => {
    config = loadConfig();
    applyLogin();
    restoreGuard();
    tray = new Tray(nativeImage.createFromBuffer(png(16, 120, 128, 138)));
    tray.on('click', () => showWindow());
    powerMonitor.on('lock-screen', () => setScreenLocked(true));
    powerMonitor.on('unlock-screen', () => setScreenLocked(false));
    let openedAtLogin = false;
    try { openedAtLogin = Boolean(app.getLoginItemSettings().wasOpenedAtLogin); } catch (_error) { /* show the window */ }
    createWindow();
    const hideWindow = Boolean(config.memberToken) && (startedHidden() || openedAtLogin);
    if (!hideWindow) mainWindow.show();
    await startWorkers();
    updateTray();
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  shutdown().finally(() => app.quit());
});
