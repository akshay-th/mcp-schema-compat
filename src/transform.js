import { deref } from './deref.js';
import { getTarget } from './targets.js';

// Human-readable hints for constraints a target can't express natively. They are
// appended to the description so the model still sees them.
const HINTS = {
  minLength: (v) => `min length ${v}`,
  maxLength: (v) => `max length ${v}`,
  pattern: (v) => `pattern ${v}`,
  minimum: (v) => `>= ${v}`,
  maximum: (v) => `<= ${v}`,
  multipleOf: (v) => `multiple of ${v}`,
  minItems: (v) => `at least ${v} items`,
  maxItems: (v) => `at most ${v} items`,
  uniqueItems: (v) => (v ? 'items must be unique' : null),
  minProperties: (v) => `at least ${v} keys`,
  maxProperties: (v) => `at most ${v} keys`,
  default: (v) => `default: ${JSON.stringify(v)}`,
  format: (v) => `format: ${v}`,
};

const COMBINATORS = ['anyOf', 'oneOf', 'allOf'];

// Annotation-only keywords: dropping them doesn't change which values are valid.
const HARMLESS = new Set(['$schema', '$id', '$comment', 'title', 'readOnly', 'writeOnly', 'deprecated', 'examples', 'example', 'contentMediaType', 'contentEncoding']);

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function appendHints(schema, hints) {
  const uniq = [...new Set(hints.filter(Boolean))];
  if (!uniq.length) return;
  const suffix = `(${uniq.join('; ')})`;
  schema.description = schema.description ? `${schema.description} ${suffix}` : suffix;
}

function isObjectSchema(s) {
  return s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object')) || isPlainObject(s.properties);
}

