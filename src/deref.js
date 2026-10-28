// Inline local $ref pointers ("#/$defs/Foo", "#/definitions/Foo", "#/properties/x").
// Remote refs are left alone and reported by the caller.

function decodePointer(ref) {
  if (!ref.startsWith('#')) return null;
  const body = ref.slice(1);
  if (body === '') return [];
  if (!body.startsWith('/')) return null;
  return body
    .slice(1)
    .split('/')
    .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function resolvePointer(root, ref) {
  const parts = decodePointer(ref);
  if (!parts) return undefined;
  let cur = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function defName(ref) {
  const parts = decodePointer(ref) || [];
  return parts[parts.length - 1] || 'root';
}

/**
 * Returns { schema, changes, recursive } where schema has every non-recursive
 * local $ref replaced by a copy of its target.
 *
 * keepRecursive: when true, cyclic refs are kept as "#/$defs/<name>" and the
 * targets are collected into a fresh $defs block (OpenAI strict supports that).
 * When false, the cycle is cut and replaced by a loose object (Gemini has no refs).
 */
export function deref(schema, { keepRecursive = false } = {}) {
  const changes = [];
  const keptDefs = {};
  let recursive = false;

  function walk(node, path, stack) {
    if (Array.isArray(node)) return node.map((n, i) => walk(n, `${path}/${i}`, stack));
    if (node == null || typeof node !== 'object') return node;

    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      const target = resolvePointer(schema, ref);
      if (target === undefined) {
        changes.push({
          path,
          rule: 'unresolved-ref',
          message: `$ref "${ref}" cannot be resolved locally; replaced with an untyped schema`,
          lossy: true,
        });
        const { $ref, ...rest } = node;
        return walk(rest, path, stack);
      }
      if (stack.includes(ref)) {
        recursive = true;
        const name = defName(ref);
        if (keepRecursive) {
          if (!(name in keptDefs)) {
            keptDefs[name] = null; // placeholder so we don't loop
            keptDefs[name] = walk(target, `/$defs/${name}`, [ref]);
          }
          return { ...siblings(node), $ref: `#/$defs/${name}` };
        }
        changes.push({
          path,
          rule: 'recursive-ref',
          message: `recursive $ref "${ref}" cut off; nested value accepted as a free-form object`,
          lossy: true,
        });
        const description = node.description || target.description;
        return {
          type: 'object',
          ...(description ? { description } : {}),
        };
      }
      changes.push({ path, rule: 'inline-ref', message: `inlined $ref "${ref}"`, lossy: false });
      const resolved = walk(target, path, [...stack, ref]);
      // Sibling keywords next to $ref (allowed since 2019-09) override the target.
      return { ...resolved, ...walkObject(siblings(node), path, stack) };
    }
    return walkObject(node, path, stack);
  }

  function siblings(node) {
    const { $ref, ...rest } = node;
    return rest;
  }

  function walkObject(node, path, stack) {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if ((k === '$defs' || k === 'definitions') && path === '') continue;
      out[k] = walk(v, `${path}/${k}`, stack);
    }
    return out;
  }

  const out = walk(schema, '', []);
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    if (keepRecursive && Object.keys(keptDefs).length) out.$defs = keptDefs;
    if ((schema.$defs || schema.definitions) && !recursive) {
      changes.push({ path: '/$defs', rule: 'drop-defs', message: 'removed $defs after inlining', lossy: false });
    }
  }
  return { schema: out, changes, recursive };
}
