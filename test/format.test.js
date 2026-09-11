// Unit tests for the shared value formatters. Table-driven: every case is one input and the
// exact string it must produce, so a change of scheme shows up as a diff, not as a surprise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanSize, humanCount, formatMtime, isoMtime, shortDay, formatDuration, formatUsd, relativeTime } from '../views/format.js';

const cases = (pairs, fn) => {
  for (const [input, expected] of pairs) assert.equal(fn(input), expected, `${JSON.stringify(input)}`);
};

test('F1: humanSize steps through the byte units', () => {
  cases([[0, '0 B'], [999, '999 B'], [1024, '1.0 KB'], [1536, '1.5 KB'], [1048576, '1.0 MB'], [3 * 1024 ** 3, '3.0 GB']], humanSize);
});

test('F1: humanCount abbreviates thousands and millions', () => {
  cases([[0, '0'], [975, '975'], [3265, '3.3K'], [162900, '163K'], [999999, '1000K'], [2400000, '2.4M']], humanCount);
});

test('F1: formatMtime and isoMtime render a fixed local-time field', () => {
  const t = new Date(2026, 7, 20, 9, 5, 3).getTime();
  assert.equal(formatMtime(t), '20 Aug 2026, 09:05');
  assert.equal(isoMtime(t), '2026-08-20 09:05:03');
});

test('F1: shortDay drops the year and the time', () => {
  cases([['2026-08-20', '20 Aug'], ['2026-01-01', '1 Jan'], ['2026-12-31', '31 Dec']], shortDay);
});

test('F2: formatDuration keeps at most two units', () => {
  cases([
    [0, '0s'], [-5, '0s'], [999, '0s'], [45000, '45s'],
    [200000, '3m 20s'], [3600000, '1h 00m'], [7500000, '2h 05m'],
    [97200000, '1d 3h'], [Number.NaN, '0s'],
  ], formatDuration);
});

test('F2: formatUsd shows four decimals below a cent', () => {
  cases([[0, '$0.00'], [0.0042, '$0.0042'], [0.01, '$0.01'], [12.3, '$12.30'], [1234.5, '$1234.50'], [-0.5, '-$0.50']], formatUsd);
});

test('F2: relativeTime coarsens, then falls back to the date past two weeks', () => {
  const now = new Date(2026, 7, 20, 12, 0, 0).getTime();
  const ago = (ms) => relativeTime(now - ms, now);
  assert.equal(ago(0), 'just now');
  assert.equal(ago(30000), 'just now');
  assert.equal(ago(5 * 60000), '5 min ago');
  assert.equal(ago(2 * 3600000), '2 h ago');
  assert.equal(ago(26 * 3600000), 'yesterday');
  assert.equal(ago(3 * 86400000), '3 days ago');
  assert.equal(ago(14 * 86400000), '14 days ago');
  assert.equal(ago(20 * 86400000), formatMtime(now - 20 * 86400000));
});
