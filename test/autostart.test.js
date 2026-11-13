'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loginArgs, loginCommand, startedHidden, applyAutoStart } = require('../lib/autostart');

test('login args keep the app path in unpackaged launches and hide after enroll', () => {
  assert.equal(startedHidden(['node', 'app']), false);
  assert.equal(startedHidden(['node', 'app', '--hidden']), true);
  assert.deepEqual(loginArgs({ isPackaged: true }, false), []);
  assert.deepEqual(loginArgs({ isPackaged: true }, true), ['--hidden']);
  const unpackaged = loginArgs({ isPackaged: false }, true);
  assert.equal(path.isAbsolute(unpackaged[0]), true);
  assert.equal(unpackaged.includes('--hidden'), true);
  const command = loginCommand('C:\\Apps\\electron.exe', ['E:\\Projects\\Gange\\team-monitor\\admin-app', '--hidden']);
  assert.equal(command, '"C:\\Apps\\electron.exe" "E:\\Projects\\Gange\\team-monitor\\admin-app" "--hidden"');
});

test('headless and skip flags do not register a login item', () => {
  const previousHeadless = process.env.TEAM_MONITOR_HEADLESS;
  process.env.TEAM_MONITOR_HEADLESS = '1';
  try {
    assert.equal(applyAutoStart({
      isPackaged: true,
      getName: () => 'Team Monitor Admin',
      setLoginItemSettings: () => { throw new Error('should not register'); }
    }), false);
  } finally {
    if (previousHeadless == null) delete process.env.TEAM_MONITOR_HEADLESS;
    else process.env.TEAM_MONITOR_HEADLESS = previousHeadless;
  }
});
