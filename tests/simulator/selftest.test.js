'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SelfTest = require('../../simulator/js/sim/selftest.js');

test('browser self-test suite also passes in Node', async () => {
  const res = await SelfTest.run();
  for (const r of res) assert.ok(r.ok, r.name + ': ' + r.err);
});
