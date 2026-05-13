import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel/serverless';

// Adapter selection:
// Vercel auto-detects via VERCEL=1 env var at build time
// Otherwise defaults to Node (local dev)
const isVercel = process.env.VERCEL === '1';

export default defineConfig({
  output: 'server',
  adapter: isVercel
    ? vercel()
    : node({ mode: 'standalone' }),
  integrations: [tailwind({ applyBaseStyles: false })],
  site: 'https://www.edurankai.in',
  server: { port: 4321, host: true }
});
