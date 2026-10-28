import test from 'node:test';
import assert from 'node:assert/strict';
import { fixSchema } from '../src/transform.js';

const rules = (changes) => changes.map((c) => c.rule);

test('gemini: strips unsupported keywords and keeps constraints as hints', () => {
  const { schema, changes } = fixSchema(
    {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        n: { type: 'number', exclusiveMinimum: 0, multipleOf: 5 },
        tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      },
      required: ['n'],
    },
    'gemini',
  );
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      n: { type: 'number', minimum: 0, description: '(> 0; multiple of 5)' },
      tags: { type: 'array', items: { type: 'string' }, description: '(items must be unique)' },
    },
    required: ['n'],
  });
  assert.ok(rules(changes).includes('exclusiveMinimum'));
  assert.ok(rules(changes).includes('unsupported-keyword'));
});

test('gemini: type arrays and null branches become nullable', () => {
  const { schema } = fixSchema(
    {
      type: 'object',
      properties: {
        a: { type: ['string', 'null'] },
        b: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'b' },
        c: { type: ['string', 'number'] },
      },
    },
    'gemini',
  );
  assert.deepEqual(schema.properties.a, { type: 'string', nullable: true });
  assert.deepEqual(schema.properties.b, { type: 'integer', nullable: true, description: 'b' });
  assert.deepEqual(schema.properties.c, { anyOf: [{ type: 'string' }, { type: 'number' }] });
});

test('gemini: const, oneOf, allOf, examples', () => {
  const { schema } = fixSchema(
    {
      type: 'object',
      properties: {
        kind: { const: 'circle' },
        shape: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        merged: {
          allOf: [
            { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
            { properties: { y: { type: 'number' } }, required: ['y'] },
          ],
        },
        e: { type: 'string', examples: ['hi', 'there'] },
      },
    },
    'gemini',
  );
  assert.deepEqual(schema.properties.kind, { enum: ['circle'] });
  assert.deepEqual(schema.properties.shape, { anyOf: [{ type: 'string' }, { type: 'integer' }] });
  assert.deepEqual(schema.properties.merged, {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' } },
    required: ['x', 'y'],
  });
  assert.deepEqual(schema.properties.e, { type: 'string', example: 'hi' });
});

test('gemini: non-string enums move to the description', () => {
  const { schema, changes } = fixSchema(
    { type: 'object', properties: { level: { type: 'integer', enum: [1, 2, 3] } } },
    'gemini',
  );
  assert.deepEqual(schema.properties.level, { type: 'integer', description: '(one of: 1, 2, 3)' });
  assert.ok(changes.find((c) => c.rule === 'enum-type').lossy);
});

test('gemini: unsupported formats move to the description', () => {
  const { schema } = fixSchema(
    {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'Link' },
        when: { type: 'string', format: 'date-time' },
        n: { type: 'integer', format: 'int64' },
      },
    },
    'gemini',
  );
  assert.deepEqual(schema.properties.url, { type: 'string', description: 'Link (format: uri)' });
  assert.equal(schema.properties.when.format, 'date-time');
  assert.equal(schema.properties.n.format, 'int64');
});

test('gemini: free-form nested objects become JSON strings and are flagged for coercion', () => {
  const { schema, changes } = fixSchema(
    {
      type: 'object',
      properties: {
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'HTTP headers' },
      },
    },
    'gemini',
  );
  assert.deepEqual(schema.properties.headers, { type: 'string', description: 'HTTP headers (JSON-encoded object)' });
  const c = changes.find((x) => x.rule === 'free-form-object');
  assert.equal(c.coerce, 'json-string');
  assert.equal(c.path, '/properties/headers');
});

test('gemini: empty root properties are dropped', () => {
  const { schema } = fixSchema({ type: 'object', properties: {} }, 'gemini');
  assert.deepEqual(schema, { type: 'object' });
});

test('gemini: $refs are inlined', () => {
  const { schema } = fixSchema(
    { type: 'object', properties: { p: { $ref: '#/$defs/P' } }, $defs: { P: { type: 'string', minLength: 1 } } },
    'gemini',
  );
  assert.deepEqual(schema.properties.p, { type: 'string', minLength: 1 });
});

test('all targets: required entries must exist', () => {
  for (const target of ['gemini', 'openai', 'anthropic']) {
    const { schema, changes } = fixSchema(
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'ghost'] },
      target,
    );
    assert.deepEqual(schema.required, ['a'], target);
    assert.ok(rules(changes).includes('required-unknown'), target);
  }
});

