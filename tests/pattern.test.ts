import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendPoint, normalizePattern } from '../src/pattern.ts';

test('skipped midpoint is inserted horizontally, vertically and diagonally', () => {
  assert.deepEqual(appendPoint([1], 3), [1, 2, 3]);
  assert.deepEqual(appendPoint([1], 7), [1, 4, 7]);
  assert.deepEqual(appendPoint([1], 9), [1, 5, 9]);
  assert.equal(normalizePattern('1397'), '1236987');
  assert.equal(normalizePattern('14789'), '14789');
});
test('visited dots are never repeated, including previously visited midpoints', () => {
  assert.deepEqual(appendPoint([2, 1], 3), [2, 1, 3]);
  assert.deepEqual(appendPoint([1, 2, 3], 1), [1, 2, 3]);
  assert.deepEqual(appendPoint([1, 2], 6), [1, 2, 6]);
});
test('patterns require at least four distinct dots and canonicalization is stable', () => {
  for (const value of ['', '123', '1111', '0123', '1230', 'abcdef', '1234567891']) assert.throws(() => normalizePattern(value));
  for (const value of ['14789', '1397', '9512', '123456789']) assert.equal(normalizePattern(normalizePattern(value)), normalizePattern(value));
  assert.throws(() => appendPoint([], 10));
});
