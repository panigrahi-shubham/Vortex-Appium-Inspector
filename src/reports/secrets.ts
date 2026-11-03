// Masks the values of secret environment variables (VORTEX_SECRET_*, *PASSWORD*, *TOKEN*, *SECRET*, *OTP*) wherever
// run output or reports could contain them. The pattern-based masking in appium/log-file.ts still applies on top.

const SECRET_NAME = /^VORTEX_SECRET_|PASSWORD|PASSWD|TOKEN|SECRET|(^|_)OTP($|_)|API_?KEY/i;

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 4)
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
}

export function maskSecrets(text: string, values: string[] = secretValues()): string {
  let out = text;
  for (const v of values) if (out.includes(v)) out = out.split(v).join('****');
  return out;
}
