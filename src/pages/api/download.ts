import type { APIRoute } from 'astro';
import { generateReport } from '~/lib/reports';
import { OdooError } from '~/lib/odoo';

export const prerender = false;

/** Streams the untouched Odoo workbook, so the user gets the real Excel file. */
export const GET: APIRoute = async ({ url }) => {
  const reportType = url.searchParams.get('report_type');
  if (!reportType) return new Response('report_type is required', { status: 400 });

  try {
    const artifact = await generateReport({
      report_type: reportType,
      date_from: url.searchParams.get('date_from'),
      date_to: url.searchParams.get('date_to'),
      buyer_id: Number(url.searchParams.get('buyer_id')) || null,
      challan_id: Number(url.searchParams.get('challan_id')) || null,
    });

    return new Response(artifact.buffer, {
      headers: {
        'content-type': artifact.contentType,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    const message = err instanceof OdooError ? err.message : (err as Error).message;
    return new Response(message, { status: 502, headers: { 'content-type': 'text/plain' } });
  }
};
