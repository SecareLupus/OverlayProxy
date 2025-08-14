import test from 'node:test';
import { strict as assert } from 'node:assert';
import { isAbsolute, toAbs } from '../src/util.mjs';

test('isAbsolute distinguishes absolute and relative URLs', () => {
  assert.equal(isAbsolute('https://example.com/a'), true);
  assert.equal(isAbsolute('//example.com/b'), true);
  assert.equal(isAbsolute('/c/d'), false);
  assert.equal(isAbsolute('e/f'), false);
});

test('toAbs resolves relative URLs against a base', () => {
  const base = 'https://example.com/a/b/';
  assert.equal(toAbs(base, 'c/d.js'), 'https://example.com/a/b/c/d.js');
  assert.equal(toAbs(base, '../e/style.css'), 'https://example.com/a/e/style.css');
  assert.equal(toAbs(base, 'https://other.com/x'), 'https://other.com/x');
});

