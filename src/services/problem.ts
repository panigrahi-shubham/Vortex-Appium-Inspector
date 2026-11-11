// Shared by every service: the product version and the error shape the HTTP layer understands.

export const VERSION = '1.0.0';

/** An error the API reports as `{ error, code }` with the given HTTP status. */
export function problem(message: string, code = 'BAD_REQUEST', httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus });
}

export const assertPackage = (pkg: string) => {
  if (!/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(pkg)) throw problem('Enter a valid Android package, for example com.indiamart.m.');
  return pkg;
};

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
