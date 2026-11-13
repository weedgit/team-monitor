'use strict';

const fs = require('fs');
const { newMachineId, newToken, tokenEqual } = require('./token');

const MACHINE_ID = /^m_[a-f0-9]{16}$/;

function writeAtomic(file, contents) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, file);
}

function normalizeName(hostname) {
  return String(hostname || 'Teammate').replace(/[\r\n]/g, ' ').trim().slice(0, 64) || 'Teammate';
}

function normalizePcId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^pc_[a-f0-9]{32}$/.test(id) ? id : '';
}

function publicMember(member) {
  return {
    machineId: member.machineId,
    hostname: member.hostname,
    createdAt: member.createdAt,
    displays: member.displays || [],
    online: Boolean(member.online),
    lastSeen: member.lastSeen || null,
    capture: member.capture || 'offline',
    pendingSegments: Number(member.pendingSegments) || 0,
    holdNetwork: Boolean(member.holdNetwork)
  };
}

class MemberStore {
  constructor(file, options = {}) {
    this.file = file;
    this.maxMembers = options.maxMembers || 10;
    this.data = { members: [] };
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object') this.data = parsed;
      } catch (_error) {
        this.data = { members: [] };
      }
    }
    if (!Array.isArray(this.data.members)) this.data.members = [];
    if (!this.data.retired || typeof this.data.retired !== 'object' || Array.isArray(this.data.retired)) {
      this.data.retired = {};
    }
    this.data.members.forEach((member) => {
      member.online = false;
    });
    this.save();
  }

  save() {
    fs.mkdirSync(require('path').dirname(this.file), { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  identities() {
    const rows = this.data.members.map((member) => ({
      machineId: member.machineId,
      memberToken: member.memberToken,
      pcId: member.pcId,
      hostname: member.hostname,
      createdAt: member.createdAt
    }));
    Object.entries(this.data.retired).forEach(([pcId, prior]) => {
      if (!prior || !prior.machineId) return;
      rows.push({
        machineId: prior.machineId,
        memberToken: prior.memberToken,
        pcId: prior.pcId || pcId,
        hostname: prior.hostname,
        createdAt: prior.createdAt
      });
    });
    return rows;
  }

  takeStale({ pcId, keepId }) {
    const id = normalizePcId(pcId);
    if (!id) return [];
    const removed = [];
    this.data.members = this.data.members.filter((member) => {
      if (keepId && member.machineId === keepId) return true;
      if (member.pcId !== id) return true;
      removed.push(member.machineId);
      return false;
    });
    if (removed.length) this.save();
    return removed;
  }

  remove(machineId) {
    const member = this.byId(machineId);
    if (!member) return false;
    this.data.members = this.data.members.filter((item) => item.machineId !== machineId);
    if (member.pcId) {
      this.data.retired[member.pcId] = {
        machineId: member.machineId,
        memberToken: member.memberToken,
        hostname: member.hostname,
        createdAt: member.createdAt
      };
    }
    this.save();
    return true;
  }

  blankMember(fields) {
    return {
      displays: [],
      online: false,
      lastSeen: null,
      capture: 'offline',
      pendingSegments: 0,
      holdNetwork: false,
      ...fields
    };
  }

  restore(prior, { hostname, pcId }) {
    if (this.byId(prior.machineId)) {
      const existing = this.byId(prior.machineId);
      if (pcId && !existing.pcId) existing.pcId = normalizePcId(pcId);
      existing.hostname = hostname;
      this.save();
      return existing;
    }
    if (this.data.members.length >= this.maxMembers) {
      const error = new Error('This admin already has the maximum number of teammates.');
      error.status = 403;
      throw error;
    }
    const id = normalizePcId(pcId);
    const member = this.blankMember({
      machineId: prior.machineId,
      memberToken: prior.memberToken,
      hostname,
      pcId: id,
      createdAt: prior.createdAt || new Date().toISOString()
    });
    Object.entries(this.data.retired).forEach(([key, value]) => {
      if (key === id || (value && value.machineId === member.machineId)) delete this.data.retired[key];
    });
    this.data.members.push(member);
    this.save();
    return member;
  }

  enroll({ hostname, pcId, machineId, remembered }) {
    const name = normalizeName(hostname);
    const id = normalizePcId(pcId);
    const requestedId = MACHINE_ID.test(String(machineId || '')) ? String(machineId) : '';
    if (id) {
      const existing = this.data.members.find((member) => member.pcId === id);
      if (existing) {
        existing.hostname = name;
        this.save();
        return existing;
      }
      const prior = this.data.retired[id];
      if (prior && prior.machineId && prior.memberToken) {
        return this.restore(prior, { hostname: name, pcId: id });
      }
    }
    if (requestedId) {
      const claimed = this.byId(requestedId);
      if (claimed && (!normalizePcId(claimed.pcId) || claimed.pcId === id)) {
        if (id) claimed.pcId = id;
        claimed.hostname = name;
        this.save();
        return claimed;
      }
      const retired = Object.values(this.data.retired).find((item) => item && item.machineId === requestedId);
      if (retired && retired.memberToken && (!normalizePcId(retired.pcId) || retired.pcId === id)) {
        return this.restore(retired, { hostname: name, pcId: id || retired.pcId });
      }
    }
    if (remembered && remembered.machineId && remembered.memberToken) {
      const rememberedPc = normalizePcId(remembered.pcId);
      if (!rememberedPc || rememberedPc === id) {
        return this.restore(remembered, { hostname: name, pcId: id || rememberedPc });
      }
    }
    if (this.data.members.length >= this.maxMembers) {
      const error = new Error('This admin already has the maximum number of teammates.');
      error.status = 403;
      throw error;
    }
    const member = this.blankMember({
      machineId: newMachineId(),
      memberToken: newToken(),
      hostname: name,
      pcId: id,
      createdAt: new Date().toISOString()
    });
    this.data.members.push(member);
    this.save();
    return member;
  }

  byToken(token) {
    return this.data.members.find((member) => tokenEqual(member.memberToken, token)) || null;
  }

  byId(machineId) {
    return this.data.members.find((member) => member.machineId === machineId) || null;
  }

  update(machineId, patch, options = {}) {
    const member = this.byId(machineId);
    if (!member) return null;
    Object.assign(member, patch);
    if (options.persist !== false) this.save();
    return member;
  }

  list() {
    return this.data.members.map(publicMember);
  }
}

module.exports = { MemberStore };
