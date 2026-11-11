import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { candidates } from './python-env.ts';

const SCRIPT = `import ast, json, sys
issues = []
for file in json.load(sys.stdin):
    name, source = file['path'], file['content']
    try:
        compile(source, name, 'exec')
        tree = ast.parse(source, filename=name)
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler) and node.type is None:
                issues.append({'file': name, 'line': node.lineno, 'message': 'Bare except is forbidden in generated code'})
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                if node.func.value.id == 'pytest' and node.func.attr in ('skip', 'xfail') and 'Empty starter:' not in ast.get_source_segment(source, node):
                    issues.append({'file': name, 'line': node.lineno, 'message': 'Generated tests must not skip or xfail recorded assertions'})
    except (SyntaxError, ValueError) as error:
        issues.append({'file': name, 'line': getattr(error, 'lineno', None), 'message': str(error)})
print(json.dumps(issues))
`;
const validated = new Set<string>();

/** Compiles in memory (no imports, no execution, no __pycache__) before writing any export. */
export function validatePythonFiles(files: { path: string; content: string }[]) {
  const python = files.filter(f => f.path.endsWith('.py'));
  const input = JSON.stringify(python);
  const key = createHash('sha256').update((process.env.VORTEX_PYTHON ?? '') + input).digest('hex');
  if (validated.has(key)) return { ok: true, files: python.length, checks: ['compile', 'ast'] };
  let failure = 'Python was not found. Set VORTEX_PYTHON to a Python 3 executable.';
  for (const command of candidates(process.env.VORTEX_PYTHON ?? '')) {
    const result = spawnSync(command.file, [...command.args, '-c', SCRIPT], { input, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 4_000_000 });
    if (result.error || result.status !== 0) {
      failure = result.error?.message || result.stderr || failure;
      continue;
    }
    const issues = JSON.parse(result.stdout) as { file: string; line?: number; message: string }[];
    if (issues.length) throw Object.assign(new Error('Generated Python validation failed.'), { code: 'PYTHON_VALIDATION', httpStatus: 422, issues });
    if (validated.size > 100) validated.clear();
    validated.add(key);
    return { ok: true, files: python.length, checks: ['compile', 'ast'] };
  }
  throw Object.assign(new Error(`Python compilation is required before export: ${failure}`), { code: 'PYTHON_NOT_READY', httpStatus: 422 });
}
