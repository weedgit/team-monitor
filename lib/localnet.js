'use strict';

const dns = require('dns');

const LOCAL_ONLY = 'Use a local address. This app does not connect over the internet.';

function stripMapped(ip) {
  let value = String(ip || '').trim().toLowerCase();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (value.includes('%')) value = value.split('%')[0];
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  return value;
}

function ipv4Parts(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isLocalAddress(ip) {
  const value = stripMapped(ip);
  if (!value) return false;
  if (value === '::1') return true;
  if (value.includes(':')) {
    return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
  }
  const parts = ipv4Parts(value);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isLocalHostName(host) {
  const name = stripMapped(host);
  if (!name) return false;
  if (name === 'localhost') return true;
  if (name.endsWith('.local') || name.endsWith('.lan') || name.endsWith('.internal') || name.endsWith('.home')) {
    return true;
  }
  if (!name.includes('.')) return true;
  return isLocalAddress(name);
}

function localOnlyError() {
  const error = new Error(LOCAL_ONLY);
  error.code = 'ENOTLOCAL';
  return error;
}

function localDnsLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, options || {}, (err, address, family) => {
    if (err) {
      callback(err);
      return;
    }
    if (Array.isArray(address)) {
      const local = address.filter((item) => item && isLocalAddress(item.address));
      if (!local.length) {
        callback(localOnlyError());
        return;
      }
      callback(null, local);
      return;
    }
    if (!isLocalAddress(address)) {
      callback(localOnlyError());
      return;
    }
    callback(null, address, family);
  });
}

async function resolveLocalHost(host) {
  const name = stripMapped(host);
  if (isLocalAddress(name)) return name;
  const looked = await dns.promises.lookup(name);
  if (!isLocalAddress(looked.address)) throw localOnlyError();
  return looked.address;
}

module.exports = {
  LOCAL_ONLY,
  isLocalAddress,
  isLocalHostName,
  localDnsLookup,
  resolveLocalHost
};