test('missing root type is set to object', () => {
  const { schema } = fixSchema({ properties: { a: { type: 'string' } } }, 'anthropic');
  assert.equal(schema.type, 'object');
  assert.deepEqual(fixSchema(undefined, 'openai').schema, { type: 'object' });
});

test('openai-strict: optional props become required + nullable, objects closed', () => {
  const { schema, changes } = fixSchema(
    {
      type: 'object',
      properties: {
        q: { type: 'string' },
        limit: { type: 'integer', default: 10, description: 'Max results' },
        opts: { type: 'object', properties: { deep: { type: 'boolean' } } },
      },
      required: ['q'],
    },
    'openai-strict',
  );
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      q: { type: 'string' },
      limit: { type: ['integer', 'null'], description: 'Max results (default: 10) (optional: send null to omit)' },
      opts: {
        type: ['object', 'null'],
        properties: { deep: { type: ['boolean', 'null'], description: '(optional: send null to omit)' } },
        required: ['deep'],
        additionalProperties: false,
        description: '(optional: send null to omit)',
      },
    },
    required: ['q', 'limit', 'opts'],
    additionalProperties: false,
  });
  assert.ok(rules(changes).includes('strict-required'));
});

test('openai-strict: string length limits become hints, supported formats stay', () => {
  const { schema } = fixSchema(
    {
      type: 'object',
      properties: { email: { type: 'string', format: 'email', minLength: 3 }, site: { type: 'string', format: 'uri' } },
      required: ['email', 'site'],
    },
    'openai-strict',
  );
  assert.deepEqual(schema.properties.email, { type: 'string', format: 'email', description: '(min length 3)' });
  assert.deepEqual(schema.properties.site, { type: 'string', description: '(format: uri)' });
});

test('openai-strict: OpenAPI nullable becomes a type union', () => {
  const { schema } = fixSchema(
    { type: 'object', properties: { a: { type: 'string', nullable: true } }, required: ['a'] },
    'openai-strict',
  );
  assert.deepEqual(schema.properties.a, { type: ['string', 'null'] });
});

test('openai-strict: recursive schemas keep $ref', () => {
  const { schema } = fixSchema(
    {
      type: 'object',
      properties: { tree: { $ref: '#/$defs/Node' } },
      required: ['tree'],
      $defs: { Node: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/Node' } } }, required: ['kids'] } },
    },
    'openai-strict',
  );
  assert.deepEqual(schema.properties.tree.properties.kids.items, { $ref: '#/$defs/Node' });
  assert.equal(schema.$defs.Node.additionalProperties, false);
});

test('openai-strict: free-form objects are flagged as lossy', () => {
  const { changes } = fixSchema(
    { type: 'object', properties: { meta: { type: 'object', additionalProperties: true } }, required: ['meta'] },
    'openai-strict',
  );
  assert.ok(changes.find((c) => c.rule === 'free-form-object').lossy);
});

test('openai-strict: depth warning', () => {
  let s = { type: 'string' };
  for (let i = 0; i < 12; i++) s = { type: 'object', properties: { x: s }, required: ['x'] };
  const { changes } = fixSchema(s, 'openai-strict');
  assert.ok(changes.some((c) => c.rule === 'max-depth' && c.kind === 'warn'));
});

test('anthropic: top-level anyOf is flattened', () => {
  const { schema, changes } = fixSchema(
    {
      anyOf: [
        { type: 'object', properties: { id: { type: 'string' }, a: { type: 'number' } }, required: ['id', 'a'] },
        { type: 'object', properties: { id: { type: 'string' }, b: { type: 'number' } }, required: ['id', 'b'] },
      ],
    },
    'anthropic',
  );
  assert.deepEqual(schema, {
    type: 'object',
    properties: { id: { type: 'string' }, a: { type: 'number' }, b: { type: 'number' } },
    required: ['id'],
  });
  assert.ok(changes.find((c) => c.rule === 'root-anyOf').lossy);
});

test('anthropic/openai: leaves valid JSON Schema alone', () => {
  const input = {
    type: 'object',
    properties: { a: { type: ['string', 'null'], format: 'uri', minLength: 2 }, b: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
    required: ['a'],
    additionalProperties: false,
  };
  for (const target of ['anthropic', 'openai']) {
    const { schema, changes } = fixSchema(input, target);
    assert.deepEqual(schema, input, target);
    assert.deepEqual(changes, [], target);
  }
});

test('input is never mutated', () => {
  const input = { type: 'object', properties: { a: { type: ['string', 'null'], exclusiveMinimum: 1 } } };
  const copy = structuredClone(input);
  fixSchema(input, 'gemini');
  fixSchema(input, 'openai-strict');
  assert.deepEqual(input, copy);
});
