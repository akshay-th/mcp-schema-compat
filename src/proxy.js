import { spawn } from 'node:child_process';
import { decodeArguments, fixTools } from './index.js';
import { needsShell, onLines, tryParse } from './lines.js';

/**
 * Message-level rewriting, separated from I/O so it can be tested directly.
 *  - responses to tools/list get their schemas fixed for the target
 *  - tools/call requests are routed back to the original tool name and any
 *    arguments we turned into JSON strings are decoded again
 */
export function createRewriter(target) {
  const listIds = new Set();
  const renames = {}; // exposed name -> original name
  const coerce = {}; // exposed name -> argument paths

  function fromClient(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    if (msg.method === 'tools/list' && msg.id != null) listIds.add(msg.id);
    if (msg.method === 'tools/call' && msg.params && typeof msg.params.name === 'string') {
      const exposed = msg.params.name;
      const params = { ...msg.params, name: renames[exposed] || exposed };
      if (coerce[exposed]) params.arguments = decodeArguments(msg.params.arguments, coerce[exposed]);
      return { ...msg, params };
    }
    return msg;
  }

  function fromServer(msg) {
    if (!msg || typeof msg !== 'object' || msg.id == null || !listIds.has(msg.id)) return msg;
    listIds.delete(msg.id);
    if (!msg.result || !Array.isArray(msg.result.tools)) return msg;
    const fixed = fixTools(msg.result.tools, target);
    Object.assign(renames, fixed.renames);
    for (const [name, paths] of Object.entries(fixed.coerce)) coerce[name] = paths;
    return { ...msg, result: { ...msg.result, tools: fixed.tools } };
  }

  const map = (fn) => (msg) => (Array.isArray(msg) ? msg.map(fn) : fn(msg));
  return { fromClient: map(fromClient), fromServer: map(fromServer), renames, coerce };
}

export function runProxy({ target, command, args = [], stdin = process.stdin, stdout = process.stdout, stderr = process.stderr }) {
  return new Promise((resolve) => {
    const rw = createRewriter(target);
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: needsShell(command),
    });

    child.on('error', (e) => {
      stderr.write(`mcp-schema-compat proxy: failed to start "${command}": ${e.message}\n`);
      resolve(127);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));

    onLines(stdin, (line) => {
      const msg = tryParse(line);
      child.stdin.write(`${msg === undefined ? line : JSON.stringify(rw.fromClient(msg))}\n`);
    });
    stdin.on('end', () => child.stdin.end());

    onLines(child.stdout, (line) => {
      const msg = tryParse(line);
      if (msg === undefined) {
        // A server printing logs to stdout breaks the JSON-RPC stream. Move it aside.
        stderr.write(`[server stdout] ${line}\n`);
        return;
      }
      stdout.write(`${JSON.stringify(rw.fromServer(msg))}\n`);
    });

    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => child.kill(sig));
    }
  });
}
