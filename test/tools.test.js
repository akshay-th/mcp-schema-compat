import test from 'node:test';
import assert from 'node:assert/strict';
import { coercePaths, decodeArguments, fixTools, lintTools, sanitizeToolName } from '../src/index.js';

test('tool names are sanitized per target', () => {
  assert.equal(sanitizeToolName('search.files', 'openai'), 'search_files');
  assert.equal(sanitizeToolName('search.files', 'gemini'), 'search.files');
  assert.equal(sanitizeToolName('1password', 'gemini'), '_1password');
  assert.equal(sanitizeToolName('x'.repeat(80), 'anthropic').length, 64);
  assert.equal(sanitizeToolName('ok_name-1', 'anthropic'), 'ok_name-1');
});

test('fixTools keeps names unique and reports renames', () => {
  const { tools, renames } = fixTools(
    [
      { name: 'a.b', inputSchema: { type: 'object' } },
      { name: 'a b', inputSchema: { type: 'object' } },
      { name: 'a_b', inputSchema: { type: 'object' } },
    ],
    'openai',
  );
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, 3);
  assert.equal(renames[names[0]], 'a.b');
  assert.equal(renames[names[1]], 'a b');
});

test('fixTools keeps the tool shape (parameters / input_schema)', () => {
  const { tools } = fixTools([{ name: 't', parameters: { properties: { a: { type: ['string', 'null'] } } } }], 'gemini');
  assert.deepEqual(tools[0], { name: 't', parameters: { type: 'object', properties: { a: { type: 'string', nullable: true } } } });
  const r = fixTools([{ name: 't', input_schema: { anyOf: [{ properties: { a: { type: 'string' } } }] } }], 'anthropic');
  assert.equal(r.tools[0].input_schema.type, 'object');
});

test('lintTools flags too many tools for OpenAI', () => {
  const tools = Array.from({ length: 130 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object' } }));
  const report = lintTools(tools, 'openai');
  assert.equal(report.warnings[0].rule, 'max-tools');
  assert.equal(lintTools(tools, 'anthropic').warnings.length, 0);
});

test('coercePaths walks properties and items, skips combinators', () => {
  assert.deepEqual(
    coercePaths([
      { coerce: 'json-string', path: '/properties/a' },
      { coerce: 'json-string', path: '/properties/list/items/properties/meta' },
      { coerce: 'json-string', path: '/properties/u/anyOf/0' },
      { path: '/properties/b' },
    ]),
    [['a'], ['list', '*', 'meta']],
  );
});

test('decodeArguments parses JSON strings back into objects', () => {
  const args = { a: '{"x":1}', list: [{ meta: '{"k":"v"}' }, { meta: 'not json' }], other: '{"y":2}' };
  const out = decodeArguments(args, [['a'], ['list', '*', 'meta']]);
  assert.deepEqual(out, { a: { x: 1 }, list: [{ meta: { k: 'v' } }, { meta: 'not json' }], other: '{"y":2}' });
  assert.equal(args.a, '{"x":1}', 'input not mutated');
});

test('fixTools exposes coercion paths for free-form objects', () => {
  const { coerce } = fixTools(
    [{ name: 'http', inputSchema: { type: 'object', properties: { headers: { type: 'object' } } } }],
    'gemini',
  );
  assert.deepEqual(coerce, { http: [['headers']] });
});
