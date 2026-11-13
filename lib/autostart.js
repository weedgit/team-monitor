'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function startedHidden(argv = process.argv) {
  return argv.includes('--hidden') || argv.includes('--background');
}

function loginArgs(app, hidden) {
  const extra = hidden ? ['--hidden'] : [];
  if (app && app.isPackaged) return extra;
  const appPath = path.resolve(process.argv[1] || '.');
  return [appPath, ...extra];
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '')}"`;
}

function loginCommand(execPath, args) {
  return [quoteArg(execPath), ...(args || []).map(quoteArg)].join(' ');
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function writeWindowsRunKey(name, command, aumid) {
  const result = spawnSync('reg.exe', ['add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', command, '/f'], {
    windowsHide: true
  });
  if (aumid && aumid !== name) {
    spawnSync('reg.exe', ['delete', RUN_KEY, '/v', aumid, '/f'], { windowsHide: true });
  }
  return result.status === 0;
}

function removeStartupShortcut(name) {
  const root = process.env.APPDATA;
  if (!root || !name) return;
  const file = path.join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${name}.lnk`);
  try {
    if (fs.existsSync(file)) fs.rmSync(file);
  } catch (_error) { /* the registry entry is the one that launches the app */ }
}

function clearWindowsRunKey(name, aumid) {
  const result = spawnSync('reg.exe', ['delete', RUN_KEY, '/v', name, '/f'], { windowsHide: true });
  if (aumid && aumid !== name) {
    spawnSync('reg.exe', ['delete', RUN_KEY, '/v', aumid, '/f'], { windowsHide: true });
  }
  return result.status === 0;
}

function clearAutoStart(app, options = {}) {
  if (process.env.TEAM_MONITOR_SKIP_AUTOSTART === '1') return false;
  if (process.env.TEAM_MONITOR_HEADLESS === '1') return false;
  try {
    const name = app.getName();
    if (process.platform === 'win32') {
      removeStartupShortcut(name);
      return clearWindowsRunKey(name, options.aumid);
    }
    app.setLoginItemSettings({ openAtLogin: false, name });
    return true;
  } catch (_error) {
    return false;
  }
}

function applyAutoStart(app, options = {}) {
  if (process.env.TEAM_MONITOR_SKIP_AUTOSTART === '1') return false;
  if (process.env.TEAM_MONITOR_HEADLESS === '1') return false;
  try {
    const args = loginArgs(app, Boolean(options.hidden));
    const name = app.getName();
    if (process.platform === 'win32') {
      const command = loginCommand(process.execPath, args);
      removeStartupShortcut(name);
      return writeWindowsRunKey(name, command, options.aumid);
    }
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args,
      name
    });
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = { applyAutoStart, clearAutoStart, startedHidden, loginArgs, loginCommand };
