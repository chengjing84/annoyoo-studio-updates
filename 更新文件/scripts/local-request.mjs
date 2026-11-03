// Some local request filters strip the port from Origin. Only accept that
// variant when the browser's same-origin metadata and Referer agree on the
// actual local host and port, which callers validate separately.
export function isAllowedLocalOrigin(request, allowedOrigins) {
  const { origin, referer, host } = request.headers;
  if (!origin || allowedOrigins.has(origin)) return true;
  if (request.headers['sec-fetch-site'] !== 'same-origin' || !referer) return false;
  try {
    const source = new URL(origin);
    const page = new URL(referer);
    return source.origin === origin && source.protocol === 'http:' && !source.port
      && ['127.0.0.1', 'localhost'].includes(source.hostname)
      && page.protocol === source.protocol && page.hostname === source.hostname
      && page.host === host && allowedOrigins.has(page.origin);
  } catch { return false; }
}
