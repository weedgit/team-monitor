'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { screenChanged } = require('../lib/framechange');

test('a still screen is unchanged and a real pixel change is not', () => {
  const still = Buffer.alloc(16, 0);
  still[3] = 255;
  still[7] = 255;
  still[11] = 255;
  still[15] = 255;
  assert.equal(screenChanged(still, Buffer.from(still)), false);

  const moved = Buffer.from(still);
  moved[0] = 80;
  assert.equal(screenChanged(still, moved), true);
  assert.equal(screenChanged(null, still), true);

  const noise = Buffer.from(still);
  noise[0] = 8;
  assert.equal(screenChanged(still, noise), false);

  const typed = Buffer.from(still);
  typed[0] = 20;
  typed[4] = 20;
  typed[8] = 20;
  typed[12] = 20;
  assert.equal(screenChanged(still, typed), true);
});
