// Appium output goes to a log file (not a pipe), so it survives a recorder restart and can be read back later.

import fs from 'node:fs';

// The value must not be an already-masked "Bearer ***", otherwise only the word Bearer would be replaced.
const SECRET_KEYS = /("?(?:password|passwd|pwd|token|secret|otp|apikey|api_key|authorization|accesskey|access_key)"?\s*[:=]\s*)(?!(?:Bearer|Basic) \*\*\*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

export function redact(line: string): string {
  // Credentials after Bearer/Basic first, then key=value style secrets.
  return line.replace(BEARER, '$1 ***').replace(SECRET_KEYS, '$1"***"');
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** Last `maxLines` lines of a log file, colour codes removed and secrets masked. */
export function tailLog(file: string, maxLines = 200, maxBytes = 256 * 1024): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift(); // first line may be cut in half
    return lines.filter((l) => l.length).slice(-maxLines).map((l) => redact(l.replace(ANSI, '')));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
