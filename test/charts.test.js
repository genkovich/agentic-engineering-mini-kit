// Unit tests for the chart primitives. They are pure string builders, so the tests call them
// directly with the smallest inputs that expose an edge — above all the empty bucket array.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnChart, sparkline, shareBar, segmented, mark, slotOf } from '../views/charts.js';

const options = {
  key: 'turns',
  label: 'tokens per turn',
  series: (b) => [{ value: b.value, fill: 'var(--tok-out)' }],
  tip: (b) => ({ title: b.label, subtitle: '', rows: [] }),
  fallback: (b) => `${b.label}: ${b.value}`,
  formatMax: String,
};

test('C1: an empty bucket array renders the bare frame instead of throwing', () => {
  const html = columnChart([], options);
  assert.match(html, /data-chart="turns"/);
  assert.match(html, /aria-label="tokens per turn"/);
  assert.doesNotMatch(html, /<g class="col"/, 'no columns without buckets');
  assert.match(html, /No activity to chart yet\./);
});

test('C1: buckets draw one column each and label the axis from bucket.label', () => {
  const html = columnChart([{ label: '1', value: 3 }, { label: '2', value: 0 }], options);
  assert.equal((html.match(/<g class="col"/g) || []).length, 2);
  assert.match(html, /text-anchor="middle">1</);
  assert.match(html, /text-anchor="middle">2</);
  assert.doesNotMatch(html, /style="/, 'inline styles are blocked by the CSP');
});

test('C2: sparkline highlights the last bar and counts the active buckets', () => {
  const html = sparkline([0, 2, 5]);
  assert.match(html, /aria-label="2 active days of 3"/);
  assert.equal((html.match(/<rect/g) || []).length, 2, 'empty buckets draw nothing');
  assert.match(html, /<rect class="hot"/);
});

test('C2: shareBar lays segments out in percent of the total', () => {
  const html = shareBar([{ value: 75, cls: 'model-0', title: 'a' }, { value: 25, cls: 'model-1', title: 'b' }]);
  assert.match(html, /<rect class="model-0" x="0.00" width="74.60"/);
  assert.match(html, /<rect class="model-1" x="75.00" width="24.60"/);
});

test('C3: segmented marks the current item and mark() reads the colors map explicitly', () => {
  assert.match(segmented([{ label: '10', to: '/?limit=10', on: true }]), /aria-current="true"/);
  assert.equal(slotOf({ '-a': 2 }, '-a'), 2);
  assert.equal(slotOf({}, '-a'), null);
  assert.equal(mark({ '-a': 2 }, '-a'), '<span class="mark mark-2"></span>');
  assert.equal(mark({}, '-a'), '<span class="mark mark-other"></span>');
});
