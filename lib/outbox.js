'use strict';

const fs = require('fs');
const path = require('path');

function writeAtomic(file, contents) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, file);
}

class Outbox {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    fs.mkdirSync(directory, { recursive: true });
    this.state = { segments: [], activities: [] };
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed && Array.isArray(parsed.segments) && Array.isArray(parsed.activities)) {
          this.state = parsed;
        }
      } catch (_error) {
        this.state = { segments: [], activities: [] };
      }
    }
    let changed = false;
    this.state.segments.forEach((segment) => {
      if (segment.status === 'uploading') {
        segment.status = 'pending';
        changed = true;
      }
    });
    this.state.activities.forEach((activity) => {
      if (activity.status === 'uploading') {
        activity.status = 'pending';
        changed = true;
      }
    });
    if (changed) this.save();
  }

  save() {
    writeAtomic(this.file, JSON.stringify(this.state));
  }

  enqueueSegment({ segmentId, filePath, meta }) {
    if (this.state.segments.some((segment) => segment.segmentId === segmentId)) return;
    this.state.segments.push({
      segmentId,
      filePath,
      meta,
      status: 'pending'
    });
    this.save();
  }

  enqueueActivity(event) {
    if (this.state.activities.some((row) => row.event && row.event.id === event.id)) return;
    this.state.activities.push({ event, status: 'pending' });
    this.save();
  }

  pendingActivities() {
    return this.state.activities.filter((row) => row.status === 'pending');
  }

  nextPendingSegment() {
    return this.state.segments.find((segment) => segment.status === 'pending') || null;
  }

  nextPresentSegment() {
    return this.state.segments.find((segment) => {
      if (segment.status !== 'pending') return false;
      return Boolean(segment.filePath) && fs.existsSync(segment.filePath);
    }) || null;
  }

  missingPendingSegments() {
    return this.state.segments.filter((segment) => {
      if (segment.status !== 'pending') return false;
      return !segment.filePath || !fs.existsSync(segment.filePath);
    });
  }

  markSegment(segmentId, status) {
    const segment = this.state.segments.find((row) => row.segmentId === segmentId);
    if (!segment) return;
    segment.status = status;
    if (status === 'acked') {
      this.state.segments = this.state.segments.filter((row) => row.status !== 'acked' || row.segmentId === segmentId);
      const acked = this.state.segments.filter((row) => row.status === 'acked');
      if (acked.length > 40) {
        const keep = new Set(acked.slice(-20).map((row) => row.segmentId));
        this.state.segments = this.state.segments.filter((row) => row.status !== 'acked' || keep.has(row.segmentId));
      }
    }
    this.save();
  }

  ackActivities(ids) {
    const accepted = new Set(ids || []);
    this.state.activities.forEach((row) => {
      if (row.event && accepted.has(row.event.id)) row.status = 'acked';
    });
    this.state.activities = this.state.activities.filter((row) => row.status !== 'acked');
    this.save();
  }

  stats() {
    return {
      pendingSegments: this.state.segments.filter((row) => row.status === 'pending' || row.status === 'uploading').length,
      pendingActivities: this.state.activities.filter((row) => row.status === 'pending' || row.status === 'uploading').length
    };
  }

  clearFiles() {
    this.state.segments.forEach((segment) => {
      try { fs.rmSync(segment.filePath, { force: true }); } catch (_error) { /* already gone */ }
    });
    this.state = { segments: [], activities: [] };
    this.save();
  }
}

module.exports = { Outbox };
