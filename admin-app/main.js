'use strict';

const { app, BrowserWindow, ipcMain, clipboard, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { spawn } = require('child_process');

app.setName('Team Monitor Admin');
app.setAppUserModelId('com.gange.teammonitor.admin');

const { startTeamServer } = loadLib('server');
const { loadOrCreateAdminToken } = loadLib('token');
const { memberTiles, seekWithin } = loadLib('review');
const { DEFAULT_PORT } = loadLib('protocol');
const { applyAutoStart } = loadLib('autostart');
const { isLocalAddress } = loadLib('localnet');

function loadLib(name) {
  const packaged = __dirname.includes('app.asar');
  const target = packaged
    ? path.join(__dirname, 'lib', name)
    : path.join(__dirname, '..', 'lib', name);
  return require(target);
}

let mainWindow = null;
let tray = null;
let quitting = false;
let server = null;
let preferredPort = DEFAULT_PORT;
let firewall = { ok: false, detail: 'not applied' };

function pngChunk(type, data) {
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

function trayIcon() {
  const size = 16;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size / 2 - 0.5;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const cx = x - size / 2 + 0.5;
      const cy = y - size / 2 + 0.5;
      const inside = (cx * cx) + (cy * cy) <= radius * radius;
      const i = row + 1 + x * 4;
      raw[i] = 106;
      raw[i + 1] = 163;
      raw[i + 2] = 255;
      raw[i + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return nativeImage.createFromBuffer(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]));
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray || process.env.TEAM_MONITOR_HEADLESS === '1') return;
  tray = new Tray(trayIcon());
  tray.setToolTip('Team Monitor Admin');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Team Monitor Admin', click: () => showWindow() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]));
  tray.on('click', () => showWindow());
}

function dataDir() {
  if (process.env.TEAM_MONITOR_DATA_DIR) return process.env.TEAM_MONITOR_DATA_DIR;
  return path.join(app.getPath('userData'), 'data');
}

const LAN_REMOTE_IPS = [
  '127.0.0.1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16'
].join(',');

function lanAddresses() {
  const results = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((info) => {
      const ipv4 = info.family === 'IPv4' || info.family === 4;
      if (ipv4 && !info.internal && isLocalAddress(info.address)) {
        results.push({ name, address: info.address });
      }
    });
  });
  return results;
}

function runNetsh(args) {
  return new Promise((resolve) => {
    const child = spawn('netsh', args, { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('exit', (code) => resolve({ code, output }));
  });
}

function runElevatedNetsh(args) {
  return new Promise((resolve) => {
    const listed = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(',');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      `try { $p = Start-Process -FilePath netsh -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @(${listed}); if ($null -eq $p) { exit 1 }; exit $p.ExitCode } catch { exit 1 }`
    ], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('exit', (code) => resolve({ code, output }));
  });
}

async function firewallRuleExists(name) {
  const shown = await runNetsh(['advfirewall', 'firewall', 'show', 'rule', `name=${name}`]);
  return shown.code === 0 && /Enabled:/i.test(shown.output) && !/No rules match/i.test(shown.output);
}

async function openFirewall(port) {
  if (process.platform !== 'win32' || process.env.TEAM_MONITOR_SKIP_FIREWALL) {
    return { ok: false, detail: 'Firewall rule was not added. Teammates on this LAN may still connect if Windows already allows the port.' };
  }
  const name = `Team Monitor Admin ${port}`;
  const addArgs = [
    'advfirewall', 'firewall', 'add', 'rule',
    `name=${name}`,
    'dir=in',
    'action=allow',
    'protocol=TCP',
    `localport=${port}`,
    'profile=any',
    `remoteip=${LAN_REMOTE_IPS}`
  ];
  if (await firewallRuleExists(name)) {
    return { ok: true, detail: 'Other PCs on the local network can reach this admin. Internet addresses stay blocked.' };
  }
  let added = await runNetsh(addArgs);
  if (added.code !== 0) added = await runElevatedNetsh(addArgs);
  if (added.code === 0 || await firewallRuleExists(name)) {
    return { ok: true, detail: 'Other PCs on the local network can reach this admin. Internet addresses stay blocked.' };
  }
  return {
    ok: false,
    detail: 'Windows blocked other PCs. Restart Admin and approve the permission prompt, or allow TCP 3921 in Windows Firewall.'
  };
}

function sendMembers() {
  if (!mainWindow || !server) return;
  mainWindow.webContents.send('members', memberTiles(server.members.list()));
}

function createWindow() {
  const show = process.env.TEAM_MONITOR_HEADLESS !== '1';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show,
    backgroundColor: '#07090f',
    autoHideMenuBar: true,
    title: 'Team Monitor Admin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', (event) => {
    if (quitting || process.env.TEAM_MONITOR_HEADLESS === '1') return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openServer(directory, adminToken, preferred) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await startTeamServer({ dataDir: directory, adminToken, port: preferred });
    } catch (error) {
      lastError = error;
      if (!error || error.code !== 'EADDRINUSE') throw error;
      await wait(400);
    }
  }
  if (process.env.TEAM_MONITOR_HEADLESS === '1') {
    return startTeamServer({ dataDir: directory, adminToken, port: 0 });
  }
  const busy = new Error(`Port ${preferred} is already in use. Close the other Team Monitor Admin window, then open this one again.`);
  busy.code = 'EADDRINUSE';
  throw busy;
}

