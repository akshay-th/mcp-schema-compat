// Provider constraints. Each entry documents where the rule comes from so it can be
// re-checked when providers change their APIs.

export const TARGETS = {
  gemini: {
    label: 'Google Gemini (function declarations, OpenAPI 3.0 schema subset)',
    // Fields accepted by the Gemini `Schema` object. Anything else triggers
    // `Invalid JSON payload received. Unknown name "..."`.
    allowedKeys: new Set([
      'type', 'format', 'title', 'description', 'nullable', 'enum', 'maxItems', 'minItems',
      'properties', 'required', 'minProperties', 'maxProperties', 'minLength', 'maxLength',
      'pattern', 'example', 'anyOf', 'propertyOrdering', 'default', 'items', 'minimum', 'maximum',
    ]),
    formats: {
      string: new Set(['enum', 'date-time']),
      number: new Set(['float', 'double']),
      integer: new Set(['int32', 'int64']),
    },
    refs: 'inline-all',
    typeArrays: false,
    nullType: false,
    stringEnumsOnly: true,
    emptyPropertiesInvalid: true,
    toolName: /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/,
    toolNameHint: 'start with a letter or underscore; letters, digits, _ . : - only; max 64 chars',
  },

  'openai-strict': {
    label: 'OpenAI function calling with strict: true (Structured Outputs)',
    allowedKeys: new Set([
      'type', 'description', 'title', 'properties', 'required', 'additionalProperties', 'items',
      'enum', 'const', 'anyOf', '$ref', '$defs', 'pattern', 'format', 'minimum', 'maximum',
      'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems',
    ]),
    formats: {
      string: new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']),
    },
    refs: 'keep-recursive',
    typeArrays: true,
    nullType: true,
    strictObjects: true,
    rootCombinatorsInvalid: true,
    maxDepth: 10,
    maxProperties: 5000,
    maxTools: 128,
    toolName: /^[a-zA-Z0-9_-]{1,64}$/,
    toolNameHint: 'letters, digits, _ and - only; max 64 chars',
  },

  openai: {
    label: 'OpenAI function calling (non-strict)',
    allowedKeys: null, // accepts arbitrary JSON Schema
    refs: 'keep',
    typeArrays: true,
    nullType: true,
    maxTools: 128,
    toolName: /^[a-zA-Z0-9_-]{1,64}$/,
    toolNameHint: 'letters, digits, _ and - only; max 64 chars',
  },

  anthropic: {
    label: 'Anthropic Messages API tools (input_schema)',
    allowedKeys: null,
    refs: 'keep',
    typeArrays: true,
    nullType: true,
    // "input_schema does not support oneOf, allOf, or anyOf at the top level"
    rootCombinatorsInvalid: true,
    toolName: /^[a-zA-Z0-9_-]{1,64}$/,
    toolNameHint: 'letters, digits, _ and - only; max 64 chars',
  },
};

export const TARGET_NAMES = Object.keys(TARGETS);

export function getTarget(name) {
  const t = TARGETS[name];
  if (!t) throw new Error(`unknown target "${name}" (expected one of: ${TARGET_NAMES.join(', ')})`);
  return t;
}
