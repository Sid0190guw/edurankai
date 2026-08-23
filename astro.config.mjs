import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel/serverless';

const isVercel = process.env.VERCEL === '1';

export default defineConfig({
  output: 'server',
  adapter: isVercel
    ? vercel()
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
  // @vercel/kv is an optional, env-gated runtime dependency (src/lib/vsm/kv.ts): it is
  // dynamically imported only when KV_REST_API_URL is provisioned. Keep it external so the
  // build does not require it to be installed.
  vite: { build: { rollupOptions: { external: ['@vercel/kv'] } } }
});
