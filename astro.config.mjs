// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';

/**
 * One codebase, two targets.
 *
 * Locally the Node adapter runs a normal long-lived server. On Vercel the app
 * becomes serverless functions, which changes two things that matter here:
 * there is no writable filesystem (so Supabase must be configured — see
 * src/lib/storage.ts and src/lib/packing.ts), and every request has a hard time
 * limit, which is why the analytics endpoint fills a few months per call.
 *
 * `DEPLOY_TARGET=vercel` selects it; Vercel sets VERCEL=1 itself.
 */
const onVercel = !!process.env.VERCEL || process.env.DEPLOY_TARGET === 'vercel';

export default defineConfig({
  output: 'server',
  adapter: onVercel
    ? vercel({
        // Odoo builds these reports slowly; the default 10s is not enough.
        maxDuration: 60,
      })
    : node({ mode: 'standalone' }),
  server: { port: Number(process.env.PORT ?? 4321), host: true },
  vite: {
    ssr: { external: ['exceljs'] },
  },
});
