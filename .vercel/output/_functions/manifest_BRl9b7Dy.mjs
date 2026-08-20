import 'piccolore';
import { p as decodeKey } from './chunks/astro/server_DfYfYe5M.mjs';
import 'clsx';
import { N as NOOP_MIDDLEWARE_FN } from './chunks/astro-designed-error-pages_oRcQ1Bn4.mjs';
import 'es-module-lexer';

function sanitizeParams(params) {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      if (typeof value === "string") {
        return [key, value.normalize().replace(/#/g, "%23").replace(/\?/g, "%3F")];
      }
      return [key, value];
    })
  );
}
function getParameter(part, params) {
  if (part.spread) {
    return params[part.content.slice(3)] || "";
  }
  if (part.dynamic) {
    if (!params[part.content]) {
      throw new TypeError(`Missing parameter: ${part.content}`);
    }
    return params[part.content];
  }
  return part.content.normalize().replace(/\?/g, "%3F").replace(/#/g, "%23").replace(/%5B/g, "[").replace(/%5D/g, "]");
}
function getSegment(segment, params) {
  const segmentPath = segment.map((part) => getParameter(part, params)).join("");
  return segmentPath ? "/" + segmentPath : "";
}
function getRouteGenerator(segments, addTrailingSlash) {
  return (params) => {
    const sanitizedParams = sanitizeParams(params);
    let trailing = "";
    if (addTrailingSlash === "always" && segments.length) {
      trailing = "/";
    }
    const path = segments.map((segment) => getSegment(segment, sanitizedParams)).join("") + trailing;
    return path || "/";
  };
}

function deserializeRouteData(rawRouteData) {
  return {
    route: rawRouteData.route,
    type: rawRouteData.type,
    pattern: new RegExp(rawRouteData.pattern),
    params: rawRouteData.params,
    component: rawRouteData.component,
    generate: getRouteGenerator(rawRouteData.segments, rawRouteData._meta.trailingSlash),
    pathname: rawRouteData.pathname || void 0,
    segments: rawRouteData.segments,
    prerender: rawRouteData.prerender,
    redirect: rawRouteData.redirect,
    redirectRoute: rawRouteData.redirectRoute ? deserializeRouteData(rawRouteData.redirectRoute) : void 0,
    fallbackRoutes: rawRouteData.fallbackRoutes.map((fallback) => {
      return deserializeRouteData(fallback);
    }),
    isIndex: rawRouteData.isIndex,
    origin: rawRouteData.origin
  };
}

function deserializeManifest(serializedManifest) {
  const routes = [];
  for (const serializedRoute of serializedManifest.routes) {
    routes.push({
      ...serializedRoute,
      routeData: deserializeRouteData(serializedRoute.routeData)
    });
    const route = serializedRoute;
    route.routeData = deserializeRouteData(serializedRoute.routeData);
  }
  const assets = new Set(serializedManifest.assets);
  const componentMetadata = new Map(serializedManifest.componentMetadata);
  const inlinedScripts = new Map(serializedManifest.inlinedScripts);
  const clientDirectives = new Map(serializedManifest.clientDirectives);
  const serverIslandNameMap = new Map(serializedManifest.serverIslandNameMap);
  const key = decodeKey(serializedManifest.key);
  return {
    // in case user middleware exists, this no-op middleware will be reassigned (see plugin-ssr.ts)
    middleware() {
      return { onRequest: NOOP_MIDDLEWARE_FN };
    },
    ...serializedManifest,
    assets,
    componentMetadata,
    inlinedScripts,
    clientDirectives,
    routes,
    serverIslandNameMap,
    key
  };
}

const manifest = deserializeManifest({"hrefRoot":"file:///E:/Khurram%20sir%20project/","cacheDir":"file:///E:/Khurram%20sir%20project/node_modules/.astro/","outDir":"file:///E:/Khurram%20sir%20project/dist/","srcDir":"file:///E:/Khurram%20sir%20project/src/","publicDir":"file:///E:/Khurram%20sir%20project/public/","buildClientDir":"file:///E:/Khurram%20sir%20project/dist/client/","buildServerDir":"file:///E:/Khurram%20sir%20project/dist/server/","adapterName":"@astrojs/vercel","routes":[{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"type":"page","component":"_server-islands.astro","params":["name"],"segments":[[{"content":"_server-islands","dynamic":false,"spread":false}],[{"content":"name","dynamic":true,"spread":false}]],"pattern":"^\\/_server-islands\\/([^/]+?)\\/?$","prerender":false,"isIndex":false,"fallbackRoutes":[],"route":"/_server-islands/[name]","origin":"internal","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"type":"endpoint","isIndex":false,"route":"/_image","pattern":"^\\/_image\\/?$","segments":[[{"content":"_image","dynamic":false,"spread":false}]],"params":[],"component":"node_modules/astro/dist/assets/endpoint/generic.js","pathname":"/_image","prerender":false,"fallbackRoutes":[],"origin":"internal","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[{"type":"external","src":"/_astro/analytics.Dqw0-cgG.css"}],"routeData":{"route":"/analytics","isIndex":false,"type":"page","pattern":"^\\/analytics\\/?$","segments":[[{"content":"analytics","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/analytics.astro","pathname":"/analytics","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/analytics","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/analytics\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"analytics","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/analytics.ts","pathname":"/api/analytics","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/backfill","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/backfill\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"backfill","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/backfill.ts","pathname":"/api/backfill","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/budget","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/budget\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"budget","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/budget.ts","pathname":"/api/budget","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/day-report","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/day-report\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"day-report","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/day-report.ts","pathname":"/api/day-report","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/download","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/download\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"download","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/download.ts","pathname":"/api/download","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/lookup","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/lookup\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"lookup","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/lookup.ts","pathname":"/api/lookup","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/production","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/production\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"production","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/production.ts","pathname":"/api/production","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/report","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/report\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"report","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/report.ts","pathname":"/api/report","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/summary","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/summary\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"summary","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/summary.ts","pathname":"/api/summary","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/sync","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/sync\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"sync","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/sync.ts","pathname":"/api/sync","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[{"type":"external","src":"/_astro/analytics.Dqw0-cgG.css"}],"routeData":{"route":"/budget","isIndex":false,"type":"page","pattern":"^\\/budget\\/?$","segments":[[{"content":"budget","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/budget.astro","pathname":"/budget","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[{"type":"external","src":"/_astro/analytics.Dqw0-cgG.css"}],"routeData":{"route":"/reports","isIndex":false,"type":"page","pattern":"^\\/reports\\/?$","segments":[[{"content":"reports","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/reports.astro","pathname":"/reports","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[{"type":"external","src":"/_astro/analytics.Dqw0-cgG.css"}],"routeData":{"route":"/","isIndex":true,"type":"page","pattern":"^\\/$","segments":[],"params":[],"component":"src/pages/index.astro","pathname":"/","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}}],"base":"/","trailingSlash":"ignore","compressHTML":true,"componentMetadata":[["E:/Khurram sir project/src/pages/analytics.astro",{"propagation":"none","containsHead":true}],["E:/Khurram sir project/src/pages/budget.astro",{"propagation":"none","containsHead":true}],["E:/Khurram sir project/src/pages/index.astro",{"propagation":"none","containsHead":true}],["E:/Khurram sir project/src/pages/reports.astro",{"propagation":"none","containsHead":true}]],"renderers":[],"clientDirectives":[["idle","(()=>{var l=(n,t)=>{let i=async()=>{await(await n())()},e=typeof t.value==\"object\"?t.value:void 0,s={timeout:e==null?void 0:e.timeout};\"requestIdleCallback\"in window?window.requestIdleCallback(i,s):setTimeout(i,s.timeout||200)};(self.Astro||(self.Astro={})).idle=l;window.dispatchEvent(new Event(\"astro:idle\"));})();"],["load","(()=>{var e=async t=>{await(await t())()};(self.Astro||(self.Astro={})).load=e;window.dispatchEvent(new Event(\"astro:load\"));})();"],["media","(()=>{var n=(a,t)=>{let i=async()=>{await(await a())()};if(t.value){let e=matchMedia(t.value);e.matches?i():e.addEventListener(\"change\",i,{once:!0})}};(self.Astro||(self.Astro={})).media=n;window.dispatchEvent(new Event(\"astro:media\"));})();"],["only","(()=>{var e=async t=>{await(await t())()};(self.Astro||(self.Astro={})).only=e;window.dispatchEvent(new Event(\"astro:only\"));})();"],["visible","(()=>{var a=(s,i,o)=>{let r=async()=>{await(await s())()},t=typeof i.value==\"object\"?i.value:void 0,c={rootMargin:t==null?void 0:t.rootMargin},n=new IntersectionObserver(e=>{for(let l of e)if(l.isIntersecting){n.disconnect(),r();break}},c);for(let e of o.children)n.observe(e)};(self.Astro||(self.Astro={})).visible=a;window.dispatchEvent(new Event(\"astro:visible\"));})();"]],"entryModules":{"\u0000@astro-page:src/pages/analytics@_@astro":"pages/analytics.astro.mjs","\u0000@astro-page:src/pages/api/analytics@_@ts":"pages/api/analytics.astro.mjs","\u0000@astro-page:src/pages/api/backfill@_@ts":"pages/api/backfill.astro.mjs","\u0000@astro-page:src/pages/api/budget@_@ts":"pages/api/budget.astro.mjs","\u0000@astro-page:src/pages/api/day-report@_@ts":"pages/api/day-report.astro.mjs","\u0000@astro-page:src/pages/api/download@_@ts":"pages/api/download.astro.mjs","\u0000@astro-page:src/pages/api/lookup@_@ts":"pages/api/lookup.astro.mjs","\u0000@astro-page:src/pages/api/production@_@ts":"pages/api/production.astro.mjs","\u0000@astro-page:src/pages/api/report@_@ts":"pages/api/report.astro.mjs","\u0000@astro-page:src/pages/api/summary@_@ts":"pages/api/summary.astro.mjs","\u0000@astro-page:src/pages/api/sync@_@ts":"pages/api/sync.astro.mjs","\u0000@astro-page:src/pages/budget@_@astro":"pages/budget.astro.mjs","\u0000@astro-page:src/pages/index@_@astro":"pages/index.astro.mjs","\u0000@astro-page:src/pages/reports@_@astro":"pages/reports.astro.mjs","\u0000@astrojs-ssr-virtual-entry":"entry.mjs","\u0000@astro-renderers":"renderers.mjs","\u0000noop-middleware":"_noop-middleware.mjs","\u0000virtual:astro:actions/noop-entrypoint":"noop-entrypoint.mjs","\u0000@astro-page:node_modules/astro/dist/assets/endpoint/generic@_@js":"pages/_image.astro.mjs","\u0000@astrojs-ssr-adapter":"_@astrojs-ssr-adapter.mjs","\u0000@astrojs-manifest":"manifest_BRl9b7Dy.mjs","E:/Khurram sir project/node_modules/astro/dist/assets/services/sharp.js":"chunks/sharp_D-C1sjZi.mjs","E:/Khurram sir project/src/pages/analytics.astro?astro&type=script&index=0&lang.ts":"_astro/analytics.astro_astro_type_script_index_0_lang.b4qlfMkn.js","E:/Khurram sir project/src/pages/budget.astro?astro&type=script&index=0&lang.ts":"_astro/budget.astro_astro_type_script_index_0_lang.Beia4nT0.js","E:/Khurram sir project/src/pages/index.astro?astro&type=script&index=0&lang.ts":"_astro/index.astro_astro_type_script_index_0_lang.48DppwNx.js","E:/Khurram sir project/src/pages/reports.astro?astro&type=script&index=0&lang.ts":"_astro/reports.astro_astro_type_script_index_0_lang.Dmq1Kg2j.js","astro:scripts/before-hydration.js":""},"inlinedScripts":[],"assets":["/_astro/analytics.Dqw0-cgG.css","/_astro/analytics.astro_astro_type_script_index_0_lang.b4qlfMkn.js","/_astro/budget.astro_astro_type_script_index_0_lang.Beia4nT0.js","/_astro/charts.2Y9DLUrZ.js","/_astro/index.astro_astro_type_script_index_0_lang.48DppwNx.js","/_astro/reports.astro_astro_type_script_index_0_lang.Dmq1Kg2j.js"],"buildFormat":"directory","checkOrigin":true,"allowedDomains":[],"actionBodySizeLimit":1048576,"serverIslandNameMap":[],"key":"t4txGjmBa3CvckmMe1j27MGm73qYMvv8e1qMYDxh+58="});
if (manifest.sessionConfig) manifest.sessionConfig.driverModule = null;

export { manifest };