export function mergeSchemas(base, parts) {
  const out = { ...base };
  for (const part of parts) {
    if (!isPlainObject(part)) continue;
    for (const [k, v] of Object.entries(part)) {
      if (k === 'properties') out.properties = { ...(out.properties || {}), ...v };
      else if (k === 'required') out.required = [...new Set([...(out.required || []), ...v])];
      else if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

// anyOf/oneOf at the root: collapse every variant into one object whose required
// list is what all variants agree on.
function flattenVariants(base, variants) {
  const props = {};
  let required = null;
  for (const v of variants) {
    if (!isPlainObject(v)) continue;
    Object.assign(props, v.properties || {});
    const r = new Set(v.required || []);
    required = required ? new Set([...required].filter((x) => r.has(x))) : r;
  }
  const out = { ...base, type: 'object', properties: { ...props, ...(base.properties || {}) } };
  const req = [...new Set([...(base.required || []), ...(required || [])])];
  if (req.length) out.required = req;
  else delete out.required;
  return out;
}

function makeNullable(schema) {
  if (!isPlainObject(schema)) return schema;
  if (schema.$ref) return { anyOf: [schema, { type: 'null' }] };
  const s = { ...schema };
  if (Array.isArray(s.anyOf)) {
    if (!s.anyOf.some((m) => m && m.type === 'null')) s.anyOf = [...s.anyOf, { type: 'null' }];
  } else if (typeof s.type === 'string') {
    if (s.type !== 'null') s.type = [s.type, 'null'];
  } else if (Array.isArray(s.type)) {
    if (!s.type.includes('null')) s.type = [...s.type, 'null'];
  } else {
    return s; // untyped: already accepts null
  }
  if (Array.isArray(s.enum) && !s.enum.includes(null)) s.enum = [...s.enum, null];
  return s;
}

/**
 * Rewrite a JSON Schema for a target provider.
 * Returns { schema, changes } where every change is
 *   { path, rule, message, lossy, kind: 'fix' | 'warn', coerce? }
 * kind 'warn' marks problems that were detected but not rewritten.
 */
export function fixSchema(input, targetName) {
  const target = getTarget(targetName);
  const changes = [];
  const add = (path, rule, message, extra = {}) =>
    changes.push({ path: path || '', rule, message, lossy: false, kind: 'fix', ...extra });

  let root = isPlainObject(input) ? structuredClone(input) : {};
  if (!isPlainObject(input)) add('', 'root-not-object', 'schema was missing or not an object; replaced with an empty object schema');

  if (target.refs === 'inline-all' || target.refs === 'keep-recursive') {
    const r = deref(root, { keepRecursive: target.refs === 'keep-recursive' });
    root = r.schema;
    for (const c of r.changes) changes.push({ kind: 'fix', ...c });
  }

  if (target.rootCombinatorsInvalid) {
    if (Array.isArray(root.allOf)) {
      const { allOf, ...rest } = root;
      root = mergeSchemas(rest, allOf);
      add('', 'root-allOf', 'merged top-level allOf into a single object');
    }
    for (const key of ['anyOf', 'oneOf']) {
      if (Array.isArray(root[key])) {
        const { [key]: variants, ...rest } = root;
        root = flattenVariants(rest, variants);
        add('', `root-${key}`, `top-level ${key} is not supported; merged ${variants.length} variants into one object (only shared fields stay required)`, { lossy: true });
      }
    }
  }

  function walk(node, path, depth, isRoot) {
    if (node === true || (isPlainObject(node) && Object.keys(node).length === 0)) {
      if (target.allowedKeys && !isRoot) {
        changes.push({ path, rule: 'untyped', message: 'schema accepts any value; this target needs an explicit type', lossy: false, kind: 'warn' });
      }
      return isRoot ? { type: 'object' } : {};
    }
    if (!isPlainObject(node)) return node;

    let s = { ...node };
    const hints = [];
    const allowed = target.allowedKeys;
    const notAllowed = (k) => allowed && !allowed.has(k);

    if (Array.isArray(s.allOf) && notAllowed('allOf')) {
      const { allOf, ...rest } = s;
      s = mergeSchemas(rest, allOf);
      add(path, 'allOf', 'merged allOf branches into one schema');
    }
    if (Array.isArray(s.oneOf) && notAllowed('oneOf')) {
      s.anyOf = [...(s.anyOf || []), ...s.oneOf];
      delete s.oneOf;
      add(path, 'oneOf', 'oneOf rewritten as anyOf (exclusivity is not enforced)');
    }
    if ('const' in s && notAllowed('const')) {
      s.enum = [s.const];
      delete s.const;
      add(path, 'const', 'const rewritten as a single-value enum');
    }

    // ["string", "null"] style unions
    if (Array.isArray(s.type) && !target.typeArrays) {
      const types = s.type;
      const nonNull = types.filter((t) => t !== 'null');
      if (types.includes('null')) s.nullable = true;
      if (nonNull.length === 1) s.type = nonNull[0];
      else {
        delete s.type;
        s.anyOf = nonNull.map((t) => ({ type: t }));
      }
      add(path, 'type-array', `type array ${JSON.stringify(types)} rewritten${types.includes('null') ? ' with nullable: true' : ''}`);
    }

    if (Array.isArray(s.anyOf) && !target.nullType) {
      const isNull = (m) => isPlainObject(m) && m.type === 'null';
      if (s.anyOf.some(isNull)) {
        s.anyOf = s.anyOf.filter((m) => !isNull(m));
        s.nullable = true;
        add(path, 'null-type', 'null branch of anyOf replaced with nullable: true');
      }
      if (s.anyOf.length === 1) {
        const [only] = s.anyOf;
        delete s.anyOf;
        s = { ...only, ...s };
      }
    }
    if ('nullable' in s && notAllowed('nullable')) {
      const wasNullable = s.nullable === true;
      delete s.nullable;
      if (wasNullable) s = makeNullable(s);
      add(path, 'nullable', wasNullable ? 'OpenAPI nullable rewritten as a null type union' : 'nullable: false removed');
    }
    if (allowed && !isRoot && !hasShape(s)) {
      changes.push({ path, rule: 'untyped', message: 'schema has no type; this target may reject it or guess', lossy: false, kind: 'warn' });
    }
    if (s.type === 'null' && !target.nullType) {
      s.type = 'string';
      s.nullable = true;
      add(path, 'null-type', 'type "null" rewritten as a nullable string', { lossy: true });
    }

    for (const [key, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
      if (!(key in s) || !notAllowed(key)) continue;
      const v = s[key];
      if (typeof v === 'number') {
        hints.push(`${key === 'exclusiveMinimum' ? '>' : '<'} ${v}`);
        if (!(bound in s)) s[bound] = v;
      } else if (v === true && bound in s) {
        hints.push(`${key === 'exclusiveMinimum' ? '>' : '<'} ${s[bound]}`);
      }
      delete s[key];
      add(path, key, `${key} is not supported; kept as ${bound} with a description hint`, { lossy: true });
    }

    if (Array.isArray(s.examples) && notAllowed('examples')) {
      if (allowed.has('example') && s.examples.length) s.example = s.examples[0];
      delete s.examples;
      add(path, 'examples', allowed.has('example') ? 'examples rewritten as example' : 'examples removed');
    }

    if (typeof s.format === 'string' && target.formats) {
      const baseType = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
      const ok = target.formats[baseType];
      if (!ok || !ok.has(s.format)) {
        hints.push(HINTS.format(s.format));
        add(path, 'format', `format "${s.format}" is not supported for ${baseType || 'untyped'} values; moved to description`);
        delete s.format;
      }
    }

    if (target.stringEnumsOnly && Array.isArray(s.enum)) {
      if (s.enum.includes(null)) {
        s.enum = s.enum.filter((v) => v !== null);
        s.nullable = true;
        add(path, 'enum-null', 'null removed from enum; nullable: true set instead');
      }
      if (s.enum.some((v) => typeof v !== 'string')) {
        hints.push(`one of: ${s.enum.map((v) => JSON.stringify(v)).join(', ')}`);
        delete s.enum;
        add(path, 'enum-type', 'only string enums are supported; allowed values moved to description', { lossy: true });
      }
    }

    // Tuple-style items
    if (Array.isArray(s.items) && allowed) {
      const tuple = s.items;
      s.items = tuple.length === 1 ? tuple[0] : { anyOf: tuple };
      add(path, 'tuple-items', 'tuple items rewritten as a single item schema', { lossy: true });
    }
    if (Array.isArray(s.prefixItems) && notAllowed('prefixItems')) {
      if (!s.items) s.items = s.prefixItems.length === 1 ? s.prefixItems[0] : { anyOf: s.prefixItems };
      delete s.prefixItems;
      add(path, 'tuple-items', 'prefixItems rewritten as a single item schema', { lossy: true });
    }

    // Recurse
    if (isPlainObject(s.properties)) {
      const props = {};
      for (const [k, v] of Object.entries(s.properties)) {
        props[k] = walk(v, `${path}/properties/${escapeKey(k)}`, depth + 1, false);
      }
      s.properties = props;
    }
    if (isPlainObject(s.items)) s.items = walk(s.items, `${path}/items`, depth + 1, false);
    if (Array.isArray(s.anyOf)) s.anyOf = s.anyOf.map((m, i) => walk(m, `${path}/anyOf/${i}`, depth, false));
    for (const key of ['oneOf', 'allOf']) {
      if (Array.isArray(s[key])) s[key] = s[key].map((m, i) => walk(m, `${path}/${key}/${i}`, depth, false));
    }
    if (isPlainObject(s.additionalProperties) && !notAllowed('additionalProperties')) {
      s.additionalProperties = walk(s.additionalProperties, `${path}/additionalProperties`, depth + 1, false);
    }
    if (isRoot && isPlainObject(s.$defs)) {
      const defs = {};
      for (const [k, v] of Object.entries(s.$defs)) defs[k] = walk(v, `/$defs/${escapeKey(k)}`, 1, false);
      s.$defs = defs;
    }

    // required must reference real properties
    if (Array.isArray(s.required)) {
      if (isPlainObject(s.properties)) {
        const missing = s.required.filter((r) => !(r in s.properties));
        if (missing.length) {
          s.required = s.required.filter((r) => r in s.properties);
          add(path, 'required-unknown', `required lists undefined properties: ${missing.join(', ')}`);
        }
      } else if (allowed && s.required.length) {
        add(path, 'required-unknown', 'required set without properties; removed');
        delete s.required;
      }
      if (Array.isArray(s.required) && s.required.length === 0 && !target.strictObjects) delete s.required;
    }

    if (target.emptyPropertiesInvalid && isObjectSchema(s)) {
      const empty = !isPlainObject(s.properties) || Object.keys(s.properties).length === 0;
      if (empty && isRoot) {
        if ('properties' in s) {
          delete s.properties;
          add(path, 'empty-properties', 'empty properties removed (rejected for OBJECT types)');
        }
      } else if (empty) {
        const desc = 'JSON-encoded object';
        delete s.properties;
        delete s.additionalProperties;
        s.type = 'string';
        s.description = s.description ? `${s.description} (${desc})` : desc;
        add(path, 'free-form-object', 'object without properties is rejected; accepted as a JSON-encoded string instead', {
          lossy: true,
          coerce: 'json-string',
        });
      }
    }

    if (target.strictObjects && isObjectSchema(s)) {
      const props = isPlainObject(s.properties) ? s.properties : {};
      const hadExtra = s.additionalProperties !== undefined && s.additionalProperties !== false;
      if (Object.keys(props).length === 0 && !isRoot) {
        add(path, 'free-form-object', 'strict mode cannot express objects with arbitrary keys; locked to an empty object', { lossy: true });
      } else if (hadExtra) {
        add(path, 'additional-properties', 'additionalProperties forced to false (required by strict mode)', { lossy: true });
      }
      if (s.additionalProperties !== false) s.additionalProperties = false;
      s.properties = props;
      const required = new Set(s.required || []);
      const optional = Object.keys(props).filter((k) => !required.has(k));
      for (const k of optional) {
        props[k] = makeNullable(props[k]);
        appendHints(props[k], ['optional: send null to omit']);
      }
      if (optional.length) {
        add(path, 'strict-required', `optional properties made required + nullable: ${optional.join(', ')}`);
      }
      s.required = Object.keys(props);
    }

    if (allowed) {
      const removed = [];
      const harmless = (k) => k in HINTS || HARMLESS.has(k) || (k === 'additionalProperties' && node.additionalProperties === false);
      for (const k of Object.keys(s)) {
        if (allowed.has(k)) continue;
        const hint = HINTS[k];
        if (hint) hints.push(hint(s[k]));
        removed.push(k);
        delete s[k];
      }
      if (removed.length) {
        add(path, 'unsupported-keyword', `removed unsupported keywords: ${removed.join(', ')}`, {
          lossy: removed.some((k) => !harmless(k)),
        });
      }
    }

    appendHints(s, hints);
    return s;
  }

  let out = walk(root, '', 0, true);

  if (out.type !== 'object') {
    if (out.type === undefined) {
      out = { type: 'object', ...out };
      add('', 'root-type', 'root schema had no type; set to "object"');
    } else {
      changes.push({ path: '', rule: 'root-type', message: `root schema must be an object, got ${JSON.stringify(out.type)}`, lossy: false, kind: 'warn' });
    }
  }

  if (target.maxDepth) {
    const depth = objectDepth(out);
    if (depth > target.maxDepth) {
      changes.push({ path: '', rule: 'max-depth', message: `object nesting depth ${depth} exceeds ${target.maxDepth}`, lossy: false, kind: 'warn' });
    }
  }
  if (target.maxProperties) {
    const n = countProperties(out);
    if (n > target.maxProperties) {
      changes.push({ path: '', rule: 'max-properties', message: `${n} properties in total exceeds ${target.maxProperties}`, lossy: false, kind: 'warn' });
    }
  }

  return { schema: out, changes };
}

function hasShape(s) {
  return ['type', 'properties', 'items', 'anyOf', 'oneOf', 'allOf', 'enum', 'const', '$ref'].some((k) => k in s);
}

function escapeKey(k) {
  return String(k).replace(/~/g, '~0').replace(/\//g, '~1');
}

function objectDepth(s, seen = 0) {
  if (!isPlainObject(s)) return seen;
  let max = isObjectSchema(s) ? seen + 1 : seen;
  const next = isObjectSchema(s) ? seen + 1 : seen;
  for (const v of Object.values(s.properties || {})) max = Math.max(max, objectDepth(v, next));
  if (isPlainObject(s.items)) max = Math.max(max, objectDepth(s.items, next));
  for (const k of COMBINATORS) for (const m of s[k] || []) max = Math.max(max, objectDepth(m, seen));
  return max;
}

function countProperties(s) {
  if (!isPlainObject(s)) return 0;
  let n = 0;
  for (const v of Object.values(s.properties || {})) n += 1 + countProperties(v);
  if (isPlainObject(s.items)) n += countProperties(s.items);
  for (const k of COMBINATORS) for (const m of s[k] || []) n += countProperties(m);
  for (const v of Object.values(s.$defs || {})) n += countProperties(v);
  return n;
}
