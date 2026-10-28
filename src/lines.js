// Newline-delimited JSON framing used by MCP's stdio transport.
export function onLines(stream, cb) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) cb(line);
    }
  });
  stream.on('end', () => {
    if (buf.trim()) cb(buf.replace(/\r$/, ''));
    buf = '';
  });
}

export function tryParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

// On Windows, npx/uvx are .cmd shims that only run through a shell. Absolute
// paths to real executables (node.exe) must not, or spaces in the path break.
export function needsShell(command) {
  return process.platform === 'win32' && !/\.(exe|com)$/i.test(command);
}
