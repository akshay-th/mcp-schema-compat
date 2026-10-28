import { spawn } from 'node:child_process';
import { needsShell, onLines, tryParse } from './lines.js';

export const PROTOCOL_VERSION = '2025-06-18';

/**
 * Start a stdio MCP server, run the initialize handshake and collect every page
 * of tools/list. Returns { tools, serverInfo, noise } where noise lists
 * non-JSON lines the server wrote to stdout (those break most clients).
 */
export function listServerTools(command, args = [], { env, cwd, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell(command),
    });
    const pending = new Map();
    const noise = [];
    let stderr = '';
    let nextId = 1;
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const p of pending.values()) p.reject(err || new Error('server closed'));
      try {
        child.stdin.end();
      } catch {}
      child.kill();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(withStderr(new Error(`timed out after ${timeoutMs}ms waiting for the server`), stderr));
    }, timeoutMs);

    child.on('error', (e) => finish(withStderr(e, stderr)));
    child.on('exit', (code, signal) => {
      if (!done) finish(withStderr(new Error(`server exited early (${signal || `code ${code}`})`), stderr));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });

    onLines(child.stdout, (line) => {
      const msg = tryParse(line);
      if (!msg || typeof msg !== 'object') {
        noise.push(line);
        return;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message || 'error'} (code ${msg.error.code})`));
        else p.resolve(msg.result);
      } else if (msg.method && msg.id != null) {
        // Server-initiated request (ping, roots/list...). Answer politely.
        const result = msg.method === 'roots/list' ? { roots: [] } : {};
        send({ jsonrpc: '2.0', id: msg.id, result });
      }
    });

    function send(obj) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    }

    function request(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        send({ jsonrpc: '2.0', id, method, params });
      });
    }

    (async () => {
      const init = await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mcp-schema-compat', version: '0.1.0' },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const tools = [];
      let cursor;
      for (let page = 0; page < 100; page++) {
        const res = await request('tools/list', cursor ? { cursor } : {});
        tools.push(...(res?.tools || []));
        cursor = res?.nextCursor;
        if (!cursor) break;
      }
      finish(null, { tools, serverInfo: init?.serverInfo, protocolVersion: init?.protocolVersion, noise });
    })().catch((e) => finish(withStderr(e, stderr)));
  });
}

function withStderr(err, stderr) {
  if (stderr.trim()) err.stderr = stderr.trim();
  return err;
}
