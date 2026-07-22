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
  security: { checkOrigin: false },
  server: { port: 4321, host: true },
  // @vercel/kv is an optional, env-gated runtime dependency (src/lib/vsm/kv.ts): it is
  // dynamically imported only when KV_REST_API_URL is provisioned. Keep it external so the
  // build does not require it to be installed.
  vite: { build: { rollupOptions: { external: ['@vercel/kv'] } } }
});
