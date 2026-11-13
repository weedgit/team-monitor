'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function tokenEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || left.length > 128 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function hex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function newMachineId() {
  return `m_${hex(8)}`;
}

function newSegmentId() {
  return `seg_${hex(8)}`;
}

function newEventId() {
  return `act_${hex(8)}`;
}

function newToken() {
  return hex(24);
}

function newCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function loadOrCreateAdminToken(file) {
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing) return existing;
    }
  } catch (_error) {
    /* regenerate below */
  }
  const token = newToken();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { encoding: 'utf8' });
  return token;
}

module.exports = {
  tokenEqual,
  newMachineId,
  newSegmentId,
  newEventId,
  newToken,
  newCode,
  loadOrCreateAdminToken
};
