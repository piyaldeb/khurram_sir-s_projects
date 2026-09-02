/**
 * Compress what goes over the wire.
 *
 * These pages ship large, extremely repetitive JSON — a year of orders is the
 * same twenty keys four thousand times — and none of it was compressed. Vercel
 * compresses on the way out, but the Node server does not, so a self-hosted
 * install or a preview build was sending the lot raw.
 *
 * Gzip rather than brotli: brotli at a useful quality costs more CPU per
 * request than the transfer it saves on a fast network, and every browser has
 * taken gzip for twenty years.
 */
import type { MiddlewareHandler } from 'astro';
import { HOME, isOpen } from './lib/access';

/** Below this, the header costs more than the compression saves. */
const MIN_BYTES = 1024;

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|manifest))/i;

export const onRequest: MiddlewareHandler = async (context, next) => {
  // Only the open pages are served. Built assets pass; every other page and
  // API route goes home, and a closed API call gets a plain refusal so a
  // script does not receive HTML where it expected JSON.
  const { pathname } = context.url;
  if (!pathname.startsWith('/_astro/') && !pathname.startsWith('/favicon') && !isOpen(pathname)) {
    if (pathname.startsWith('/api/')) return new Response('Not available', { status: 404 });
    return context.redirect(HOME, 302);
  }

  const response = await next();

  const accepts = context.request.headers.get('accept-encoding') ?? '';
  if (!/\bgzip\b/i.test(accepts)) return response;

  // Already encoded, or nothing to encode.
  if (response.headers.has('content-encoding') || !response.body) return response;
  if (response.status === 204 || response.status === 304) return response;

  const type = response.headers.get('content-type') ?? '';
  if (!COMPRESSIBLE.test(type)) return response;

  // Skip small bodies where the length is known; an unknown length is assumed
  // worth compressing, since streamed responses here are the big ones.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && declared < MIN_BYTES) return response;

  const headers = new Headers(response.headers);
  headers.set('content-encoding', 'gzip');
  // The body length changes, and the old one would be a lie.
  headers.delete('content-length');
  headers.append('vary', 'accept-encoding');

  return new Response(response.body.pipeThrough(new CompressionStream('gzip')), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
