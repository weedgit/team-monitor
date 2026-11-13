'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const electronPkg = path.join(__dirname, '..', 'admin-app', 'node_modules', 'electron');

test('admin app boots, enrolls a teammate, and stores an uploaded segment', { timeout: 90000, skip: !fs.existsSync(electronPkg) }, async () => {
  const electronPath = require(electronPkg);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-electron-'));
  const statusFile = path.join(dataDir, 'status.json');
  const child = spawn(electronPath, [path.join(__dirname, '..', 'admin-app')], {
    env: {
      ...process.env,
      TEAM_MONITOR_DATA_DIR: path.join(dataDir, 'archive-root'),
      TEAM_MONITOR_STATUS_FILE: statusFile,
      TEAM_MONITOR_HEADLESS: '1',
      TEAM_MONITOR_SKIP_FIREWALL: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });

  try {
    const status = await waitForJson(statusFile, () => logs);
    const base = `http://127.0.0.1:${status.port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal((await health.json()).ok, true);
    const enrolled = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: status.code, hostname: 'Electron-Test' })
    })).json();
    assert.match(enrolled.machineId, /^m_/);
    const denied = await fetch(`${base}/api/admin/members`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${base}/api/admin/members`, {
      headers: { authorization: `Bearer ${status.token}` }
    });
    const body = await allowed.json();
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0].hostname, 'Electron-Test');
  } finally {
    await killTree(child.pid);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function waitForJson(file, logs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer);
        resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
        return;
      }
      if (Date.now() - started > 60000) {
        clearInterval(timer);
        reject(new Error(`Admin app did not write a status file.\n${logs()}`));
      }
    }, 250);
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => resolve());
  });
}