async function boot() {
  applyAutoStart(app, { hidden: false, aumid: 'com.gange.teammonitor.admin' });
  const directory = dataDir();
  fs.mkdirSync(directory, { recursive: true });
  const adminToken = loadOrCreateAdminToken(path.join(directory, 'admin-token.txt'));
  const preferred = Number(process.env.PORT) || DEFAULT_PORT;
  preferredPort = preferred;
  try {
    server = await openServer(directory, adminToken, preferred);
  } catch (error) {
    if (error && error.code === 'EADDRINUSE' && process.env.TEAM_MONITOR_HEADLESS !== '1') {
      dialog.showErrorBox('Team Monitor Admin', error.message);
    }
    throw error;
  }
  firewall = await openFirewall(server.port);
  server.events.on('members', sendMembers);
  server.events.on('frame', (frame) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('frame', frame);
    }
  });
  if (process.env.TEAM_MONITOR_STATUS_FILE) {
    fs.writeFileSync(process.env.TEAM_MONITOR_STATUS_FILE, JSON.stringify({
      port: server.port,
      token: server.adminToken,
      dataDir: directory
    }));
  }
  createWindow();
  createTray();
}

ipcMain.handle('bootstrap', () => ({
  port: server.port,
  preferredPort,
  addresses: lanAddresses(),
  retentionDays: server.retentionDays,
  firewall,
  quality: server.getQuality(),
  members: memberTiles(server.members.list())
}));

ipcMain.handle('archive-disk', () => server.diskStatus());

ipcMain.handle('remove-member', (_event, machineId) => {
  const removed = server.removeMember(machineId);
  return { ok: removed };
});

ipcMain.handle('command-member', async (_event, payload) => {
  try {
    return await server.commandMember(payload && payload.machineId, payload && payload.action);
  } catch (error) {
    return { ok: false, error: error.message || 'Could not reach that teammate.' };
  }
});

ipcMain.handle('set-quality', (_event, payload) => server.setQuality(payload));

ipcMain.handle('choose-archive-dir', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: 'Save recordings here',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return { path: null };
    return { path: result.filePaths[0] };
  } catch (error) {
    return { path: null, error: error.message || 'Could not open the folder picker.' };
  }
});

ipcMain.handle('set-watch', (_event, payload) => {
  const machineId = payload && payload.machineId ? payload.machineId : null;
  const displayIndex = payload && payload.displayIndex;
  server.setFocus(machineId, displayIndex);
  return { ok: true };
});

ipcMain.handle('recordings', (_event, query) => {
  try {
    return {
      segments: server.archive.listSegments({
        machineId: query.machineId,
        date: query.date,
        displayIndex: query.displayIndex
      })
    };
  } catch (error) {
    return { segments: [], error: error.message };
  }
});

ipcMain.handle('activity', (_event, query) => {
  try {
    return { events: server.archive.listActivity(query.machineId, query.date) };
  } catch (error) {
    return { events: [], error: error.message };
  }
});

ipcMain.handle('load-segment', (_event, segmentId) => {
  const found = server.archive.readSegment(segmentId);
  if (!found) return null;
  return found.buffer;
});

ipcMain.handle('find-segment', (_event, query) => {
  try {
    const segment = server.archive.findCovering(query.machineId, query.displayIndex, query.at);
    if (!segment) return null;
    return { segment, seek: seekWithin(segment, query.at) };
  } catch (_error) {
    return null;
  }
});

ipcMain.handle('copy', (_event, text) => {
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}

app.on('before-quit', () => {
  quitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (server) {
    void server.close();
    server = null;
  }
});
