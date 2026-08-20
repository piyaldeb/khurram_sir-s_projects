/**
 * Server-side configuration lookup.
 *
 * Deliberately does NOT touch `import.meta.env`. Vite replaces that object
 * literally at build time, so any dynamic access to it bakes *every* variable —
 * including passwords and service keys — into the emitted bundle as plaintext.
 * Reading `process.env` keeps secrets out of build output entirely.
 *
 * Locally that means .env has to reach `process.env` ourselves, which is what
 * the loader below does. On a platform (Vercel, and anything that sets its own
 * environment) the values are already there and the file is never read.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded = false;

function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;

  // Platforms inject their own configuration; there is no .env to read there.
  if (process.env.VERCEL || process.env.NETLIFY || process.env.CF_PAGES) return;

  try {
    const text = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const [, key, raw] = match;
      if (process.env[key]) continue; // a real environment variable always wins
      process.env[key] = raw.replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env — the environment is expected to provide the values */
  }
}

export function env(key: string, fallback = ''): string {
  loadLocalEnv();
  return process.env[key] || fallback;
}
