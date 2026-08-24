import { defineConfig, passthroughImageService } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel/serverless';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const isVercel = process.env.VERCEL === '1';

// =================================================================================================
// 821 .astro SOURCE FILES WERE BEING DEPLOYED INSIDE THE SERVERLESS FUNCTION. 20 MB OF THEM.
// =================================================================================================
//
// The Astro compiler emits, into every compiled page, the absolute path of the file it came from:
//
//     const $$file = "C:/Users/user/Projects/edurankai/src/pages/about.astro";
//
// It is there for error reporting and for `Astro.self`. It is a string, and nothing at runtime opens
// it. But @vercel/nft — which decides what to copy into the function by statically reading the
// built output for paths — cannot tell a path that is read from a path that is merely printed, so it
// treated all 821 of them as runtime dependencies and copied the whole source tree in beside the
// build. Confirmed by tracing it directly: each dist/server/pages/X.astro.mjs was the sole parent of
// exactly one src/pages/X.astro.
//
// This is not free on a plan that meters Fluid Active CPU. The function is unpacked and its modules
// evaluated before a request is looked at, and that startup work is charged as CPU. The measurement
// that started this pass: 3h31m of a 4h monthly allowance spent across 289K invocations, while ISR
// Reads sat at 0 of 1M.
//
// excludeFiles is an EXACT-PATH list, not a glob — @astrojs/internal-helpers filters with
// `excludeList.includes(f)` — so the list is generated here rather than hand-written. It is walked
// at build time, so a page added tomorrow is excluded without anybody remembering to add it.
//
// WHAT THIS BREAKS, STATED PLAINLY: any code that reads its own repository source at runtime now
// finds nothing in production. Exactly one thing did — src/lib/horizon/probe.ts, behind
// /admin/horizon/integration — and that page's header already declared this to be its behaviour
// ("A serverless bundle does not ship src/ as readable files, so the assessment degrades to
// `unknown` with the reason printed"). It was wrong only because this line was missing; it renders
// unreadableEvidence() now, which is what it always said it would do.
function astroSourcesUnder(dir, root, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) astroSourcesUnder(full, root, out);
    // Leading './' because the adapter resolves each entry with new URL(file, config.root).
    else if (name.endsWith('.astro')) out.push('./' + relative(root, full).split('\\').join('/'));
  }
  return out;
}
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const astroSources = astroSourcesUnder(join(projectRoot, 'src'), projectRoot);

export default defineConfig({
  output: 'server',
  adapter: isVercel
    ? vercel({ excludeFiles: astroSources })
    : node({ mode: 'standalone' }),
  integrations: [tailwind({ applyBaseStyles: false })],
  site: 'https://edurankai.in',
  // /policy/fees argued the case for an application fee that no longer exists (removed
  // 2026-07 — src/lib/application-fee.ts returns 0 / exempt for every level). The page is
  // deleted, but it sat in every public footer for months, so send the indexed URL to the
  // policy that now states applications are free rather than serving a 404.
  redirects: { '/policy/fees': '/policy/candidate-transparency' },
  security: { checkOrigin: false },
  server: { port: 4321, host: true },
  // NO SHARP. IT WAS 20 MB OF THE 85 MB SERVERLESS FUNCTION AND NOTHING IMPORTED IT.
  //
  // Astro installs its sharp-backed image service by default, and the Vercel adapter traces
  // node_modules/@img — sharp's per-platform native binaries — into the deployed function whether or
  // not the site uses it. This site does not: `astro:assets` is imported by ZERO files, every image
  // on every page is a plain <img> against /public or a remote URL. So the binaries were shipped,
  // unzipped and paged in on every cold start to serve an image service with no callers.
  //
  // Bundle size is not vanity here. The Hobby plan meters Fluid Active CPU, and cold-start work —
  // unpacking the function and evaluating its modules — is CPU that gets charged before the request
  // is even looked at. 3h31m of the 4h month had gone on 289K invocations when this was measured.
  //
  // passthroughImageService keeps <Image>/getImage working as a pass-through if anything adopts
  // astro:assets later: the src is emitted unchanged rather than resized. If a future page needs
  // real transforms, turn on the adapter's `imageService: true` (Vercel's own optimizer, no binary
  // in the bundle) rather than reinstating sharp here.
  image: { service: passthroughImageService() },
  // @vercel/kv is an optional, env-gated runtime dependency (src/lib/vsm/kv.ts): it is
  // dynamically imported only when KV_REST_API_URL is provisioned. Keep it external so the
  // build does not require it to be installed.
  vite: { build: { rollupOptions: { external: ['@vercel/kv'] } } }
});
