// Finds a Python interpreter and checks that pytest and the Appium Python client are installed.

import { execFile } from 'node:child_process';
import { PY_REQUIREMENTS } from './python-codegen.ts';

export interface PythonCommand {
  file: string;
  /** Leading arguments, e.g. ['-3'] for the Windows `py` launcher. */
  args: string[];
}

export interface PythonEnv {
  ok: boolean;
  command: PythonCommand | null;
  version: string | null;
  executable: string | null;
  packages: { pytest: string | null; appium: string | null; selenium: string | null };
  problems: string[];
  installCommand: string | null;
}

const PROBE = [
  'import json, sys',
  'from importlib import metadata',
  'def v(n):',
  '    try:',
  '        return metadata.version(n)',
  '    except Exception:',
  '        return None',
  'print(json.dumps({"version": sys.version.split()[0], "executable": sys.executable, "pytest": v("pytest"), "appium": v("Appium-Python-Client"), "selenium": v("selenium")}))',
].join('\n');

function run(cmd: PythonCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd.file, [...cmd.args, '-c', PROBE], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }, (err, out, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(out)));
  });
}

export function candidates(configured: string, platform: NodeJS.Platform = process.platform): PythonCommand[] {
  if (configured) return [{ file: configured, args: [] }];
  return platform === 'win32'
    ? [{ file: 'py', args: ['-3'] }, { file: 'python', args: [] }, { file: 'python3', args: [] }]
    : [{ file: 'python3', args: [] }, { file: 'python', args: [] }];
}

export async function detectPython(configured = process.env.VORTEX_PYTHON ?? ''): Promise<PythonEnv> {
  const errors: string[] = [];
  for (const cmd of candidates(configured)) {
    let info: { version: string; executable: string; pytest: string | null; appium: string | null; selenium: string | null };
    try {
      info = JSON.parse((await run(cmd)).trim().split(/\r?\n/).pop() ?? '{}');
    } catch (e) {
      errors.push(`${[cmd.file, ...cmd.args].join(' ')}: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    const problems: string[] = [];
    const [major, minor] = info.version.split('.').map(Number);
    if (major < 3 || (major === 3 && minor < 9)) problems.push(`Python ${info.version} is too old; use Python 3.9 or newer.`);
    if (!info.pytest) problems.push('pytest is not installed.');
    if (!info.appium) problems.push('Appium-Python-Client is not installed.');
    const exe = [cmd.file, ...cmd.args].map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
    return {
      ok: problems.length === 0,
      command: cmd,
      version: info.version,
      executable: info.executable,
      packages: { pytest: info.pytest, appium: info.appium, selenium: info.selenium },
      problems,
      installCommand: problems.length ? `${exe} -m pip install ${PY_REQUIREMENTS.map((r) => `"${r}"`).join(' ')}` : null,
    };
  }
  return {
    ok: false,
    command: null,
    version: null,
    executable: null,
    packages: { pytest: null, appium: null, selenium: null },
    problems: [`Python was not found (${errors.join('; ') || 'no candidates'}). Install Python 3.9+ or set VORTEX_PYTHON to python.exe.`],
    installCommand: null,
  };
}
