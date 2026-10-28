#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fixSchema, fixTools, lintTools, TARGETS, TARGET_NAMES } from '../src/index.js';
import { listServerTools } from '../src/mcp-client.js';
import { runProxy } from '../src/proxy.js';

const HELP = `mcp-schema-compat — make MCP tool schemas work with every model provider

Usage
  mcp-schema-compat lint  [--target T] [--json] <file | ->
  mcp-schema-compat lint  [--target T] [--json] -- <server command...>
  mcp-schema-compat fix    --target T  <file | ->         (prints fixed JSON)
  mcp-schema-compat fix    --target T  -- <server command...>
  mcp-schema-compat proxy  --target T  -- <server command...>
  mcp-schema-compat targets

Targets
${TARGET_NAMES.map((n) => `  ${n.padEnd(14)} ${TARGETS[n].label}`).join('\n')}
  all            lint only: check every target

Input files may hold a tools/list result ({"tools": [...]}), a JSON-RPC response,
a bare array of tools, or a single JSON Schema.

Options
  -t, --target   provider to check or fix for (default: all for lint)
      --json     machine-readable output (lint)
      --timeout  ms to wait for a live server (default 30000)
  -h, --help     show this help
`;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

async function main(argv) {
  const dd = argv.indexOf('--');
  const own = dd === -1 ? argv : argv.slice(0, dd);
  const serverCmd = dd === -1 ? null : argv.slice(dd + 1);

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      target: { type: 'string', short: 't' },
      json: { type: 'boolean' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, file] = positionals;
  if (values.help || !cmd || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'targets') {
    for (const n of TARGET_NAMES) console.log(`${n.padEnd(14)} ${TARGETS[n].label}`);
    return 0;
  }

  const target = values.target || (cmd === 'lint' ? 'all' : undefined);
  if (!target) throw usage(`--target is required for ${cmd}`);
  if (target !== 'all' && !TARGETS[target]) throw usage(`unknown target "${target}"`);
  if (target === 'all' && cmd !== 'lint') throw usage('--target all only works with lint');
  const timeoutMs = values.timeout ? Number(values.timeout) : 30000;

  if (cmd === 'proxy') {
    if (!serverCmd || !serverCmd.length) throw usage('proxy needs a server command after --');
    const code = await runProxy({ target, command: serverCmd[0], args: serverCmd.slice(1) });
    // stdin may still be open; flush and leave once the server is gone.
    process.stdout.write('', () => process.exit(code));
    return code;
  }

  if (cmd !== 'lint' && cmd !== 'fix') throw usage(`unknown command "${cmd}"`);

  const input = await loadInput(file, serverCmd, timeoutMs);
  if (cmd === 'fix') {
    if (input.kind === 'schema') {
      const { schema, changes } = fixSchema(input.schema, target);
      printChangesToStderr(changes);
      process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    } else {
      const { tools, renames, warnings } = fixTools(input.tools, target);
      for (const w of warnings) process.stderr.write(`${yellow('warning')} ${w.message}\n`);
      if (Object.keys(renames).length) process.stderr.write(`${dim(`renamed: ${JSON.stringify(renames)}`)}\n`);
      process.stdout.write(`${JSON.stringify(input.wrap(tools), null, 2)}\n`);
    }
    return 0;
  }

  const targets = target === 'all' ? TARGET_NAMES : [target];
  const reports = targets.map((t) => {
    if (input.kind === 'schema') {
      const issues = fixSchema(input.schema, t).changes;
      return { target: t, toolCount: 1, warnings: [], tools: issues.length ? [{ name: '(schema)', issues }] : [] };
    }
    return lintTools(input.tools, t);
  });
  const failing = reports.some((r) => r.tools.length || r.warnings.length);

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ source: input.source, noise: input.noise, reports }, null, 2)}\n`);
  } else {
    printReports(reports, input);
  }
  return failing ? 1 : 0;
}

function usage(msg) {
  const e = new Error(msg);
  e.usage = true;
  return e;
}

async function loadInput(file, serverCmd, timeoutMs) {
  if (serverCmd && serverCmd.length) {
    const res = await listServerTools(serverCmd[0], serverCmd.slice(1), { timeoutMs });
    return {
      kind: 'tools',
      tools: res.tools,
      source: `${serverCmd.join(' ')}${res.serverInfo ? ` (${res.serverInfo.name} ${res.serverInfo.version || ''})` : ''}`.trim(),
      noise: res.noise,
      wrap: (tools) => ({ tools }),
    };
  }
  if (!file) throw usage('give a JSON file, "-" for stdin, or a server command after --');
  const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  return { ...classify(JSON.parse(text)), source: file === '-' ? 'stdin' : file, noise: [] };
}

function classify(data) {
  if (Array.isArray(data)) return { kind: 'tools', tools: data, wrap: (t) => t };
  if (data && Array.isArray(data.tools)) return { kind: 'tools', tools: data.tools, wrap: (t) => ({ ...data, tools: t }) };
  if (data && data.result && Array.isArray(data.result.tools)) {
    return { kind: 'tools', tools: data.result.tools, wrap: (t) => ({ ...data, result: { ...data.result, tools: t } }) };
  }
  if (data && typeof data === 'object' && typeof data.name === 'string' && (data.inputSchema || data.parameters || data.input_schema)) {
    return { kind: 'tools', tools: [data], wrap: (t) => t[0] };
  }
  return { kind: 'schema', schema: data };
}

function printChangesToStderr(changes) {
  for (const c of changes) {
    process.stderr.write(`${c.kind === 'warn' ? yellow('warn') : dim('fix ')} ${c.path || '/'} ${c.message}${c.lossy ? yellow(' [lossy]') : ''}\n`);
  }
}

function printReports(reports, input) {
  console.log(dim(`source: ${input.source}`));
  if (input.noise && input.noise.length) {
    console.log(
      `${red('✗')} server wrote ${input.noise.length} non-JSON line(s) to stdout — this corrupts the MCP stream in most clients:`,
    );
    for (const l of input.noise.slice(0, 3)) console.log(dim(`    ${l.slice(0, 120)}`));
  }
  for (const r of reports) {
    console.log(`\n${bold(r.target)} ${dim(TARGETS[r.target].label)}`);
    for (const w of r.warnings) console.log(`  ${red('✗')} ${w.message}`);
    for (const t of r.tools) {
      const lossy = t.issues.filter((i) => i.lossy).length;
      console.log(`  ${red('✗')} ${bold(t.name)} ${dim(`${t.issues.length} issue(s)${lossy ? `, ${lossy} lossy` : ''}`)}`);
      for (const i of t.issues) {
        const tag = i.kind === 'warn' ? yellow('warn') : i.lossy ? yellow('lossy') : dim('fixable');
        console.log(`      ${(i.path || '/').padEnd(28)} ${i.message} ${tag}`);
      }
    }
    const ok = r.toolCount - r.tools.length;
    console.log(`  ${ok === r.toolCount && !r.warnings.length ? green('✓') : dim('·')} ${ok}/${r.toolCount} compatible as-is`);
  }
  if (reports.some((r) => r.tools.length)) {
    console.log(dim(`\nRun "mcp-schema-compat fix --target <t>" or wrap the server with "mcp-schema-compat proxy".`));
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === 'number') process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`mcp-schema-compat: ${err.message}\n`);
    if (err.stderr) process.stderr.write(`${dim('server stderr:')}\n${err.stderr}\n`);
    if (err.usage) process.stderr.write('Try --help\n');
    process.exitCode = 2;
  },
);
