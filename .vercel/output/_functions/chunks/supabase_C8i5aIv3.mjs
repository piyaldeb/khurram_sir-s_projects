const __vite_import_meta_env__ = {"ASSETS_PREFIX": undefined, "BASE_URL": "/", "DEV": false, "MODE": "production", "PROD": true, "SITE": undefined, "SSR": true};
const env = (key) => process.env[key] || (Object.assign(__vite_import_meta_env__, { SUPABASE_URL: "https://qgafoyopkhtflpjtefiz.supabase.co", SUPABASE_TABLE: "budget_months", SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFnYWZveW9wa2h0ZmxwanRlZml6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzIwNzg1MywiZXhwIjoyMTAyNzgzODUzfQ.mnRWINxhdR2nbbuW6ZHEXAeyTbLS3Sxb9RDZ9gE1jig", OS: process.env.OS, _: process.env._ })?.[key] ?? "");
const supabaseConfig = {
  get url() {
    return (env("SUPABASE_URL") || "").replace(/\/+$/, "");
  },
  get key() {
    return env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_KEY");
  },
  get table() {
    return env("SUPABASE_TABLE") || "budget_months";
  },
  get cacheTable() {
    return env("SUPABASE_CACHE_TABLE") || "app_cache";
  },
  get enabled() {
    return !!(this.url && this.key);
  }
};
class SupabaseError extends Error {
  status;
  constructor(message, status = 0) {
    super(message);
    this.name = "SupabaseError";
    this.status = status;
  }
}
async function rest(path, init = {}) {
  const { url, key } = supabaseConfig;
  if (!url || !key) throw new SupabaseError("Supabase is not configured.");
  let res;
  try {
    res = await fetch(`${url}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...init.headers ?? {}
      }
    });
  } catch (err) {
    const cause = err?.cause;
    throw new SupabaseError(
      `Could not reach ${url}${cause?.code ? ` (${cause.code})` : ""}. Check SUPABASE_URL and the network.`
    );
  }
  if (!res.ok) {
    const body = await res.text();
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      detail = parsed.message || parsed.hint || parsed.details || detail;
    } catch {
    }
    if (res.status === 404 || /does not exist/i.test(detail)) {
      throw new SupabaseError(
        `Table "${supabaseConfig.table}" is missing — run \`npm run db:setup\`. (${detail})`,
        res.status
      );
    }
    throw new SupabaseError(`Supabase ${res.status}: ${detail}`, res.status);
  }
  return res;
}
async function selectBudget(month) {
  const res = await rest(
    `/${supabaseConfig.table}?month=eq.${encodeURIComponent(month)}&select=doc&limit=1`
  );
  const rows = await res.json();
  return rows.length ? rows[0].doc : null;
}
async function selectBudgets(months) {
  const filter = months?.length ? `&month=in.(${months.map((m) => `"${m}"`).join(",")})` : "";
  const res = await rest(`/${supabaseConfig.table}?select=month,doc${filter}&order=month.asc`);
  const rows = await res.json();
  return new Map(rows.map((r) => [r.month, r.doc]));
}
async function upsertBudget(month, doc) {
  await rest(`/${supabaseConfig.table}`, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ month, doc, updated_at: (/* @__PURE__ */ new Date()).toISOString() })
  });
}
async function listBudgetMonths() {
  const res = await rest(`/${supabaseConfig.table}?select=month&order=month.asc`);
  const rows = await res.json();
  return rows.map((r) => r.month);
}
async function cacheGetMany(keys) {
  if (!keys.length) return /* @__PURE__ */ new Map();
  const list = keys.map((k) => `"${k}"`).join(",");
  const res = await rest(`/${supabaseConfig.cacheTable}?select=key,doc&key=in.(${list})`);
  const rows = await res.json();
  return new Map(rows.map((r) => [r.key, r.doc]));
}
async function cacheSet(key, doc) {
  await rest(`/${supabaseConfig.cacheTable}`, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, doc, updated_at: (/* @__PURE__ */ new Date()).toISOString() })
  });
}

export { cacheSet as a, selectBudget as b, cacheGetMany as c, selectBudgets as d, listBudgetMonths as l, supabaseConfig as s, upsertBudget as u };
