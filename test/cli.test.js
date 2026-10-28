import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listServerTools } from '../src/mcp-client.js';
import { createRewriter } from '../src/proxy.js';
import { onLines } from '../src/lines.js';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-server.js', import.meta.url));

const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

test('listServerTools handshakes, paginates and records stdout noise', async () => {
  const res = await listServerTools(process.execPath, [FAKE]);
  assert.deepEqual(res.tools.map((t) => t.name), ['search.files', 'ping']);
  assert.equal(res.serverInfo.name, 'fake');
  assert.deepEqual(res.noise, ['debug: fake server starting']);
});

test('listServerTools reports a server that never answers', async () => {
  await assert.rejects(
    listServerTools(process.execPath, ['-e', 'setInterval(()=>{}, 1000); console.error("boom")'], { timeoutMs: 500 }),
    (e) => /timed out/.test(e.message) && e.stderr === 'boom',
  );
});

test('cli lint exits 1 and names the problems', () => {
  const r = run(['lint', '--target', 'gemini', '--', process.execPath, FAKE]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /non-JSON line/);
  assert.match(r.stdout, /search\.files/);
  assert.match(r.stdout, /exclusiveMinimum/);
});

test('cli lint --json on a file covers every target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msc-'));
  const f = join(dir, 'tools.json');
  writeFileSync(f, JSON.stringify({ tools: [{ name: 'ok', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }] }));
  const r = run(['lint', '--json', f]);
  assert.equal(r.status, 1, r.stdout); // optional "a" is not valid in openai-strict
  const out = JSON.parse(r.stdout);
  const byTarget = Object.fromEntries(out.reports.map((x) => [x.target, x.tools.length]));
  assert.deepEqual(byTarget, { gemini: 0, 'openai-strict': 1, openai: 0, anthropic: 0 });
});

test('cli fix reads stdin and keeps the input shape', () => {
  const r = run(['fix', '--target', 'gemini', '-'], JSON.stringify({ type: 'object', properties: { a: { type: ['string', 'null'] } } }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { type: 'object', properties: { a: { type: 'string', nullable: true } } });
});

test('cli rejects unknown targets', () => {
  const r = run(['fix', '--target', 'nope', '-'], '{}');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown target/);
});

test('rewriter maps names and arguments both ways', () => {
  const rw = createRewriter('openai');
  rw.fromClient({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  const listed = rw.fromServer({ jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'a.b', inputSchema: { type: 'object' } }] } });
  assert.equal(listed.result.tools[0].name, 'a_b');
  const call = rw.fromClient({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'a_b', arguments: {} } });
  assert.equal(call.params.name, 'a.b');
  // unrelated responses pass through untouched
  const other = { jsonrpc: '2.0', id: 9, result: { tools: [{ name: 'x.y' }] } };
  assert.equal(rw.fromServer(other), other);
});

test('proxy end-to-end: rewrites schemas, decodes JSON-string args, moves stdout noise to stderr', async () => {
  const child = spawn(process.execPath, [CLI, 'proxy', '--target', 'gemini', '--', process.execPath, FAKE], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  const waiters = new Map();
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  onLines(child.stdout, (line) => {
    const msg = JSON.parse(line); // proxy must only emit JSON
    responses.set(msg.id, msg);
    waiters.get(msg.id)?.(msg);
  });
  const request = (id, method, params) =>
    new Promise((resolve) => {
      waiters.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const list = await request(2, 'tools/list', {});
  const search = list.result.tools[0];
  assert.equal(search.name, 'search.files'); // dots are valid for gemini
  assert.equal(search.inputSchema.$schema, undefined);
  assert.equal(search.inputSchema.additionalProperties, undefined);
  assert.equal(search.inputSchema.properties.filters.type, 'string');

  const call = await request(3, 'tools/call', { name: 'search.files', arguments: { query: 'x', filters: '{"lang":"js"}' } });
  const echoed = JSON.parse(call.result.content[0].text);
  assert.deepEqual(echoed.arguments.filters, { lang: 'js' });

  child.stdin.end();
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
  assert.match(stderr, /\[server stdout\] debug: fake server starting/);
});
