// /visvambhara/<module>.html — the seven restricted VESPER research modules.
//
// WHY THIS ROUTE EXISTS AT ALL.
//
// These seven documents lived in public/visvambhara/ and were guarded by a middleware block in
// src/middleware.ts that keys on `path.startsWith('/visvambhara/')`. That block never ran. Anything
// under public/ is emitted to .vercel/output/static/, and the adapter writes `{"handle":"filesystem"}`
// into .vercel/output/config.json BEFORE every `dest:"_render"` route — so Vercel matched the file on
// disk and served it straight from the CDN. Astro middleware only runs when the request reaches the
// render function, which it never did. Verified against production on 2026-08-30: all seven returned
// 200 with their full bodies to an anonymous client, 3.6 MB in total, `X-Vercel-Cache: HIT`.
//
// Moving the files to src/visvambhara-modules/ takes them out of the static output entirely. They are
// now reachable ONLY through this endpoint, which is a real SSR route, which means the middleware
// gate finally applies to them — and this file re-checks anyway, because protection that depends on
// one `startsWith` in a 900-line middleware being evaluated in the right order is protection that can
// be lost by a routing change nobody connects to this feature.
//
// URLs ARE UNCHANGED. The `.html` stays in the path: `[module]` captures "architecture.html", so
// every existing link, bookmark and the hub's own `/visvambhara/${m.slug}.html` keep working.
import type { APIRoute } from 'astro';
import { hasApprovedAccess } from '@/lib/visvambhara-access';
import { can } from '@/lib/auth/permissions';

// Bundled by Vite as separate on-demand chunks, not eagerly: a request for the 36 KB 3D viewer must
// not pull the 1.5 MB concept film into memory with it. Using a glob (rather than fs.readFileSync)
// is deliberate — @vercel/nft cannot trace a path built at runtime, so a filesystem read would
// deploy a function whose files are not there. A glob is resolved by the bundler, so it always is.
const MODULES = import.meta.glob('../../visvambhara-modules/*.html', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/** module slug -> loader, keyed the way the URL spells it. */
const BY_NAME = new Map<string, () => Promise<string>>();
for (const [path, load] of Object.entries(MODULES)) {
  const base = path.slice(path.lastIndexOf('/') + 1); // "architecture.html"
  BY_NAME.set(base, load);
  BY_NAME.set(base.replace(/\.html$/, ''), load); // tolerate an extensionless link
}

const DENY = '/products/visvambhara/access';
const redirect = () => new Response(null, { status: 302, headers: { Location: DENY, 'cache-control': 'no-store' } });

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  // FAIL CLOSED, IN THIS ORDER: identity, then approval, then existence. Checking existence first
  // would turn this endpoint into an oracle that tells an anonymous caller which module names are
  // real — a smaller leak than the documents, but the same kind.
  const user = (locals as any)?.user;
  if (!user) return redirect();

  // Asks for the capability, not for "not an applicant" — `research.restricted.view`, which the
  // role editor grants, revokes and audits. Same population as before (every non-applicant role
  // holds it), but revoking it now takes effect. Anyone without it still gets in on an approved
  // access row, which is the path an external researcher is supposed to take. Mirrors middleware.ts.
  if (!can(user, 'research.restricted.view')) {
    let ok = false;
    try {
      ok = await hasApprovedAccess(user.id);
    } catch (e: any) {
      // A database that cannot answer is NOT an approval. Redirect rather than serve.
      console.error('[visvambhara/module] access check failed:', e?.cause?.message || e?.message);
      return redirect();
    }
    if (!ok) return redirect();
  }

  const load = BY_NAME.get(String(params.module || ''));
  if (!load) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

  const html = await load();
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // NEVER let a CDN or a shared proxy hold one of these: the response is specific to an approved
      // viewer, and a cached copy is exactly the public URL this change exists to remove.
      'cache-control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
};
