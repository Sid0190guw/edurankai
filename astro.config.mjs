import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel/serverless';

import cloudflare from "@astrojs/cloudflare";

const isVercel = process.env.VERCEL === '1';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [tailwind({ applyBaseStyles: false })],
  site: 'https://www.edurankai.in',
  security: { checkOrigin: false },
  server: { port: 4321, host: true }
});