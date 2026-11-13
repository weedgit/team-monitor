'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TASK_NAME = 'Team Monitor Teammate Guard';
const DIR_NAME = 'Team Monitor';
const PAUSE_FILE = 'paused';
const ALLOW_FILE = 'allow-uninstall';
const SCRIPT_FILE = 'guard.vbs';

function monitorDir(root) {
  const base = root || process.env.APPDATA || os.tmpdir();
  return path.join(base, DIR_NAME);
}

function pauseFlag(root) {
  return path.join(monitorDir(root), PAUSE_FILE);
}

function allowUninstallFlag(root) {
  return path.join(monitorDir(root), ALLOW_FILE);
}

function guardScriptPath(root) {
  return path.join(monitorDir(root), SCRIPT_FILE);
}

function writeFlag(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '1');
}

function removeFlag(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (_error) { /* already gone */ }
}

function vbsQuote(value) {
  return String(value).replace(/"/g, '""');
}

function guardScript(exePath) {
  const exe = vbsQuote(exePath);
  const name = vbsQuote(path.basename(exePath)).replace(/'/g, '');
  return [
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh = CreateObject("WScript.Shell")',
    'pausePath = sh.ExpandEnvironmentStrings("%APPDATA%") & "\\Team Monitor\\paused"',
    'If fso.FileExists(pausePath) Then WScript.Quit 0',
    `exePath = "${exe}"`,
    'If Not fso.FileExists(exePath) Then WScript.Quit 0',
    'Set service = GetObject("winmgmts:\\\\.\\root\\cimv2")',
    `Set procs = service.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = '${name}'")`,
    'If procs.Count > 0 Then WScript.Quit 0',
    'sh.Run """" & exePath & """ --hidden", 0, False',
    ''
  ].join('\r\n');
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function taskXml(scriptPath, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  const host = xmlEscape(path.join(systemRoot, 'System32', 'wscript.exe'));
  const args = `//B //Nologo "${xmlEscape(scriptPath)}"`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Starts Team Monitor Teammate again if it is closed.</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <TimeTrigger>',
    '      <Repetition>',
    '        <Interval>PT1M</Interval>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    '      <StartBoundary>2020-01-01T00:00:00</StartBoundary>',
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>true</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${host}</Command>`,
    `      <Arguments>${args}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    ''
  ].join('\r\n');
}

function writeGuardScript(exePath, root) {
  const file = guardScriptPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, guardScript(exePath));
  removeFlag(path.join(path.dirname(file), 'guard.ps1'));
  return file;
}

function guardEnabled() {
  return process.platform === 'win32'
    && process.env.TEAM_MONITOR_HEADLESS !== '1'
    && process.env.TEAM_MONITOR_SKIP_AUTOSTART !== '1';
}

function installGuard(exePath, options = {}) {
  if (!guardEnabled()) return false;
  const root = options.root;
  const taskName = options.taskName || TASK_NAME;
  const script = writeGuardScript(exePath, root);
  const xmlPath = path.join(os.tmpdir(), `team-monitor-guard-${process.pid}.xml`);
  fs.writeFileSync(xmlPath, `\uFEFF${taskXml(script)}`, 'utf16le');
  const result = spawnSync('schtasks.exe', ['/Create', '/F', '/TN', taskName, '/XML', xmlPath], {
    windowsHide: true
  });
  try { fs.rmSync(xmlPath, { force: true }); } catch (_error) { /* the task is already registered */ }
  return result.status === 0;
}

function clearGuard(options = {}) {
  if (!guardEnabled()) return false;
  const taskName = options.taskName || TASK_NAME;
  const result = spawnSync('schtasks.exe', ['/Delete', '/F', '/TN', taskName], { windowsHide: true });
  removeFlag(guardScriptPath(options.root));
  return result.status === 0;
}

module.exports = {
  TASK_NAME,
  monitorDir,
  pauseFlag,
  allowUninstallFlag,
  guardScriptPath,
  guardScript,
  taskXml,
  writeFlag,
  removeFlag,
  writeGuardScript,
  installGuard,
  clearGuard
};
