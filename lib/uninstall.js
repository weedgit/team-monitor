'use strict';

function splitUninstallString(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  let file = '';
  let rest = '';
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    if (end < 2) return null;
    file = value.slice(1, end);
    rest = value.slice(end + 1).trim();
  } else {
    const space = value.indexOf(' ');
    file = space === -1 ? value : value.slice(0, space);
    rest = space === -1 ? '' : value.slice(space + 1).trim();
  }
  if (!file) return null;
  const args = rest ? rest.split(/\s+/).filter((arg) => /^[/A-Za-z0-9_-]+$/.test(arg)) : [];
  if (!args.some((arg) => arg.toLowerCase() === '/s')) args.push('/S');
  return { file, args };
}

function uninstallTargetFromReg(stdout) {
  const match = String(stdout || '').match(/UninstallString\s+REG_\w+\s+(.+)$/im);
  if (!match) return null;
  return splitUninstallString(match[1]);
}

function uninstallKeysFromSearch(stdout) {
  return String(stdout || '').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^HKEY_/i.test(line));
}

module.exports = { splitUninstallString, uninstallTargetFromReg, uninstallKeysFromSearch };
