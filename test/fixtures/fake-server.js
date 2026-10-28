#!/usr/bin/env node
// Minimal stdio MCP server used by the tests. It deliberately ships schemas that
// Gemini rejects, paginates tools/list, and writes one log line to stdout.
import { onLines, tryParse } from '../../src/lines.js';

const PAGES = [
  [
    {
      name: 'search.files',
      description: 'Search files',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          limit: { type: 'integer', exclusiveMinimum: 0 },
          filters: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
  [
    {
      name: 'ping',
      description: 'No arguments',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
];

if (process.env.FAKE_NOISE !== '0') process.stdout.write('debug: fake server starting\n');

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

onLines(process.stdin, (line) => {
  const msg = tryParse(line);
  if (!msg || msg.id == null) return;
  switch (msg.method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } },
      });
    case 'tools/list': {
      const page = msg.params?.cursor ? Number(msg.params.cursor) : 0;
      const result = { tools: PAGES[page] };
      if (page + 1 < PAGES.length) result.nextCursor = String(page + 1);
      return send({ jsonrpc: '2.0', id: msg.id, result });
    }
    case 'tools/call':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ name: msg.params.name, arguments: msg.params.arguments }) }] },
      });
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
