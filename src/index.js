import { fixSchema } from './transform.js';
import { getTarget, TARGETS, TARGET_NAMES } from './targets.js';

export { fixSchema, TARGETS, TARGET_NAMES };
export { deref } from './deref.js';

/** Lint a single schema: same analysis as fixSchema, without the rewritten copy. */
export function lintSchema(schema, target) {
  return fixSchema(schema, target).changes;
}

const SCHEMA_KEYS = ['inputSchema', 'parameters', 'input_schema'];

function schemaKey(tool) {
  return SCHEMA_KEYS.find((k) => k in tool) || 'inputSchema';
}

export function sanitizeToolName(name, target) {
  const t = getTarget(target);
  if (t.toolName.test(name)) return name;
  let out = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
  if (target === 'gemini' && !/^[a-zA-Z_]/.test(out)) out = `_${out}`;
  out = out.slice(0, 64) || '_';
  return out;
}

/**
 * Fix one tool definition. Accepts MCP ({ name, description, inputSchema }),
 * OpenAI ({ name, parameters }) or Anthropic ({ name, input_schema }) shapes and
 * returns the same shape.
 */
export function fixTool(tool, target) {
  const key = schemaKey(tool);
  const { schema, changes } = fixSchema(tool[key], target);
  const t = getTarget(target);
  const out = { ...tool, [key]: schema };
  const name = sanitizeToolName(tool.name ?? '', target);
  if (name !== tool.name) {
    changes.unshift({
      path: '',
      rule: 'tool-name',
      message: `tool name "${tool.name}" is invalid (${t.toolNameHint}); renamed to "${name}"`,
      lossy: false,
      kind: 'fix',
    });
    out.name = name;
  }
  return { tool: out, changes, coerce: coercePaths(changes) };
}

/**
 * Fix a whole tool list. Renamed tools keep unique names; `renames` maps
 * new name -> original name so callers (like the proxy) can route calls back.
 */
export function fixTools(tools, target) {
  const t = getTarget(target);
  const results = [];
  const renames = {};
  const coerce = {};
  const taken = new Set();
  for (const tool of tools) {
    const r = fixTool(tool, target);
    let name = r.tool.name;
    if (taken.has(name)) {
      let i = 2;
      while (taken.has(`${name.slice(0, 60)}_${i}`)) i++;
      name = `${name.slice(0, 60)}_${i}`;
      r.changes.unshift({ path: '', rule: 'tool-name', message: `name collides after renaming; using "${name}"`, lossy: false, kind: 'fix' });
      r.tool.name = name;
    }
    taken.add(name);
    if (name !== tool.name) renames[name] = tool.name;
    if (r.coerce.length) coerce[name] = r.coerce;
    results.push({ name: tool.name, fixedName: name, tool: r.tool, changes: r.changes });
  }
  const warnings = [];
  if (t.maxTools && tools.length > t.maxTools) {
    warnings.push({ rule: 'max-tools', message: `${tools.length} tools exceeds the ${t.maxTools}-tool limit for ${target}`, kind: 'warn' });
  }
  return { tools: results.map((r) => r.tool), results, renames, coerce, warnings };
}

export function lintTools(tools, target) {
  const { results, warnings } = fixTools(tools, target);
  return {
    target,
    toolCount: tools.length,
    warnings,
    tools: results
      .filter((r) => r.changes.length)
      .map((r) => ({ name: r.name, issues: r.changes })),
  };
}

/**
 * Turn change paths flagged for JSON-string coercion into argument paths:
 * "/properties/a/items/properties/b" -> ["a", "*", "b"].
 * Paths that go through anyOf etc. are skipped; we can't tell which branch the
 * model picked.
 */
export function coercePaths(changes) {
  const out = [];
  for (const c of changes) {
    if (c.coerce !== 'json-string') continue;
    const parts = c.path.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    const segs = [];
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'properties' && i + 1 < parts.length) segs.push(parts[++i]);
      else if (parts[i] === 'items') segs.push('*');
      else {
        ok = false;
        break;
      }
    }
    if (ok && segs.length) out.push(segs);
  }
  return out;
}

/** Reverse of the free-form-object rewrite: JSON.parse string values at the given paths. */
export function decodeArguments(args, paths) {
  if (!paths || !paths.length || args == null || typeof args !== 'object') return args;
  const copy = structuredClone(args);
  for (const segs of paths) decodeAt(copy, segs, 0);
  return copy;
}

function decodeAt(node, segs, i) {
  if (node == null || typeof node !== 'object') return;
  const seg = segs[i];
  const last = i === segs.length - 1;
  const keys = seg === '*' ? (Array.isArray(node) ? node.keys() : []) : [seg];
  for (const k of keys) {
    if (!(k in node)) continue;
    if (last) {
      if (typeof node[k] === 'string') {
        try {
          const parsed = JSON.parse(node[k]);
          if (parsed && typeof parsed === 'object') node[k] = parsed;
        } catch {
          // leave the string as-is; the server will report the error
        }
      }
    } else {
      decodeAt(node[k], segs, i + 1);
    }
  }
}
