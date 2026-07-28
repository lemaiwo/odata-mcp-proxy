import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assembleTemplate, injectData, clearTemplateCache } from '../src/ui/templates.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

beforeEach(() => clearTemplateCache());

test('assembleTemplate reads the template relative to the config dir', () => {
  const html = assembleTemplate(fixturesDir, 'ui/hello.html');
  assert.match(html, /const DATA = "__DATA__";/);
});

test('assembleTemplate inlines partials at their token', () => {
  const html = assembleTemplate(fixturesDir, 'ui/hello.html', { '/*__STYLE__*/': 'ui/style.css' });
  assert.match(html, /shared-style-marker/);
  assert.ok(!html.includes('/*__STYLE__*/'), 'token should be replaced');
});

test('assembleTemplate throws for a missing template file', () => {
  assert.throws(() => assembleTemplate(fixturesDir, 'ui/does-not-exist.html'), /ENOENT/);
});

test('injectData replaces the quoted __DATA__ token with JSON', () => {
  const html = injectData('const DATA = "__DATA__";', { view: 'X', params: {}, data: {} });
  assert.equal(html, 'const DATA = {"view":"X","params":{},"data":{}};');
});

test('injectData escapes < so strings cannot close the script tag', () => {
  const html = injectData('const DATA = "__DATA__";', { evil: '</script><script>alert(1)' });
  assert.ok(!html.includes('</script>'), 'must not contain a literal closing script tag');
  assert.ok(html.includes('\\u003c/script>'), 'must contain the escaped form');
});

test('injectData with null produces the data-less template variant', () => {
  const html = injectData('const DATA = "__DATA__";', null);
  assert.equal(html, 'const DATA = null;');
});

test('injectData does not mangle $-sequences in the payload', () => {
  const html = injectData('const DATA = "__DATA__";', { q: "$filter=Name eq 'x' and $'&'" });
  assert.ok(html.includes("$filter=Name eq 'x'"));
});
