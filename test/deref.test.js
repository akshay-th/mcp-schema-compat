import test from 'node:test';
import assert from 'node:assert/strict';
import { deref } from '../src/deref.js';

test('inlines $defs refs and drops $defs', () => {
  const { schema, changes } = deref({
    type: 'object',
    properties: { user: { $ref: '#/$defs/User' } },
    $defs: { User: { type: 'object', properties: { id: { type: 'string' } } } },
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: { user: { type: 'object', properties: { id: { type: 'string' } } } },
  });
  assert.ok(changes.some((c) => c.rule === 'inline-ref'));
});

test('supports legacy definitions and sibling keywords next to $ref', () => {
  const { schema } = deref({
    properties: { a: { $ref: '#/definitions/A', description: 'override' } },
    definitions: { A: { type: 'string', description: 'original' } },
  });
  assert.deepEqual(schema.properties.a, { type: 'string', description: 'override' });
  assert.equal(schema.definitions, undefined);
});

test('cuts recursive refs when keepRecursive is false', () => {
  const { schema, changes, recursive } = deref({
    $defs: {
      Node: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } } },
    },
    $ref: '#/$defs/Node',
  });
  assert.equal(recursive, true);
  assert.deepEqual(schema.properties.children.items, { type: 'object' });
  assert.ok(changes.some((c) => c.rule === 'recursive-ref' && c.lossy));
});

test('keeps recursive refs under $defs when keepRecursive is true', () => {
  const { schema } = deref(
    {
      $defs: {
        Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } },
      },
      type: 'object',
      properties: { head: { $ref: '#/$defs/Node' } },
    },
    { keepRecursive: true },
  );
  assert.deepEqual(schema.properties.head.properties.next, { $ref: '#/$defs/Node' });
  assert.deepEqual(schema.$defs.Node.properties.next, { $ref: '#/$defs/Node' });
});

test('unresolvable refs are reported, not thrown', () => {
  const { schema, changes } = deref({ properties: { a: { $ref: 'https://example.com/x.json', description: 'd' } } });
  assert.deepEqual(schema.properties.a, { description: 'd' });
  assert.equal(changes[0].rule, 'unresolved-ref');
});

test('json pointer escapes are decoded', () => {
  const { schema } = deref({
    properties: { a: { $ref: '#/$defs/a~1b' } },
    $defs: { 'a/b': { type: 'integer' } },
  });
  assert.deepEqual(schema.properties.a, { type: 'integer' });
});
