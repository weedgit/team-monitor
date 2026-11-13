'use strict';

const enrollForm = document.getElementById('enroll');
const statusPanel = document.getElementById('status');
let connecting = false;

function setEnrollStatus(message, kind) {
  const node = document.getElementById('enroll-status');
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('busy', kind === 'busy');
  node.classList.toggle('error', kind === 'error');
}

function setEnrollBusy(busy) {
  connecting = busy;
  const button = enrollForm.querySelector('button[type="submit"]');
  button.disabled = busy;
  button.textContent = busy ? 'Connecting…' : 'Connect';
  enrollForm.querySelectorAll('input').forEach((input) => {
    input.disabled = busy;
  });
}

function render(status) {
  if (connecting && !status.enrolled) return;
  enrollForm.hidden = status.enrolled;
  statusPanel.hidden = !status.enrolled;
  if (!status.enrolled) {
    if (!connecting) setEnrollStatus(status.lastError || '', status.lastError ? 'error' : '');
    const enrollName = document.getElementById('enroll-name');
    if (enrollName && !enrollName.value) enrollName.value = status.displayName || status.hostname || '';
    return;
  }
  const recording = status.capture === 'recording';
  const holding = Boolean(status.holdNetwork);
  const banner = document.getElementById('status-banner');
  if (banner) {
    banner.classList.toggle('ok', recording && status.live && !holding);
    banner.classList.toggle('hold', holding);
  }
  document.getElementById('dot').classList.toggle('on', recording && !holding);
  document.getElementById('dot').classList.toggle('live', status.live && !recording && !holding);
  const capture = document.getElementById('capture');
  if (status.capture === 'paused-disk') capture.textContent = 'Recording paused — less than 2 GB free';
  else if (status.capture === 'locked') capture.textContent = 'Paused — screen locked';
  else if (holding && recording) capture.textContent = 'Recording — holding network';
  else if (recording) capture.textContent = 'Recording';
  else capture.textContent = 'Not recording';
  const hold = document.getElementById('hold-network');
  if (hold && hold.checked !== holding) hold.checked = holding;
  const nameInput = document.getElementById('display-name');
  if (nameInput && document.activeElement !== nameInput) {
    nameInput.value = status.displayName || status.hostname || '';
  }
  document.getElementById('server-url').textContent = status.serverUrl;
  document.getElementById('live').textContent = holding
    ? 'Paused'
    : (status.live ? 'Connected' : 'Reconnecting');
  const waiting = status.pendingSegments + status.pendingActivities;
  document.getElementById('upload').textContent = holding
    ? (waiting ? `${status.pendingSegments} recording${status.pendingSegments === 1 ? '' : 's'} on this PC` : 'Held on this PC')
    : waiting
      ? `${status.pendingSegments} recording${status.pendingSegments === 1 ? '' : 's'} waiting`
      : (status.live ? 'Caught up' : 'Waiting for the admin PC');
  const displayText = status.displays.length
    ? status.displays.map((display) => `Display ${display.index + 1} (${display.width}×${display.height})`).join(', ')
    : 'Looking for displays…';
  document.getElementById('displays').textContent = displayText;
  document.getElementById('disk').textContent = status.freeGb == null ? 'Unknown' : `${status.freeGb} GB`;
  document.getElementById('status-error').textContent = status.lastError || '';
}

enrollForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (connecting) return;
  setEnrollBusy(true);
  setEnrollStatus('Connecting to the admin…', 'busy');
  const result = await window.teammate.enroll({
    serverUrl: document.getElementById('server').value,
    name: document.getElementById('enroll-name').value
  });
  connecting = false;
  if (result.ok) {
    render(await window.teammate.status());
    return;
  }
  setEnrollBusy(false);
  setEnrollStatus(result.error || 'Could not connect.', 'error');
});

async function saveName() {
  const name = document.getElementById('display-name').value;
  const button = document.getElementById('save-name');
  const result = await window.teammate.setName(name);
  if (result && result.displayName) {
    document.getElementById('display-name').value = result.displayName;
  }
  button.textContent = 'Saved';
  button.classList.add('saved');
  setTimeout(() => {
    button.textContent = 'Save';
    button.classList.remove('saved');
  }, 1200);
}

document.getElementById('hold-network').addEventListener('change', (event) => {
  void window.teammate.setHoldNetwork(event.target.checked);
});

document.getElementById('save-name').addEventListener('click', () => void saveName());
document.getElementById('display-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void saveName();
  }
});

window.teammate.onStatus(render);
window.teammate.status().then(render);
