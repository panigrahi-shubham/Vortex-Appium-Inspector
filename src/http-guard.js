// Protects the local recorder API from other web pages open in the same browser.
//
// The server already listens on 127.0.0.1 only, but a page on any website can still send requests to
// http://127.0.0.1:4700 from your browser. Since the API can now start and stop processes, every request must:
//   - be addressed to localhost by name (blocks DNS-rebinding tricks), and
//   - for anything that changes state: come from the recorder page itself and carry a JSON body
//     (a cross-site page cannot send application/json without a CORS preflight, which this server never approves).

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** @returns {string | null} an error message, or null when the request is allowed */
export function checkLocalRequest(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!LOCAL_HOSTS.some((h) => host === `${h}:${port}`)) return `request blocked: unexpected Host header "${host}"`;
  if (req.method === 'GET' || req.method === 'HEAD') return null;

  const origin = req.headers.origin;
  if (origin !== undefined && !LOCAL_HOSTS.some((h) => origin.toLowerCase() === `http://${h}:${port}`)) {
    return `request blocked: it came from another site (${origin})`;
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return `request blocked: cross-site request (${site})`;
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) return 'request blocked: the body must be sent as application/json';
  return null;
}
