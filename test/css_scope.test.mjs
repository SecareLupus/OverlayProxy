import test from 'node:test';
import { strict as assert } from 'node:assert';
import { scopeCss } from '../src/css_scope.mjs';

test('scopeCss prefixes selectors and rewrites roots', async () => {
  const scope = '[data-ov=test]';
  const css = `html{color:red}\nbody{margin:0}\n.a{padding:1px}\n:root{--x:1}`;
  const out = await scopeCss(css, scope);
  const lines = out.trim().split(/\n/);
  assert.equal(lines[0], `:where(${scope}){color:red}`);
  assert.equal(lines[1], `:where(${scope}){margin:0}`);
  assert.equal(lines[2], `:where(${scope}) .a{padding:1px}`);
  assert.equal(lines[3], `:where(${scope}){--x:1}`);
});
