'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isLocalAddress, isLocalHostName, resolveLocalHost, localDnsLookup } = require('../lib/localnet');

test('only loopback, private, and link-local addresses count as local', () => {
  assert.equal(isLocalAddress('127.0.0.1'), true);
  assert.equal(isLocalAddress('::1'), true);
  assert.equal(isLocalAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLocalAddress('10.1.2.3'), true);
  assert.equal(isLocalAddress('192.168.1.20'), true);
  assert.equal(isLocalAddress('172.16.0.4'), true);
  assert.equal(isLocalAddress('169.254.10.2'), true);
  assert.equal(isLocalAddress('fd12:3456::1'), true);
  assert.equal(isLocalAddress('8.8.8.8'), false);
  assert.equal(isLocalAddress('1.1.1.1'), false);
  assert.equal(isLocalAddress('100.64.0.1'), false);
  assert.equal(isLocalAddress('2001:4860:4860::8888'), false);
});

test('local host names stay on this PC or the LAN', () => {
  assert.equal(isLocalHostName('localhost'), true);
  assert.equal(isLocalHostName('ADMIN-PC'), true);
  assert.equal(isLocalHostName('office.local'), true);
  assert.equal(isLocalHostName('192.168.0.5'), true);
  assert.equal(isLocalHostName('example.com'), false);
  assert.equal(isLocalHostName('8.8.8.8'), false);
});

test('DNS lookup of a public host is refused', async () => {
  assert.equal(await resolveLocalHost('127.0.0.1'), '127.0.0.1');
  await assert.rejects(() => resolveLocalHost('8.8.8.8'));
  await new Promise((resolve, reject) => {
    localDnsLookup('1.1.1.1', (error) => {
      try {
        assert.equal(Boolean(error), true);
        assert.equal(error.code, 'ENOTLOCAL');
        resolve();
      } catch (failed) {
        reject(failed);
      }
    });
  });
});
