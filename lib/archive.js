'use strict';

const fs = require('fs');
const path = require('path');

const MACHINE_ID = /^m_[a-f0-9]{16}$/;
const SEGMENT_ID = /^seg_[a-f0-9]{16}$/;
const EVENT_ID = /^act_[a-f0-9]{16}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function assertMachineId(machineId) {
  if (!MACHINE_ID.test(String(machineId || ''))) {
    throw new Error('invalid machine id');
  }
  return machineId;
}

function assertSegmentId(segmentId) {
  if (!SEGMENT_ID.test(String(segmentId || ''))) {
    throw new Error('invalid segment id');
  }
  return segmentId;
}

function assertDisplayIndex(displayIndex) {
  const value = Number(displayIndex);
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new Error('invalid display');
  }
  return value;
}

function localDateString(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid date');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function clockLabel(value) {
  const date = new Date(value);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}-${minutes}-${seconds}`;
}

function safeFolderName(value) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  if (!cleaned || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) return 'Teammate';
  return cleaned;
}

function displayFolder(displayIndex) {
  return `Display ${displayIndex + 1}`;
}

function directoryHasMp4(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return directoryHasMp4(full);
    return entry.name.endsWith('.mp4');
  });
}

function replacePathPrefix(relative, from, to) {
  const rel = path.normalize(String(relative || ''));
  const prefix = path.normalize(from);
  if (rel === prefix) return to;
  const lead = `${prefix}${path.sep}`;
  if (rel.startsWith(lead)) return path.join(to, rel.slice(lead.length));
  return relative;
}

function writeAtomic(file, contents) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, file);
}

class Archive {
  constructor(root) {
    this.root = root;
    this.indexPath = path.join(root, 'index.json');
    fs.mkdirSync(root, { recursive: true });
    this.index = { segments: {} };
    if (fs.existsSync(this.indexPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
        if (parsed && parsed.segments && typeof parsed.segments === 'object') {
          this.index = parsed;
        }
      } catch (_error) {
        this.index = { segments: {} };
      }
    }
    if (!this.index.folders || typeof this.index.folders !== 'object' || Array.isArray(this.index.folders)) {
      this.index.folders = {};
    }
    this.rememberFolders();
    Object.keys(this.index.folders).forEach((machineId) => {
      const identity = this.readIdentity(machineId);
      if (identity && identity.hostname) this.ensurePerson(machineId, identity.hostname);
    });
  }

  saveIndex() {
    writeAtomic(this.indexPath, JSON.stringify(this.index));
  }

  rememberFolders() {
    let names = [];
    try {
      names = fs.readdirSync(this.root);
    } catch (_error) {
      return;
    }
    names.forEach((name) => {
      const directory = path.join(this.root, name);
      try {
        if (!fs.statSync(directory).isDirectory()) return;
      } catch (_error) {
        return;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8'));
        if (parsed && MACHINE_ID.test(parsed.machineId) && !this.index.folders[parsed.machineId]) {
          this.index.folders[parsed.machineId] = name;
        }
      } catch (_error) { /* a recording folder without an identity file yet */ }
    });
  }

  folderFor(machineId) {
    const mapped = this.index.folders && this.index.folders[machineId];
    if (mapped) return mapped;
    if (MACHINE_ID.test(String(machineId || '')) && fs.existsSync(path.join(this.root, machineId))) return machineId;
    return '';
  }

  ensurePerson(machineId, hostname) {
    assertMachineId(machineId);
    const preferred = safeFolderName(hostname);
    const taken = new Set();
    Object.entries(this.index.folders).forEach(([id, name]) => {
      if (id !== machineId && name) taken.add(String(name).toLowerCase());
    });
    let target = preferred;
    if (taken.has(target.toLowerCase())) {
      let count = 2;
      while (taken.has(`${preferred} (${count})`.toLowerCase())) count += 1;
      target = `${preferred} (${count})`;
    }
    const current = this.folderFor(machineId);
    if (current && current !== target) {
      const source = path.join(this.root, current);
      const destination = path.join(this.root, target);
      if (fs.existsSync(source) && !fs.existsSync(destination)) {
        fs.renameSync(source, destination);
        Object.values(this.index.segments).forEach((meta) => {
          if (meta.machineId !== machineId || !meta.relative) return;
          meta.relative = replacePathPrefix(meta.relative, current, target);
        });
      }
    }
    this.index.folders[machineId] = target;
    this.migratePerson(machineId, target);
    return target;
  }

  migratePerson(machineId, folder) {
    Object.values(this.index.segments).forEach((meta) => {
      if (meta.machineId !== machineId) return;
      const current = meta.relative ? path.resolve(this.root, meta.relative) : '';
      const directory = path.join(this.root, folder, displayFolder(meta.displayIndex), meta.date);
      fs.mkdirSync(directory, { recursive: true });
      const fileName = this.allocateMp4(directory, clockLabel(meta.startedAt), current);
      const nextFile = path.join(directory, fileName);
      if (current && fs.existsSync(current) && path.resolve(current) !== path.resolve(nextFile)) {
        fs.renameSync(current, nextFile);
        const sidecar = current.replace(/\.mp4$/, '.json');
        if (fs.existsSync(sidecar)) fs.renameSync(sidecar, nextFile.replace(/\.mp4$/, '.json'));
      }
      meta.fileName = fileName;
      meta.name = folder;
      meta.display = displayFolder(meta.displayIndex);
      meta.relative = path.relative(this.root, nextFile);
    });
    const person = path.join(this.root, folder);
    const legacy = path.join(person, 'activity');
    const modern = path.join(person, 'Activity');
    if (fs.existsSync(legacy)) {
      fs.mkdirSync(modern, { recursive: true });
      fs.readdirSync(legacy).forEach((name) => {
        const from = path.join(legacy, name);
        const to = path.join(modern, name);
        if (!fs.existsSync(to)) fs.renameSync(from, to);
      });
      fs.rmSync(legacy, { recursive: true, force: true });
    }
    const displays = path.join(person, 'displays');
    if (fs.existsSync(displays) && !directoryHasMp4(displays)) fs.rmSync(displays, { recursive: true, force: true });
    this.saveIndex();
  }

  allocateMp4(directory, base, keepPath) {
    let fileName = `${base}.mp4`;
    let count = 2;
    while (true) {
      const full = path.join(directory, fileName);
      if (!fs.existsSync(full) || (keepPath && path.resolve(full) === path.resolve(keepPath))) return fileName;
      fileName = `${base}-${count}.mp4`;
      count += 1;
    }
  }

  saveIdentity(member) {
    const machineId = String(member && member.machineId || '');
    const pcId = String(member && member.pcId || '').trim().toLowerCase();
    if (!MACHINE_ID.test(machineId) || !/^pc_[a-f0-9]{32}$/.test(pcId) || !member.memberToken) return;
    const folder = this.ensurePerson(machineId, member.hostname);
    const directory = path.join(this.root, folder);
    fs.mkdirSync(directory, { recursive: true });
    writeAtomic(path.join(directory, 'identity.json'), JSON.stringify({
      machineId,
      pcId,
      memberToken: member.memberToken,
      hostname: member.hostname || '',
      createdAt: member.createdAt || new Date().toISOString()
    }));
  }

  readIdentity(machineId) {
    if (!MACHINE_ID.test(String(machineId || ''))) return null;
    const folder = this.folderFor(machineId);
    if (!folder) return null;
    const file = path.join(this.root, folder, 'identity.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || parsed.machineId !== machineId || !parsed.memberToken) return null;
      return parsed;
    } catch (_error) {
      return null;
    }
  }

  findIdentity(pcId) {
    const id = String(pcId || '').trim().toLowerCase();
    if (!/^pc_[a-f0-9]{32}$/.test(id)) return null;
    let names = [];
    try {
      names = fs.readdirSync(this.root);
    } catch (_error) {
      return null;
    }
    for (const name of names) {
      const directory = path.join(this.root, name);
      try {
        if (!fs.statSync(directory).isDirectory()) continue;
      } catch (_error) {
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8'));
        if (parsed && String(parsed.pcId || '').toLowerCase() === id && parsed.memberToken && MACHINE_ID.test(parsed.machineId)) {
          return parsed;
        }
      } catch (_error) { /* next folder */ }
    }
    return null;
  }

  hasMachine(machineId) {
    const folder = this.folderFor(machineId);
    if (!folder) return false;
    try {
      return fs.statSync(path.join(this.root, folder)).isDirectory();
    } catch (_error) {
      return false;
    }
  }

  hasSegment(segmentId) {
    assertSegmentId(segmentId);
    return Boolean(this.index.segments[segmentId]);
  }

  saveSegment(input) {
    const machineId = assertMachineId(input.machineId);
    const segmentId = assertSegmentId(input.segmentId);
    const displayIndex = assertDisplayIndex(input.displayIndex);
    if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0) {
      throw new Error('empty segment');
    }
    if (this.index.segments[segmentId]) {
      return { duplicate: true, ...this.index.segments[segmentId] };
    }

    const startedAt = new Date(input.startedAt);
    const endedAt = new Date(input.endedAt);
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
      throw new Error('invalid segment time');
    }

    const date = localDateString(startedAt);
    const folder = this.ensurePerson(machineId, input.hostname);
    const directory = path.join(this.root, folder, displayFolder(displayIndex), date);
    fs.mkdirSync(directory, { recursive: true });
    const fileName = this.allocateMp4(directory, clockLabel(startedAt));
    const filePath = path.join(directory, fileName);
    const meta = {
      segmentId,
      machineId,
      name: folder,
      display: displayFolder(displayIndex),
      displayIndex,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      frameCount: Number(input.frameCount) || 0,
      width: Number(input.width) || 0,
      height: Number(input.height) || 0,
      fileName,
      date
    };
    writeAtomic(filePath, input.buffer);
    writeAtomic(path.join(directory, fileName.replace(/\.mp4$/, '.json')), JSON.stringify(meta, null, 2));
    this.index.segments[segmentId] = {
      ...meta,
      relative: path.relative(this.root, filePath)
    };
    this.saveIndex();
    return { duplicate: false, ...this.index.segments[segmentId] };
  }

  listSegments({ machineId, date, displayIndex }) {
    assertMachineId(machineId);
    const display = displayIndex === undefined || displayIndex === null || displayIndex === ''
      ? null
      : assertDisplayIndex(displayIndex);
    if (date && !DATE_KEY.test(String(date))) return [];
    return Object.values(this.index.segments)
      .filter((segment) => segment.machineId === machineId)
      .filter((segment) => !date || segment.date === date)
      .filter((segment) => display === null || segment.displayIndex === display)
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  }

  readSegment(segmentId) {
    assertSegmentId(segmentId);
    const meta = this.index.segments[segmentId];
    if (!meta) return null;
    const full = path.resolve(this.root, meta.relative);
    const root = `${path.resolve(this.root)}${path.sep}`;
    if (full !== path.resolve(this.root) && !full.startsWith(root)) {
      throw new Error('segment path escaped archive');
    }
    return { meta, buffer: fs.readFileSync(full) };
  }

  findCovering(machineId, displayIndex, at) {
    const date = localDateString(at);
    const display = assertDisplayIndex(displayIndex);
    const time = new Date(at).getTime();
    const days = [date, shiftDateKey(date, -1)];
    const hits = days.flatMap((day) => this.listSegments({ machineId, date: day, displayIndex: display }))
      .filter((segment) => {
        const start = new Date(segment.startedAt).getTime();
        const end = new Date(segment.endedAt).getTime();
        return start <= time && time <= end;
      });
    hits.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    return hits[0] || null;
  }

  appendActivity(machineId, events, hostname) {
    assertMachineId(machineId);
    const folder = this.ensurePerson(machineId, hostname);
    const accepted = [];
    const groups = new Map();
    (events || []).forEach((event) => {
      if (!event || !EVENT_ID.test(String(event.id || ''))) return;
      const at = new Date(event.at);
      if (Number.isNaN(at.getTime())) return;
      let displayIndex = 0;
      try {
        displayIndex = assertDisplayIndex(event.displayIndex ?? 0);
      } catch (_error) {
        return;
      }
      const date = localDateString(at);
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push({
        id: event.id,
        at: at.toISOString(),
        app: String(event.app || '').slice(0, 120),
        title: String(event.title || '').slice(0, 300),
        displayIndex
      });
    });

    for (const [date, list] of groups) {
      const directory = path.join(this.root, folder, 'Activity');
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${date}.json`);
      let existing = [];
      if (fs.existsSync(file)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          existing = Array.isArray(parsed) ? parsed : [];
        } catch (_error) {
          existing = [];
        }
      }
      const seen = new Set(existing.map((event) => event.id));
      list.forEach((event) => {
        if (!seen.has(event.id)) {
          existing.push(event);
          seen.add(event.id);
        }
        accepted.push(event.id);
      });
      existing.sort((a, b) => new Date(a.at) - new Date(b.at));
      if (existing.length > 10000) existing = existing.slice(existing.length - 10000);
      writeAtomic(file, JSON.stringify(existing));
    }
    return accepted;
  }

  listActivity(machineId, date) {
    assertMachineId(machineId);
    if (!DATE_KEY.test(String(date || ''))) return [];
    const folder = this.folderFor(machineId) || machineId;
    const modern = path.join(this.root, folder, 'Activity', `${date}.json`);
    const legacy = path.join(this.root, folder, 'activity', `${date}.json`);
    const file = fs.existsSync(modern) ? modern : legacy;
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  prune(retentionDays, now = new Date()) {
    const cutoff = new Date(now);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - Number(retentionDays));
    const cutoffKey = localDateString(cutoff);
    const removed = [];
    Object.entries(this.index.segments).forEach(([segmentId, meta]) => {
      if (meta.date >= cutoffKey) return;
      const full = path.resolve(this.root, meta.relative);
      fs.rmSync(full, { force: true });
      fs.rmSync(full.replace(/\.mp4$/, '.json'), { force: true });
      delete this.index.segments[segmentId];
      removed.push(segmentId);
    });
    this.saveIndex();

    fs.readdirSync(this.root).forEach((name) => {
      const directory = path.join(this.root, name);
      let stat;
      try {
        stat = fs.statSync(directory);
      } catch (_error) {
        return;
      }
      if (!stat.isDirectory()) return;
      ['Activity', 'activity'].forEach((label) => {
        const activityDir = path.join(directory, label);
        if (!fs.existsSync(activityDir)) return;
        fs.readdirSync(activityDir).forEach((fileName) => {
          const date = fileName.replace(/\.json$/, '');
          if (DATE_KEY.test(date) && date < cutoffKey) {
            fs.rmSync(path.join(activityDir, fileName), { force: true });
          }
        });
      });
    });
    return removed;
  }
}

module.exports = {
  Archive,
  localDateString,
  assertMachineId,
  assertSegmentId,
  assertDisplayIndex,
  MACHINE_ID,
  SEGMENT_ID,
  EVENT_ID
};
