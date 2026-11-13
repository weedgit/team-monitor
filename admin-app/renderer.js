'use strict';

const state = {
  members: [],
  watch: null,
  urls: new Map(),
  lastJpeg: new Map(),
  layoutKey: '',
  selectedDisplays: new Map(),
  recSlots: [],
  recPlayingSlot: null,
  recDisplays: new Map(),
  recSession: null,
  actEvents: [],
  actApps: new Set()
};

const grid = document.getElementById('grid');
const previewModal = document.getElementById('previewModal');
const previewBody = document.getElementById('previewBody');
const maximizePreviewBtn = document.getElementById('maximizePreviewBtn');
function today() {
  return formatDate(new Date());
}

function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

function frameKey(machineId, displayIndex) {
  return `${machineId}:${displayIndex}`;
}

function hidePlaceholder(image) {
  image.hidden = false;
  const empty = image.parentElement && image.parentElement.querySelector('.ws-empty');
  if (empty) empty.hidden = true;
}

const imageGens = new WeakMap();

function copyJpeg(jpeg) {
  if (jpeg instanceof Uint8Array) return jpeg.slice();
  if (jpeg instanceof ArrayBuffer) return new Uint8Array(jpeg.slice(0));
  return new Uint8Array(jpeg);
}

function setImage(image, jpeg) {
  if (!image || !jpeg) return;
  const bytes = copyJpeg(jpeg);
  const next = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  const gen = (imageGens.get(image) || 0) + 1;
  imageGens.set(image, gen);
  const previous = state.urls.get(image);
  const reveal = () => {
    hidePlaceholder(image);
    if (previous && previous !== next) URL.revokeObjectURL(previous);
    state.urls.set(image, next);
  };
  const probe = new Image();
  probe.onload = () => {
    if (imageGens.get(image) !== gen) {
      URL.revokeObjectURL(next);
      return;
    }
    image.src = next;
    reveal();
  };
  probe.onerror = () => {
    URL.revokeObjectURL(next);
  };
  probe.src = next;
}

function showTab(name) {
  document.getElementById('view-live').hidden = name !== 'live';
  document.getElementById('view-recordings').hidden = name !== 'recordings';
  document.getElementById('view-activity').hidden = name !== 'activity';
  document.getElementById('view-settings').hidden = name !== 'settings';
  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === name);
  });
  if (name === 'recordings') void loadRecordings();
  if (name === 'activity') void loadActivity();
}

function applyGrid(quality) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  grid.style.setProperty('--grid-cols', String((quality && quality.gridCols) || 2));
  grid.style.setProperty('--grid-rows', String((quality && quality.gridRows) || 2));
}

function fillQuality(quality) {
  if (!quality) return;
  const live = document.getElementById('set-live-quality');
  const fps = document.getElementById('set-record-fps');
  const width = document.getElementById('set-record-width');
  const segment = document.getElementById('set-segment-minutes');
  const grid = document.getElementById('set-grid');
  const retention = document.getElementById('set-retention');
  const dir = document.getElementById('set-archive-dir');
  if (live && quality.liveQuality) live.value = quality.liveQuality;
  if (fps && quality.recordFps) fps.value = String(quality.recordFps);
  if (width && quality.recordWidth) width.value = String(quality.recordWidth);
  if (segment && quality.segmentMinutes) segment.value = String(quality.segmentMinutes);
  if (grid && quality.grid) grid.value = quality.grid;
  if (retention && quality.retentionDays) retention.value = String(quality.retentionDays);
  if (dir && document.activeElement !== dir) {
    dir.value = quality.archivePath || quality.archiveDir || '';
  }
  applyGrid(quality);
  paintDisk(quality);
}

function showQualityNote(text) {
  const note = document.getElementById('quality-note');
  if (!note) return;
  note.hidden = !text;
  note.textContent = text || '';
}

async function saveQuality(extra) {
  if (!window.admin || !window.admin.setQuality) return;
  const payload = {
    liveQuality: document.getElementById('set-live-quality').value,
    recordFps: Number(document.getElementById('set-record-fps').value),
    recordWidth: Number(document.getElementById('set-record-width').value),
    segmentMinutes: Number(document.getElementById('set-segment-minutes').value),
    grid: document.getElementById('set-grid').value,
    retentionDays: Number(document.getElementById('set-retention').value)
  };
  if (extra && extra.archiveDir !== undefined) payload.archiveDir = extra.archiveDir;
  const quality = await window.admin.setQuality({ ...payload, ...extra });
  fillQuality(quality);
  if (quality && quality.archiveError) {
    showQualityNote(quality.archiveError);
    return quality;
  }
  showQualityNote(extra && extra.archiveDir !== undefined
    ? 'Saved. New recordings go to this folder; existing clips stay where they were.'
    : 'Saved. Connected teammates pick this up within a few seconds.');
  return quality;
}

async function browseArchive() {
  if (!window.admin || !window.admin.chooseArchiveDir) {
    showQualityNote('Restart Admin to enable Browse.');
    return;
  }
  const result = await window.admin.chooseArchiveDir();
  const chosen = result && typeof result === 'object' ? result.path : result;
  if (result && result.error) {
    showQualityNote(result.error);
    return;
  }
  if (!chosen) return;
  document.getElementById('set-archive-dir').value = chosen;
  await saveQuality({ archiveDir: chosen });
}

async function applyArchivePath() {
  const dir = document.getElementById('set-archive-dir').value.trim();
  await saveQuality({ archiveDir: dir });
}

function bindQuality() {
  ['set-live-quality', 'set-record-fps', 'set-record-width', 'set-segment-minutes', 'set-grid', 'set-retention'].forEach((id) => {
    const field = document.getElementById(id);
    if (field) field.addEventListener('change', () => void saveQuality());
  });
  const dir = document.getElementById('set-archive-dir');
  const browse = document.getElementById('browse-archive');
  const reset = document.getElementById('reset-archive');
  if (browse) browse.addEventListener('click', () => void browseArchive());
  if (reset) reset.addEventListener('click', () => void saveQuality({ archiveDir: '' }));
  if (dir) {
    dir.addEventListener('change', () => void applyArchivePath());
    dir.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void applyArchivePath();
      }
    });
  }
}

