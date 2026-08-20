const __vite_import_meta_env__ = {"ASSETS_PREFIX": undefined, "BASE_URL": "/", "DEV": false, "MODE": "production", "PROD": true, "SITE": undefined, "SSR": true};
class OdooError extends Error {
  data;
  constructor(message, data) {
    super(message);
    this.name = "OdooError";
    this.data = data;
  }
}
const env = (key, fallback = "") => (
  // process.env wins so a built server picks up runtime values (see the
  // `preview` script, which loads .env with node --env-file).
  process.env[key] || Object.assign(__vite_import_meta_env__, { ODOO_URL: "https://taps.odoo.com", ODOO_DB: "masbha-tex-taps-master-2093561", ODOO_USERNAME: "ranak@texzipperbd.com", ODOO_PASSWORD: "2326", LANG: process.env.LANG, OS: process.env.OS, USERNAME: process.env.USERNAME, _: process.env._ })?.[key] || fallback
);
const config = {
  get url() {
    return env("ODOO_URL", "https://taps.odoo.com").replace(/\/+$/, "");
  },
  get db() {
    return env("ODOO_DB");
  },
  get login() {
    return env("ODOO_LOGIN") || env("ODOO_USERNAME");
  },
  get password() {
    return env("ODOO_PASSWORD");
  },
  get timezone() {
    return env("ODOO_TZ", "Asia/Dhaka");
  },
  get lang() {
    return env("ODOO_LANG", "en_US");
  }
};
const SESSION_TTL_MS = 30 * 60 * 1e3;
let cached = null;
let inFlight = null;
async function httpFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = err?.cause;
    const code = cause?.code ? ` (${cause.code})` : "";
    const detail = (cause?.message || err.message || "").trim();
    throw new OdooError(
      `Could not reach ${new URL(url).origin}${code}` + (detail && detail !== "fetch failed" ? `: ${detail}` : "") + ". Check ODOO_URL, the network, and that the server is reachable."
    );
  }
}
function parseSessionCookie(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  for (const line of raw) {
    const m = /session_id=([^;]+)/.exec(line ?? "");
    if (m) return `session_id=${m[1]}`;
  }
  return "";
}
async function resolveDb() {
  if (config.db) return config.db;
  const res = await httpFetch(`${config.url}/web/database/list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {} })
  });
  const body = await res.json().catch(() => null);
  const list = body?.result ?? [];
  if (list.length === 1) return list[0];
  throw new OdooError(
    list.length ? `ODOO_DB is not set and the server exposes several databases (${list.join(", ")}).` : "ODOO_DB is not set and the database list is not exposed by this server. Set ODOO_DB in .env."
  );
}
async function authenticate() {
  if (!config.login || !config.password) {
    throw new OdooError(
      "Missing credentials. Set ODOO_URL, ODOO_DB, ODOO_LOGIN (or ODOO_USERNAME) and ODOO_PASSWORD in .env."
    );
  }
  const db = await resolveDb();
  const res = await httpFetch(`${config.url}/web/session/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { db, login: config.login, password: config.password }
    })
  });
  const body = await res.json();
  if (body?.error) {
    throw new OdooError(
      body.error?.data?.message || body.error?.message || "Odoo authentication failed.",
      body.error?.data
    );
  }
  const result = body?.result;
  if (!result?.uid) throw new OdooError("Odoo rejected the credentials (no uid returned).");
  const cookie = parseSessionCookie(res);
  if (!cookie) throw new OdooError("Odoo did not return a session cookie.");
  const allowedMap = result.user_companies?.allowed_companies ?? {};
  const allowed = Object.keys(allowedMap).length ? Object.keys(allowedMap).map(Number) : [result.company_id ?? 1];
  const companies = allowed.map((id) => ({
    id,
    name: allowedMap[String(id)]?.name ?? `Company ${id}`
  }));
  return {
    cookie,
    uid: result.uid,
    userName: result.name ?? result.username ?? config.login,
    db: result.db ?? db,
    allowedCompanyIds: allowed,
    companies,
    companyId: result.user_companies?.current_company ?? result.company_id ?? allowed[0] ?? 1,
    userContext: result.user_context ?? {},
    createdAt: Date.now()
  };
}
async function getSession(force = false) {
  if (!force && cached && Date.now() - cached.createdAt < SESSION_TTL_MS) return cached;
  if (!force && inFlight) return inFlight;
  inFlight = authenticate().then((s) => {
    cached = s;
    return s;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
function productionCompanies(session) {
  const configured = env("PRODUCTION_COMPANIES");
  if (configured) {
    const wanted = configured.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
    const picked = session.companies.filter(
      (c) => wanted.includes(String(c.id)) || wanted.includes(c.name.toLowerCase())
    );
    if (picked.length) return picked;
  }
  const matched = session.companies.filter((c) => /zipper|metal/i.test(c.name));
  return matched.length ? matched : session.companies;
}
function invalidateSession() {
  cached = null;
}
function buildContext(session, extra = {}, companyId) {
  return {
    lang: config.lang,
    tz: config.timezone,
    uid: session.uid,
    allowed_company_ids: companyId ? [companyId] : session.allowedCompanyIds,
    ...extra
  };
}
function isSessionExpired(error) {
  const name = error?.data?.name ?? "";
  return name.includes("SessionExpired") || name.includes("AccessDenied") || error?.code === 100 || /session expired/i.test(error?.message ?? "");
}
async function rpc(path, params, retry = true) {
  const session = await getSession();
  const res = await httpFetch(`${config.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      "x-requested-with": "XMLHttpRequest"
    },
    body: JSON.stringify({ id: Date.now() % 1e5, jsonrpc: "2.0", method: "call", params })
  });
  if (!res.ok) throw new OdooError(`Odoo returned HTTP ${res.status} for ${path}.`);
  const body = await res.json();
  if (body?.error) {
    if (retry && isSessionExpired(body.error)) {
      invalidateSession();
      await getSession(true);
      return rpc(path, params, false);
    }
    const err = body.error;
    throw new OdooError(err?.data?.message?.trim() || err?.message || "Odoo RPC error", err?.data);
  }
  return body.result;
}
async function callKw(model, method, { args = [], kwargs = {} } = {}) {
  return rpc(`/web/dataset/call_kw/${model}/${method}`, { model, method, args, kwargs });
}
async function callButton(model, method, ids, context) {
  return rpc("/web/dataset/call_button", { model, method, args: [ids], kwargs: { context } });
}
async function webSearchRead(model, opts = {}) {
  const session = await getSession();
  return callKw(model, "web_search_read", {
    kwargs: {
      specification: opts.specification ?? { display_name: {} },
      offset: opts.offset ?? 0,
      order: opts.order ?? "",
      limit: opts.limit ?? 80,
      count_limit: 10001,
      domain: opts.domain ?? [],
      context: buildContext(session, {
        bin_size: true,
        current_company_id: session.companyId,
        ...opts.context
      })
    }
  });
}
async function fetchBinary(path) {
  const session = await getSession();
  const res = await httpFetch(`${config.url}${path}`, {
    headers: { cookie: session.cookie, referer: `${config.url}/odoo` }
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || contentType.includes("text/html")) {
    const text = await res.text();
    const m = /<p[^>]*>([\s\S]{0,400}?)<\/p>/i.exec(text);
    throw new OdooError(
      `Odoo could not generate the report (HTTP ${res.status}).` + (m ? ` ${m[1].replace(/<[^>]+>/g, "").trim()}` : "")
    );
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = star ? decodeURIComponent(star[1]) : plain ? plain[1] : "report.xlsx";
  return { buffer: await res.arrayBuffer(), contentType, filename };
}

export { OdooError as O, callKw as a, buildContext as b, config as c, callButton as d, fetchBinary as f, getSession as g, productionCompanies as p, webSearchRead as w };
