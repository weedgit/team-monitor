'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { guardScript, taskXml, pauseFlag, allowUninstallFlag, writeGuardScript } = require('../lib/guard');

test('the guard starts a closed app and stays quiet after an admin stop', () => {
  const exe = 'C:\\Program Files\\Team Monitor Teammate\\TeamMonitorTeammate.exe';
  const script = guardScript(exe);
  assert.match(script, /Team Monitor\\paused/);
  assert.match(script, /TeamMonitorTeammate\.exe/);
  assert.match(script, /Win32_Process/);
  assert.match(script, /--hidden/);
  assert.doesNotMatch(script, /powershell/i);
  const xml = taskXml('C:\\Users\\Alex\\AppData\\Roaming\\Team Monitor\\guard.vbs', 'C:\\Windows');
  assert.match(xml, /<Interval>PT1M<\/Interval>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /wscript\.exe/);
  assert.match(xml, /guard\.vbs/);
  assert.doesNotMatch(xml, /powershell/i);
  assert.equal(path.basename(pauseFlag('C:\\Users\\Alex\\AppData\\Roaming')), 'paused');
  assert.equal(path.basename(allowUninstallFlag('C:\\Users\\Alex\\AppData\\Roaming')), 'allow-uninstall');
});

test('a guard script can be written without registering a task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-guard-'));
  try {
    const file = writeGuardScript('D:\\Apps\\TeamMonitorTeammate.exe', root);
    assert.equal(fs.existsSync(file), true);
    assert.match(fs.readFileSync(file, 'utf8'), /D:\\Apps\\TeamMonitorTeammate.exe/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
