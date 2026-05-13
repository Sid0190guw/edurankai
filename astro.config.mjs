import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';
import cloudflare from '@astrojs/cloudflare';

// Adapter selection:
// Set BUILD_TARGET=cloudflare for production build (Cloudflare Pages)
// Otherwise defaults to Node (local dev + traditional VPS)
const useCloudflare = process.env.BUILD_TARGET === 'cloudflare';

export default defineConfig({
  output: 'server',
  adapter: useCloudflare
    ? cloudflare({ platformProxy: { enabled: true } })
    : node({ mode: 'standalone' }),
  integrations: [tailwind({ applyBaseStyles: false })],
  site: 'https://www.edurankai.in',
  server: { port: 4321, host: true }
});
