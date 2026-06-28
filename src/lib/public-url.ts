// Resolve the PUBLIC origin for building shareable absolute URLs.
//
// Behind Vercel's proxy, `Astro.request.url` / `Astro.url` can resolve to the
// internal host (e.g. http://localhost), which leaked into share links like
// "https://localhost/profile/...". Prefer the forwarded host headers the proxy
// sets, ignore localhost, and fall back to the canonical production domain.
const CANONICAL = 'https://edurankai.in';

export function publicOrigin(request: Request): string {
  try {
    const h = request.headers;
    const host = (h.get('x-forwarded-host') || h.get('host') || '').split(',')[0].trim();
    if (host && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(host)) {
      const proto = (h.get('x-forwarded-proto') || 'https').split(',')[0].trim();
      return proto + '://' + host;
    }
  } catch (_) {}
  return CANONICAL;
}
