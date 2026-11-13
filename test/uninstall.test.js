'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitUninstallString, uninstallTargetFromReg, uninstallKeysFromSearch } = require('../lib/uninstall');

test('an uninstall registry value keeps the program path and asks for a silent run', () => {
  const target = uninstallTargetFromReg(
    '    UninstallString    REG_SZ    "C:\\Program Files\\Team Monitor Teammate\\Uninstall Team Monitor Teammate.exe" /allusers\r\n'
  );
  assert.deepEqual(target, {
    file: 'C:\\Program Files\\Team Monitor Teammate\\Uninstall Team Monitor Teammate.exe',
    args: ['/allusers', '/S']
  });
  assert.equal(splitUninstallString(''), null);
  const keys = uninstallKeysFromSearch(
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}\r\n    DisplayName    REG_SZ    Team Monitor Teammate\r\n\r\nEnd of search: 1 match(es) found.\r\n'
  );
  assert.deepEqual(keys, [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}'
  ]);
});