function paintDisk(info) {
  const disk = document.getElementById('archive-disk');
  if (!disk || !info) return;
  if (info.freeGb == null) {
    disk.textContent = '';
    return;
  }
  disk.textContent = info.diskLow
    ? `Archive disk is low (${info.freeGb} GB free). New uploads stay on the teammate PCs.`
    : `${info.freeGb} GB free on the archive disk.`;
}

function renderAddresses(info) {
  const root = document.getElementById('addresses');
  root.replaceChildren();
  const note = document.getElementById('port-note');
  if (note) {
    const fallback = info.preferredPort && info.port !== info.preferredPort;
    note.hidden = !fallback;
    note.textContent = fallback
      ? `Port ${info.preferredPort} is already in use. For this run, teammates must use the address above.`
      : '';
  }
  const addresses = info.addresses.length ? info.addresses : [{ name: 'This PC', address: '127.0.0.1' }];
  addresses.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'addr-row';
    const text = document.createElement('span');
    const url = `http://${item.address}:${info.port}`;
    text.textContent = `${item.name}: ${url}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet-btn';
    button.textContent = 'Copy address';
    button.addEventListener('click', () => window.admin.copy(url));
    row.append(text, button);
    root.append(row);
  });
}

function fillMembers(select, includeEmpty) {
  const current = select.value;
  select.replaceChildren();
  if (includeEmpty) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Select a teammate';
    select.append(option);
  }
  state.members.forEach((member) => {
    const option = document.createElement('option');
    option.value = member.machineId;
    option.textContent = member.hostname;
    select.append(option);
  });
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function updateStats() {
  const online = state.members.filter((member) => member.online).length;
  const rec = state.members.filter((member) => member.capture === 'recording').length;
  const pending = state.members.reduce((sum, member) => sum + (Number(member.pendingSegments) || 0), 0);
  document.getElementById('stat-total').textContent = String(state.members.length);
  document.getElementById('stat-online').textContent = String(online);
  document.getElementById('stat-rec').textContent = String(rec);
  document.getElementById('stat-pending').textContent = String(pending);
}

function badge(member) {
  if (member.holdNetwork && member.online) return { className: 'st-badge st-hold', text: 'Holding network' };
  if (member.capture === 'recording') return { className: 'st-badge st-rec', text: 'Recording' };
  if (member.online && member.capture === 'locked') return { className: 'st-badge st-wait', text: 'Screen locked' };
  if (member.online) return { className: 'st-badge st-online', text: 'Online' };
  return { className: 'st-badge st-off', text: 'Offline' };
}

function layoutKey(members) {
  return (members || []).map((member) => {
    const displays = (member.displays || []).map((display) => display.index).join(',');
    return `${member.machineId}:${displays}`;
  }).join('|');
}

function paintStatus(card, member) {
  const row = card.querySelector('.ws-status');
  if (!row) return;
  row.replaceChildren();
  const status = badge(member);
  const pill = document.createElement('span');
  pill.className = status.className;
  pill.textContent = status.text;
  row.append(pill);
  if (member.holdNetwork && member.online && member.capture === 'recording') {
    const rec = document.createElement('span');
    rec.className = 'st-badge st-rec';
    rec.textContent = 'Recording';
    row.append(rec);
  }
  if (member.pendingSegments > 0) {
    const wait = document.createElement('span');
    wait.className = 'st-badge st-wait';
    wait.textContent = member.holdNetwork
      ? `${member.pendingSegments} on PC`
      : `${member.pendingSegments} to upload`;
    row.append(wait);
  }
  paintHold(card, member);
}

function paintHold(card, member) {
  card.querySelectorAll('.ws-screen').forEach((screen) => {
    let tag = screen.querySelector('.ws-hold-tag');
    if (member.holdNetwork && member.online) {
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'ws-hold-tag';
        tag.textContent = 'Holding network';
        screen.append(tag);
      }
    } else if (tag) {
      tag.remove();
    }
  });
}

function applyCachedFrame(image, machineId, displayIndex) {
  const cached = state.lastJpeg.get(frameKey(machineId, displayIndex));
  if (cached) setImage(image, cached);
}

function memberDisplays(member) {
  return member.displays && member.displays.length
    ? member.displays
    : [{ index: 0, label: 'Display 1' }];
}

function selectedDisplaysFor(member) {
  const displays = memberDisplays(member);
  const valid = new Set(displays.map((display) => display.index));
  let selected = state.selectedDisplays.get(member.machineId);
  if (!Array.isArray(selected) || !selected.length) {
    const first = displays[0];
    return first ? [first] : [];
  }
  selected = selected.filter((index) => valid.has(index));
  if (!selected.length) {
    state.selectedDisplays.delete(member.machineId);
    const first = displays[0];
    return first ? [first] : [];
  }
  state.selectedDisplays.set(member.machineId, selected);
  return selected.map((index) => displays.find((display) => display.index === index));
}

function pickerLabel(selected) {
  if (selected.length === 1) return selected[0].label;
  return `${selected.length} screens`;
}

function closeScreenMenus(except) {
  document.querySelectorAll('.ws-screens-menu').forEach((menu) => {
    if (menu !== except) menu.hidden = true;
  });
}

function createScreenPane(member, display) {
  const screen = document.createElement('div');
  screen.className = 'ws-screen';
  const image = document.createElement('img');
  image.alt = `${member.hostname} ${display.label}`;
  image.hidden = true;
  image.dataset.machine = member.machineId;
  image.dataset.display = String(display.index);
  const placeholder = document.createElement('div');
  placeholder.className = 'ws-empty';
  placeholder.textContent = member.holdNetwork && member.online
    ? 'Holding network'
    : (member.online ? 'Waiting for live frame…' : 'Offline');
  screen.append(placeholder, image);
  applyCachedFrame(image, member.machineId, display.index);
  screen.addEventListener('click', (event) => {
    event.stopPropagation();
    openPreview(member.machineId);
  });
  return screen;
}

function paintCardScreens(card, member) {
  const panes = card.querySelector('.ws-panes');
  if (!panes) return;
  const selected = selectedDisplaysFor(member);
  panes.replaceChildren();
  panes.classList.toggle('split', selected.length > 1);
  selected.forEach((display) => panes.append(createScreenPane(member, display)));
  const button = card.querySelector('.ws-screens-btn');
  if (button) button.textContent = pickerLabel(selected);
}

function paintScreenPicker(card, member, top) {
  const displays = memberDisplays(member);
  if (displays.length < 2) return;
  const wrap = document.createElement('div');
  wrap.className = 'ws-screens-pick';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ws-screens-btn';
  button.textContent = pickerLabel(selectedDisplaysFor(member));
  const menu = document.createElement('div');
  menu.className = 'ws-screens-menu';
  menu.hidden = true;
  displays.forEach((display) => {
    const row = document.createElement('label');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selectedDisplaysFor(member).some((item) => item.index === display.index);
    const text = document.createElement('span');
    text.textContent = display.label;
    row.append(check, text);
    check.addEventListener('change', (event) => {
      event.stopPropagation();
      const current = selectedDisplaysFor(member).map((item) => item.index);
      const next = check.checked
        ? [...new Set([...current, display.index])]
        : current.filter((index) => index !== display.index);
      if (!next.length) {
        check.checked = true;
        return;
      }
      next.sort((a, b) => a - b);
      state.selectedDisplays.set(member.machineId, next);
      paintCardScreens(card, member);
      if (state.watch && state.watch.machineId === member.machineId) {
        openPreview(member.machineId, { keepFullscreen: true });
      }
    });
    menu.append(row);
  });
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    closeScreenMenus();
    if (open) {
      menu.querySelectorAll('input[type="checkbox"]').forEach((input, index) => {
        const display = displays[index];
        input.checked = selectedDisplaysFor(member).some((item) => item.index === display.index);
      });
      menu.hidden = false;
    }
  });
  wrap.addEventListener('click', (event) => event.stopPropagation());
  wrap.append(button, menu);
  top.append(wrap);
}

function applyMembers(members) {
  state.members = members;
  if (state.watch && !members.some((member) => member.machineId === state.watch.machineId)) {
    void closePreview();
  }
  updateStats();
  const nextKey = layoutKey(members);
  if (nextKey !== state.layoutKey || !grid.querySelector('.ws-card')) {
    state.layoutKey = nextKey;
    renderGrid();
    return;
  }
  members.forEach((member) => {
    const card = grid.querySelector(`[data-card="${cssEscape(member.machineId)}"]`);
    if (!card) return;
    card.classList.toggle('offline', !member.online);
    const host = card.querySelector('.ws-host');
    if (host) host.textContent = member.hostname;
    paintStatus(card, member);
  });
}

function memberAction(label, className, title, run) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.classList.add('armed');
      button.textContent = 'Confirm';
      return;
    }
    button.disabled = true;
    button.textContent = 'Sent';
    const result = await run();
    if (result && result.ok === false) {
      button.disabled = false;
      button.dataset.armed = '';
      button.classList.remove('armed');
      button.textContent = result.error || label;
      setTimeout(() => {
        if (button.isConnected) button.textContent = label;
      }, 2800);
    }
  });
  return button;
}

function renderGrid() {
  updateStats();
  grid.replaceChildren();
  if (!state.members.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No teammates yet. On each teammate PC, install Teammate Setup and enter the admin address.';
    grid.append(empty);
    return;
  }
  state.members.forEach((member) => {
    const card = document.createElement('article');
    card.dataset.card = member.machineId;
    card.className = `ws-card${member.online ? '' : ' offline'}`;
    const top = document.createElement('div');
    top.className = 'ws-top';
    top.innerHTML = '<span class="wdots"><span class="wd r"></span><span class="wd y"></span><span class="wd g"></span></span>';
    const host = document.createElement('span');
    host.className = 'ws-host';
    host.textContent = member.hostname;
    top.append(host);
    const status = document.createElement('div');
    status.className = 'ws-status';
    top.append(status);
    paintScreenPicker(card, member, top);
    if (window.admin && (window.admin.removeMember || window.admin.commandMember)) {
      const actions = document.createElement('div');
      actions.className = 'ws-actions';
      if (window.admin.commandMember) {
        actions.append(
          memberAction('Stop', 'ws-stop', 'Close Team Monitor on this PC. It starts again the next time that person signs in.', () => window.admin.commandMember(member.machineId, 'stop')),
          memberAction('Uninstall', 'ws-uninstall', 'Remove Team Monitor from this PC. Recordings stay here. Windows may ask for an administrator password on that PC.', () => window.admin.commandMember(member.machineId, 'uninstall'))
        );
      }
      if (window.admin.removeMember) {
        actions.append(memberAction('Remove', 'ws-remove', 'Take this PC off the roster. The app keeps running there, and recordings stay here.', () => window.admin.removeMember(member.machineId)));
      }
      top.append(actions);
    }

    const panes = document.createElement('div');
    panes.className = 'ws-panes';
    card.append(top, panes);
    paintCardScreens(card, member);
    paintStatus(card, member);
    card.addEventListener('click', () => openPreview(member.machineId));
    grid.append(card);
  });
}

function updateMaximizePreviewButton() {
  const isFs = document.fullscreenElement === previewModal;
  maximizePreviewBtn.textContent = isFs ? 'Exit full screen' : 'Full screen';
}

function previewTitleText(member) {
  return member.hostname;
}

function previewPaneKey(member) {
  return selectedDisplaysFor(member).map((display) => display.index).join(',');
}

function revokePreviewImages() {
  previewBody.querySelectorAll('img').forEach((image) => {
    const url = state.urls.get(image);
    if (url) URL.revokeObjectURL(url);
    state.urls.delete(image);
  });
}

function paintPreviewPanes(member) {
  const selected = selectedDisplaysFor(member);
  revokePreviewImages();
  previewBody.replaceChildren();
  previewBody.classList.toggle('split', selected.length > 1);
  selected.forEach((display) => {
    const pane = document.createElement('div');
    pane.className = 'ws-screen';
    const image = document.createElement('img');
    image.alt = `${member.hostname} ${display.label}`;
    image.hidden = true;
    image.dataset.machine = member.machineId;
    image.dataset.display = String(display.index);
    const empty = document.createElement('div');
    empty.className = 'ws-empty';
    empty.textContent = 'Connecting to live view…';
    pane.append(empty, image);
    applyCachedFrame(image, member.machineId, display.index);
    previewBody.append(pane);
  });
}

function paintDisplaySwitcher(member) {
  const switcher = document.getElementById('display-switch');
  switcher.replaceChildren();
  const displays = memberDisplays(member);
  if (displays.length < 2) return;
  const selected = new Set(selectedDisplaysFor(member).map((display) => display.index));
  displays.forEach((display) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pv-btn';
    button.textContent = display.label;
    button.classList.toggle('active', selected.has(display.index));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      state.selectedDisplays.set(member.machineId, [display.index]);
      const card = grid.querySelector(`[data-card="${cssEscape(member.machineId)}"]`);
      if (card) paintCardScreens(card, member);
      openPreview(member.machineId, { keepFullscreen: true });
    });
    switcher.append(button);
  });
}

let previewOpenedAt = 0;

function refreshOpenPreview(member) {
  if (!member || !state.watch || state.watch.machineId !== member.machineId) return;
  document.getElementById('previewTitle').textContent = previewTitleText(member);
  paintDisplaySwitcher(member);
  const current = [...previewBody.querySelectorAll('img[data-display]')].map((image) => image.dataset.display).join(',');
  if (current !== previewPaneKey(member)) paintPreviewPanes(member);
}

function openPreview(machineId, options = {}) {
  const member = state.members.find((item) => item.machineId === machineId);
  if (!member) return;
  const selected = selectedDisplaysFor(member);
  const alreadyOpen = previewModal.classList.contains('active') && state.watch && state.watch.machineId === machineId;
  state.watch = { machineId, displayIndex: selected[0].index };
  document.getElementById('previewTitle').textContent = previewTitleText(member);
  paintPreviewPanes(member);
  paintDisplaySwitcher(member);
  previewModal.classList.add('active');
  if (!alreadyOpen) previewOpenedAt = Date.now();
  updateMaximizePreviewButton();
  if (window.admin) void window.admin.setWatch({ machineId, displayIndex: selected[0].index });
  if (!options.keepFullscreen) {
    try {
      const req = previewModal.requestFullscreen && previewModal.requestFullscreen();
      if (req && typeof req.then === 'function') {
        req.then(() => updateMaximizePreviewButton()).catch(() => updateMaximizePreviewButton());
      }
    } catch (_error) {
      updateMaximizePreviewButton();
    }
  }
}

async function closePreview() {
  try {
    if (document.fullscreenElement === previewModal) await document.exitFullscreen();
  } catch (_error) { /* ignore */ }
  previewModal.classList.remove('active');
  state.watch = null;
  revokePreviewImages();
  previewBody.replaceChildren();
  if (window.admin) void window.admin.setWatch({ machineId: null, displayIndex: 0 });
  updateMaximizePreviewButton();
}

async function togglePreviewFullscreen() {
  try {
    if (!document.fullscreenElement) await previewModal.requestFullscreen();
    else await document.exitFullscreen();
  } catch (_error) { /* ignore */ }
  updateMaximizePreviewButton();
}

function onFrame(frame) {
  const jpeg = copyJpeg(frame.jpeg);
  state.lastJpeg.set(frameKey(frame.machineId, frame.displayIndex), jpeg);
  document.querySelectorAll(`img[data-machine="${cssEscape(frame.machineId)}"][data-display="${frame.displayIndex}"]`).forEach((image) => {
    setImage(image, jpeg);
  });
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '');
}

function selectedMember(select) {
  return state.members.find((member) => member.machineId === select.value) || null;
}

function chooseMemberDisplays(member, displayIndex) {
  const current = selectedDisplaysFor(member).map((item) => item.index);
  const already = current.includes(displayIndex);
  let next;
  if (already && current.length > 1) next = [displayIndex];
  else if (already) next = current;
  else next = [...current, displayIndex].sort((a, b) => a - b);
  state.selectedDisplays.set(member.machineId, next);
  const card = grid.querySelector(`[data-card="${cssEscape(member.machineId)}"]`);
  if (card) paintCardScreens(card, member);
}

function recDisplaysFor(member) {
  const displays = memberDisplays(member);
  const all = displays.map((display) => display.index);
  let selected = state.recDisplays.get(member.machineId);
  if (!Array.isArray(selected) || !selected.length) return all;
  selected = selected.filter((index) => all.includes(index));
  return selected.length ? selected : all;
}

function setRecDisplayChecked(member, displayIndex, checked) {
  const current = recDisplaysFor(member);
  const next = checked
    ? [...new Set([...current, displayIndex])].sort((a, b) => a - b)
    : current.filter((index) => index !== displayIndex);
  if (!next.length) return false;
  state.recDisplays.set(member.machineId, next);
  return true;
}

function paintRecSwitcherInto(switcher, member) {
  if (!switcher) return;
  switcher.replaceChildren();
  if (!member) return;
  const displays = memberDisplays(member);
  if (displays.length < 2) return;
  const selected = new Set(recDisplaysFor(member));
  displays.forEach((display) => {
    const row = document.createElement('label');
    row.className = 'rec-check';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(display.index);
    const text = document.createElement('span');
    text.textContent = display.label;
    check.addEventListener('change', () => {
      if (!setRecDisplayChecked(member, display.index, check.checked)) {
        check.checked = true;
        return;
      }
      paintRecSwitcher(member);
      paintRecClipList();
      void syncRecPanes();
    });
    row.append(check, text);
    switcher.append(row);
  });
}

function paintRecSwitcher(member) {
  paintRecSwitcherInto(document.getElementById('rec-display-switch'), member);
  paintRecSwitcherInto(document.getElementById('rec-player-displays'), member);
}

function segmentSlot(segment) {
  const start = new Date(segment.startedAt);
  start.setSeconds(0, 0);
  return start.getTime();
}

function groupRecordingSlots(segments) {
  const groups = new Map();
  segments.forEach((segment) => {
    const key = segmentSlot(segment);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(segment);
  });
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, clips]) => clips.sort((a, b) => a.displayIndex - b.displayIndex));
}

function clipClock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatRecordedTime(date) {
  const value = new Date(date);
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function revealPlayingClip(list) {
  if (!list) return;
  const active = list.querySelector('button.active');
  if (!active) return;
  const listRect = list.getBoundingClientRect();
  const cardRect = active.getBoundingClientRect();
  if (cardRect.top < listRect.top) list.scrollTop -= listRect.top - cardRect.top;
  else if (cardRect.bottom > listRect.bottom) list.scrollTop += cardRect.bottom - listRect.bottom;
}

function markPlayingClip(slot) {
  state.recPlayingSlot = slot == null ? null : String(slot);
  const list = document.getElementById('segments');
  list.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.slot === state.recPlayingSlot);
  });
  revealPlayingClip(list);
}

function updateRecClock(startedAt, currentTime) {
  const clock = document.getElementById('rec-now');
  if (!clock) return;
  const at = new Date(new Date(startedAt).getTime() + Math.max(0, currentTime || 0) * 1000);
  clock.textContent = `Recorded ${formatRecordedTime(at)}`;
}

function formatClock(value) {
  const parts = String(value || '').split(':');
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function visibleRecSlots() {
  const query = document.getElementById('rec-time').value;
  return query
    ? state.recSlots.filter((clips) => clipClock(new Date(clips[0].startedAt)) === query)
    : state.recSlots;
}

function playableRecSlots() {
  const member = selectedMember(document.getElementById('rec-member'));
  const wanted = new Set(member ? recDisplaysFor(member) : []);
  return visibleRecSlots().filter((clips) => clips.some((clip) => wanted.has(clip.displayIndex)));
}

function playNextSlot(currentSlot) {
  const slots = playableRecSlots();
  const index = slots.findIndex((clips) => String(segmentSlot(clips[0])) === String(currentSlot));
  if (index < 0 || index >= slots.length - 1) return;
  void playClips(slots[index + 1], { autoplay: true });
}

function paintRecClipList() {
  const list = document.getElementById('segments');
  const note = document.getElementById('rec-note');
  const member = selectedMember(document.getElementById('rec-member'));
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  const query = document.getElementById('rec-time').value;
  const wanted = new Set(member ? recDisplaysFor(member) : []);
  const slots = playableRecSlots();
  if (!state.recSlots.length) return;
  if (!slots.length) {
    note.textContent = query ? `No clip at ${formatClock(query)}.` : 'No recording for this date.';
    return;
  }
  note.textContent = query
    ? `${slots.length} clip${slots.length === 1 ? '' : 's'} at ${formatClock(query)}.`
    : `${slots.length} clip${slots.length === 1 ? '' : 's'}.`;
  slots.forEach((clips) => {
    const shown = clips.filter((clip) => wanted.has(clip.displayIndex));
    const button = document.createElement('button');
    button.type = 'button';
    const start = new Date(clips[0].startedAt);
    const time = document.createElement('span');
    time.className = 'rec-clip-time';
    time.textContent = formatRecordedTime(start);
    const meta = document.createElement('span');
    meta.className = 'rec-clip-meta';
    meta.textContent = shown.map((clip) => `Display ${clip.displayIndex + 1}`).join(' + ');
    button.dataset.slot = String(segmentSlot(clips[0]));
    button.classList.toggle('active', state.recPlayingSlot === button.dataset.slot);
    button.append(time, meta);
    button.addEventListener('click', () => void playClips(clips));
    list.append(button);
  });
  if (state.recPlayingSlot) revealPlayingClip(list);
  else list.scrollTop = scrollTop;
}

let recLoadGen = 0;

async function loadRecordings() {
  const gen = ++recLoadGen;
  const memberSelect = document.getElementById('rec-member');
  fillMembers(memberSelect, true);
  const member = selectedMember(memberSelect);
  paintRecSwitcher(member);
  const note = document.getElementById('rec-note');
  const list = document.getElementById('segments');
  if (!member) {
    list.replaceChildren();
    state.recSlots = [];
    note.textContent = 'Choose a teammate to review that day.';
    clearRecPlayers();
    return;
  }
  const result = await window.admin.recordings({
    machineId: member.machineId,
    date: document.getElementById('rec-date').value
  });
  if (gen !== recLoadGen) return;
  const segments = result.segments || [];
  if (!segments.length) {
    list.replaceChildren();
    state.recSlots = [];
    clearRecPlayers();
    note.textContent = 'No recording for this date. If the teammate was offline, it will appear here after upload.';
    return;
  }
  state.recSlots = groupRecordingSlots(segments);
  paintRecClipList();
}

const recNodes = new Map();
let recPlayGen = 0;

function recPrimary() {
  const index = [...recNodes.keys()].sort((a, b) => a - b)[0];
  return index == null ? null : recNodes.get(index);
}

function recPlaybackTime() {
  const primary = recPrimary();
  return primary && primary.video ? primary.video.currentTime || 0 : 0;
}

function recIsPlaying() {
  const primary = recPrimary();
  return Boolean(primary && primary.video && !primary.video.paused && !primary.video.ended);
}

function clearRecPane(index) {
  const node = recNodes.get(index);
  if (!node) return;
  if (node.url) URL.revokeObjectURL(node.url);
  if (node.pane && node.pane.parentNode) node.pane.remove();
  recNodes.delete(index);
}

function clearRecPlayers() {
  recPlayGen += 1;
  [...recNodes.keys()].forEach((index) => clearRecPane(index));
  state.recSession = null;
  markPlayingClip(null);
  const root = document.getElementById('rec-players');
  if (root) root.replaceChildren();
}

function updateRecFullscreenButton() {
  const button = document.getElementById('rec-fs-btn');
  const root = document.getElementById('rec-players');
  if (!button || !root) return;
  button.textContent = document.fullscreenElement === root ? 'Exit full screen' : 'Full screen';
}

async function toggleRecFullscreen() {
  const root = document.getElementById('rec-players');
  if (!root || !root.children.length) return;
  try {
    if (document.fullscreenElement === root) await document.exitFullscreen();
    else await root.requestFullscreen();
  } catch (_error) { /* ignore */ }
  updateRecFullscreenButton();
}

function followPrimary(primary) {
  recNodes.forEach((node) => {
    if (!node.video || node.video === primary) return;
    if (Math.abs((node.video.currentTime || 0) - (primary.currentTime || 0)) > 0.3) {
      node.video.currentTime = primary.currentTime || 0;
    }
    if (primary.paused || primary.ended) node.video.pause();
    else void node.video.play().catch(() => {});
  });
}

function refreshRecControls() {
  const ordered = [...recNodes.entries()].sort((a, b) => a[0] - b[0]);
  ordered.forEach(([, node], index) => {
    if (node.video) node.video.controls = index === 0;
  });
  const stage = document.querySelector('#rec-players .rec-stage');
  if (stage) stage.classList.toggle('split', ordered.length > 1);
}

async function addRecPane(stage, segment, displayIndex, options) {
  const pane = document.createElement('div');
  pane.className = 'rec-pane';
  pane.dataset.display = String(displayIndex);
  const label = document.createElement('div');
  label.className = 'rec-pane-label';
  label.textContent = `Display ${displayIndex + 1}`;
  const gen = recPlayGen;
  recNodes.set(displayIndex, { pane, video: null, url: null });
  if (!segment) {
    const empty = document.createElement('div');
    empty.className = 'rec-pane-empty';
    empty.textContent = 'No clip';
    pane.append(label, empty);
    stage.append(pane);
    return;
  }
  const video = document.createElement('video');
  video.playsInline = true;
  const bytes = await window.admin.loadSegment(segment.segmentId);
  if (gen !== recPlayGen || !recNodes.has(displayIndex)) return;
  if (!bytes) {
    const empty = document.createElement('div');
    empty.className = 'rec-pane-empty';
    empty.textContent = 'Clip missing';
    pane.append(label, empty);
    stage.append(pane);
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  video.src = url;
  const seek = Number(options.seek) || 0;
  video.addEventListener('loadedmetadata', () => {
    if (gen !== recPlayGen) return;
    const span = Number.isFinite(video.duration) ? video.duration : seek;
    video.currentTime = Math.min(Math.max(0, seek), span || 0);
    if (options.autoplay) void video.play().catch(() => {});
  });
  video.addEventListener('play', () => {
    if (recPrimary() && recPrimary().video === video) followPrimary(video);
  });
  video.addEventListener('pause', () => {
    if (recPrimary() && recPrimary().video === video) followPrimary(video);
  });
  video.addEventListener('seeked', () => {
    if (recPrimary() && recPrimary().video === video) followPrimary(video);
  });
  video.addEventListener('timeupdate', () => {
    if (gen !== recPlayGen || !state.recSession) return;
    if (recPrimary() && recPrimary().video === video) {
      updateRecClock(state.recSession.startedAt, video.currentTime);
    }
  });
  video.addEventListener('ended', () => {
    if (gen !== recPlayGen || !state.recSession) return;
    if (recPrimary() && recPrimary().video === video) playNextSlot(state.recSession.slot);
  });
  pane.append(label, video);
  const keys = [...stage.querySelectorAll('.rec-pane')].map((item) => Number(item.dataset.display));
  const next = keys.find((index) => index > displayIndex);
  if (next == null) stage.append(pane);
  else stage.insertBefore(pane, stage.querySelector(`[data-display="${next}"]`));
  recNodes.set(displayIndex, { pane, video, url });
}

async function syncRecPanes(options = {}) {
  if (!state.recSession) return;
  const member = selectedMember(document.getElementById('rec-member'));
  const stage = document.querySelector('#rec-players .rec-stage');
  if (!member || !stage) return;
  const wanted = recDisplaysFor(member);
  const time = options.seek != null ? Number(options.seek) : recPlaybackTime();
  const playing = recIsPlaying() || Boolean(options.autoplay);
  [...recNodes.keys()].forEach((index) => {
    if (!wanted.includes(index)) clearRecPane(index);
  });
  for (const index of wanted) {
    if (recNodes.has(index)) continue;
    const segment = state.recSession.clipsByDisplay.get(index) || null;
    await addRecPane(stage, segment, index, { seek: time, autoplay: playing });
  }
  refreshRecControls();
}

function ensureRecChrome(startedAt, seek) {
  const root = document.getElementById('rec-players');
  if (root.querySelector('.rec-stage')) {
    updateRecClock(startedAt, seek || 0);
    return root.querySelector('.rec-stage');
  }
  root.replaceChildren();
  const bar = document.createElement('div');
  bar.className = 'rec-bar';
  const clock = document.createElement('div');
  clock.className = 'rec-now';
  clock.id = 'rec-now';
  const displays = document.createElement('div');
  displays.className = 'rec-displays';
  displays.id = 'rec-player-displays';
  const fs = document.createElement('button');
  fs.type = 'button';
  fs.className = 'pv-btn';
  fs.id = 'rec-fs-btn';
  fs.textContent = 'Full screen';
  fs.addEventListener('click', () => void toggleRecFullscreen());
  bar.append(clock, displays, fs);
  const stage = document.createElement('div');
  stage.className = 'rec-stage';
  root.append(bar, stage);
  updateRecClock(startedAt, seek || 0);
  updateRecFullscreenButton();
  return stage;
}

async function playClips(clips, options = {}) {
  const gen = ++recPlayGen;
  [...recNodes.keys()].forEach((index) => clearRecPane(index));
  const playable = (clips || []).filter(Boolean);
  if (!playable.length) {
    clearRecPlayers();
    document.getElementById('rec-note').textContent = 'That recording is no longer in the archive.';
    return;
  }
  const startedAt = playable[0].startedAt;
  const slot = segmentSlot(playable[0]);
  state.recSession = {
    gen,
    slot,
    startedAt,
    clipsByDisplay: new Map(playable.map((clip) => [clip.displayIndex, clip]))
  };
  markPlayingClip(slot);
  ensureRecChrome(startedAt, options.seek || 0);
  const member = selectedMember(document.getElementById('rec-member'));
  paintRecSwitcher(member);
  if (gen !== recPlayGen) return;
  await syncRecPanes({ autoplay: Boolean(options.autoplay), seek: options.seek || 0 });
}

function appLabel(app) {
  const raw = String(app || 'App').replace(/\.exe$/i, '').trim() || 'App';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function parseAppFilter(value) {
  return String(value || '')
    .split(/[,]+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

function eventMatchesFilter(event, terms) {
  if (!terms.length && !state.actApps.size) return true;
  const app = String(event.app || '').toLowerCase();
  const title = String(event.title || '').toLowerCase();
  const label = appLabel(event.app).toLowerCase();
  const chipOk = !state.actApps.size || [...state.actApps].some((name) => (
    app.includes(name) || label.includes(name)
  ));
  if (!chipOk) return false;
  if (!terms.length) return true;
  return terms.some((term) => app.includes(term) || title.includes(term) || label.includes(term));
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function activityWithDuration(events) {
  const selected = document.getElementById('act-date').value === today();
  return events.map((event, index) => {
    const start = new Date(event.at).getTime();
    const next = events[index + 1]
      ? new Date(events[index + 1].at).getTime()
      : (selected ? Date.now() : start);
    return { ...event, ms: Math.max(0, next - start) };
  });
}

function hourHeading(date) {
  const hour = new Date(date);
  return `${String(hour.getHours()).padStart(2, '0')}:00`;
}

function paintActivityApps(events) {
  const root = document.getElementById('act-apps');
  root.replaceChildren();
  const names = [...new Set(events.map((event) => appLabel(event.app)))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (!names.length) return;
  const all = document.createElement('button');
  all.type = 'button';
  all.className = `act-chip${state.actApps.size ? '' : ' active'}`;
  all.textContent = 'All apps';
  all.addEventListener('click', () => {
    state.actApps = new Set();
    paintActivity();
  });
  root.append(all);
  names.forEach((name) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `act-chip${state.actApps.has(name.toLowerCase()) ? ' active' : ''}`;
    chip.textContent = name;
    chip.addEventListener('click', () => {
      const key = name.toLowerCase();
      if (state.actApps.has(key)) state.actApps.delete(key);
      else state.actApps.add(key);
      paintActivity();
    });
    root.append(chip);
  });
}

function paintActivity() {
  const member = selectedMember(document.getElementById('act-member'));
  const note = document.getElementById('act-note');
  const list = document.getElementById('activity');
  list.replaceChildren();
  paintActivityApps(state.actEvents);
  if (!member) {
    note.textContent = 'Choose a teammate.';
    return;
  }
  if (!state.actEvents.length) {
    note.textContent = 'No activity for this date yet.';
    return;
  }
  const terms = parseAppFilter(document.getElementById('act-filter').value);
  const events = activityWithDuration(state.actEvents).filter((event) => eventMatchesFilter(event, terms));
  if (!events.length) {
    note.textContent = 'No matching apps for this filter.';
    return;
  }
  note.textContent = `${events.length} switch${events.length === 1 ? '' : 'es'} · click a row to open the recording.`;
  let lastHour = '';
  events.forEach((event) => {
    const at = new Date(event.at);
    const hour = hourHeading(at);
    if (hour !== lastHour) {
      lastHour = hour;
      const heading = document.createElement('div');
      heading.className = 'act-hour';
      heading.textContent = hour;
      list.append(heading);
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'act-row';
    const time = document.createElement('span');
    time.className = 'act-time';
    time.textContent = formatRecordedTime(at);
    const dur = document.createElement('span');
    dur.className = 'act-dur';
    dur.textContent = formatDuration(event.ms);
    const app = document.createElement('span');
    app.className = 'act-app';
    app.textContent = appLabel(event.app);
    const title = document.createElement('span');
    title.className = 'act-title';
    title.textContent = event.title || 'Untitled window';
    title.title = event.title || '';
    const display = document.createElement('span');
    display.className = 'act-display';
    display.textContent = `Display ${Number(event.displayIndex) + 1}`;
    row.append(time, dur, app, title, display);
    row.addEventListener('click', () => openActivity(member, event));
    list.append(row);
  });
}

async function loadActivity() {
  const memberSelect = document.getElementById('act-member');
  fillMembers(memberSelect, true);
  const member = selectedMember(memberSelect);
  state.actEvents = [];
  if (!member) {
    paintActivity();
    return;
  }
  const result = await window.admin.activity({
    machineId: member.machineId,
    date: document.getElementById('act-date').value
  });
  state.actEvents = result.events || [];
  paintActivity();
}

async function openActivity(member, event) {
  showTab('recordings');
  document.getElementById('rec-date').value = document.getElementById('act-date').value;
  document.getElementById('rec-member').value = member.machineId;
  const current = recDisplaysFor(member);
  if (!current.includes(Number(event.displayIndex))) {
    state.recDisplays.set(
      member.machineId,
      [...current, Number(event.displayIndex)].sort((a, b) => a - b)
    );
  }
  await loadRecordings();
  const clips = [];
  let seek = 0;
  for (const display of memberDisplays(member)) {
    const found = await window.admin.findSegment({
      machineId: member.machineId,
      displayIndex: display.index,
      at: event.at
    });
    if (found) {
      clips.push(found.segment);
      if (display.index === Number(event.displayIndex)) seek = found.seek;
    }
  }
  if (!clips.length) {
    document.getElementById('rec-note').textContent = 'No recording covers that moment. It may still be on the teammate PC.';
    return;
  }
  await playClips(clips, { seek });
}

document.querySelectorAll('.nav-btn').forEach((button) => {
  button.addEventListener('click', () => showTab(button.dataset.view));
});

const SIDEBAR_KEY = 'tm-sidebar-open';
function setSidebarOpen(open) {
  document.querySelector('.app').classList.toggle('sb-closed', !open);
  const button = document.getElementById('sidebarToggle');
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', open ? 'Close sidebar' : 'Open sidebar');
  try { localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch (_error) { /* ignore */ }
}
document.getElementById('sidebarToggle').addEventListener('click', () => {
  setSidebarOpen(document.querySelector('.app').classList.contains('sb-closed'));
});
try {
  setSidebarOpen(localStorage.getItem(SIDEBAR_KEY) !== '0');
} catch (_error) {
  setSidebarOpen(true);
}
document.getElementById('closePreviewBtn').addEventListener('click', () => void closePreview());
document.getElementById('closePreviewFab').addEventListener('click', () => void closePreview());
maximizePreviewBtn.addEventListener('click', () => void togglePreviewFullscreen());
previewBody.addEventListener('dblclick', (event) => {
  if (event.button !== 0) return;
  if (event.target.closest('button, a, input, label')) return;
  if (Date.now() - previewOpenedAt < 400) return;
  if (document.fullscreenElement !== previewModal) return;
  event.preventDefault();
  void document.exitFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  updateMaximizePreviewButton();
  updateRecFullscreenButton();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && previewModal.classList.contains('active') && !document.fullscreenElement) {
    void closePreview();
  }
});
document.getElementById('rec-date').addEventListener('change', () => void loadRecordings());
document.getElementById('rec-member').addEventListener('change', () => void loadRecordings());
document.getElementById('rec-time').addEventListener('input', () => paintRecClipList());
document.getElementById('rec-time').addEventListener('change', () => paintRecClipList());
document.getElementById('act-date').addEventListener('change', () => void loadActivity());
document.getElementById('act-member').addEventListener('change', () => void loadActivity());
document.getElementById('act-filter').addEventListener('input', () => paintActivity());
document.getElementById('rec-prev').addEventListener('click', () => {
  const input = document.getElementById('rec-date');
  input.value = shiftDate(input.value, -1);
  void loadRecordings();
});
document.getElementById('rec-next').addEventListener('click', () => {
  const input = document.getElementById('rec-date');
  input.value = shiftDate(input.value, 1);
  void loadRecordings();
});
document.getElementById('act-prev').addEventListener('click', () => {
  const input = document.getElementById('act-date');
  input.value = shiftDate(input.value, -1);
  void loadActivity();
});
document.getElementById('act-next').addEventListener('click', () => {
  const input = document.getElementById('act-date');
  input.value = shiftDate(input.value, 1);
  void loadActivity();
});

document.addEventListener('click', () => closeScreenMenus());

if (window.admin) {
  window.admin.onMembers((members) => {
    applyMembers(members);
    if (state.watch) {
      const member = members.find((item) => item.machineId === state.watch.machineId);
      if (member) refreshOpenPreview(member);
    }
  });
  window.admin.onFrame(onFrame);

  bindQuality();
  window.admin.bootstrap().then((info) => {
    document.getElementById('adminHost').textContent = (info.addresses[0] && info.addresses[0].address) || 'This PC';
    renderAddresses(info);
    fillQuality(info.quality);
    document.getElementById('rec-date').value = today();
    document.getElementById('act-date').value = today();
    applyMembers(info.members);
    setInterval(() => {
      if (!window.admin.archiveDisk) return;
      window.admin.archiveDisk().then(paintDisk).catch(() => {});
    }, 15000);
  });
} else {
  bindQuality();
  fillQuality({
    liveQuality: 'low',
    recordFps: 10,
    recordWidth: 1920,
    segmentMinutes: 1,
    grid: '2x2',
    gridCols: 2,
    gridRows: 2,
    retentionDays: 14
  });
  document.getElementById('rec-date').value = today();
  document.getElementById('act-date').value = today();
  state.members = [{
    machineId: 'm_0123456789abcdef',
    hostname: 'LAPTOP-01',
    online: true,
    capture: 'recording',
    pendingSegments: 1,
    displays: [
      { index: 0, label: 'Display 1' },
      { index: 1, label: 'Display 2' }
    ]
  }, {
    machineId: 'm_fedcba9876543210',
    hostname: 'DESK-02',
    online: true,
    capture: 'recording',
    pendingSegments: 0,
    displays: [{ index: 0, label: 'Display 1' }]
  }];
  renderGrid();
}

setInterval(() => {
  if (!document.getElementById('view-recordings').hidden) void loadRecordings();
}, 15000);
