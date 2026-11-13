'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const electronPath = require(path.join(__dirname, '..', 'admin-app', 'node_modules', 'electron'));
const root = path.join(__dirname, '..');

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-smoke-'));
  const adminData = path.join(work, 'admin');
  const teammateData = path.join(work, 'teammate');
  const statusFile = path.join(work, 'status.json');
  fs.mkdirSync(adminData, { recursive: true });
  fs.mkdirSync(teammateData, { recursive: true });

  const admin = spawn(electronPath, [path.join(root, 'admin-app')], {
    env: {
      ...process.env,
      TEAM_MONITOR_DATA_DIR: adminData,
      TEAM_MONITOR_STATUS_FILE: statusFile,
      TEAM_MONITOR_HEADLESS: '1',
      TEAM_MONITOR_SKIP_FIREWALL: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let adminLog = '';
  admin.stdout.on('data', (chunk) => { adminLog += chunk; });
  admin.stderr.on('data', (chunk) => { adminLog += chunk; });

  try {
    const status = await waitForFile(statusFile, 60000);
    const base = `http://127.0.0.1:${status.port}`;
    const enrolled = await (await fetch(`${base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: status.code, hostname: 'Smoke-PC' })
    })).json();
    if (!enrolled.memberToken) throw new Error(`enroll failed: ${JSON.stringify(enrolled)}`);

    fs.writeFileSync(path.join(teammateData, 'config.json'), JSON.stringify({
      serverUrl: base,
      machineId: enrolled.machineId,
      memberToken: enrolled.memberToken
    }));

    const teammate = spawn(electronPath, [
      `--user-data-dir=${teammateData}`,
      path.join(root, 'teammate-app')
    ], {
      env: {
        ...process.env,
        TEAM_MONITOR_SEGMENT_MS: '4000'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let teammateLog = '';
    teammate.stdout.on('data', (chunk) => { teammateLog += chunk; });
    teammate.stderr.on('data', (chunk) => { teammateLog += chunk; });

    try {
      const archiveIndex = path.join(adminData, 'archive', 'index.json');
      await waitFor(() => {
        if (!fs.existsSync(archiveIndex)) return false;
        const parsed = JSON.parse(fs.readFileSync(archiveIndex, 'utf8'));
        return parsed.segments && Object.keys(parsed.segments).length > 0;
      }, 45000);
      const parsed = JSON.parse(fs.readFileSync(archiveIndex, 'utf8'));
      const count = Object.keys(parsed.segments).length;
      console.log(`ok: ${count} segment(s) reached the admin archive`);
    } finally {
      await closeElectron(teammate.pid);
      console.error(teammateLog.slice(-2000));
    }
  } finally {
    await closeElectron(admin.pid);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function waitForFile(file, timeoutMs) {
  return waitFor(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')), timeoutMs);
}

function waitFor(fn, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const value = fn();
        if (value) {
          clearInterval(timer);
          resolve(value);
          return;
        }
      } catch (_error) { /* not ready */ }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out'));
      }
    }, 400);
  });
}

function closeElectron(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/t'], () => {
      setTimeout(() => {
        execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => resolve());
      }, 4000);
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
