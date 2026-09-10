import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveProjectLabel } from '../lib/claude/index.js';

test('T1: an encoded project directory name decodes to a readable path, marked as derived', () => {
  const result = deriveProjectLabel('-Users-demo-sources-checkout-api');
  assert.equal(result.label, '/Users/demo/sources/checkout/api');
  assert.equal(result.derived, true);
});

test('T1: a directory name that is not path-like falls back to itself, still marked as derived', () => {
  const result = deriveProjectLabel('notes-cache');
  assert.equal(result.label, 'notes-cache');
  assert.equal(result.derived, true);
});
