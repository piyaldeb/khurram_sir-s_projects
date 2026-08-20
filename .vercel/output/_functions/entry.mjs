import { renderers } from './renderers.mjs';
import { c as createExports, s as serverEntrypointModule } from './chunks/_@astrojs-ssr-adapter_B1ZivKST.mjs';
import { manifest } from './manifest_BRl9b7Dy.mjs';

const serverIslandMap = new Map();;

const _page0 = () => import('./pages/_image.astro.mjs');
const _page1 = () => import('./pages/analytics.astro.mjs');
const _page2 = () => import('./pages/api/analytics.astro.mjs');
const _page3 = () => import('./pages/api/backfill.astro.mjs');
const _page4 = () => import('./pages/api/budget.astro.mjs');
const _page5 = () => import('./pages/api/day-report.astro.mjs');
const _page6 = () => import('./pages/api/download.astro.mjs');
const _page7 = () => import('./pages/api/lookup.astro.mjs');
const _page8 = () => import('./pages/api/production.astro.mjs');
const _page9 = () => import('./pages/api/report.astro.mjs');
const _page10 = () => import('./pages/api/summary.astro.mjs');
const _page11 = () => import('./pages/api/sync.astro.mjs');
const _page12 = () => import('./pages/budget.astro.mjs');
const _page13 = () => import('./pages/reports.astro.mjs');
const _page14 = () => import('./pages/index.astro.mjs');
const pageMap = new Map([
    ["node_modules/astro/dist/assets/endpoint/generic.js", _page0],
    ["src/pages/analytics.astro", _page1],
    ["src/pages/api/analytics.ts", _page2],
    ["src/pages/api/backfill.ts", _page3],
    ["src/pages/api/budget.ts", _page4],
    ["src/pages/api/day-report.ts", _page5],
    ["src/pages/api/download.ts", _page6],
    ["src/pages/api/lookup.ts", _page7],
    ["src/pages/api/production.ts", _page8],
    ["src/pages/api/report.ts", _page9],
    ["src/pages/api/summary.ts", _page10],
    ["src/pages/api/sync.ts", _page11],
    ["src/pages/budget.astro", _page12],
    ["src/pages/reports.astro", _page13],
    ["src/pages/index.astro", _page14]
]);

const _manifest = Object.assign(manifest, {
    pageMap,
    serverIslandMap,
    renderers,
    actions: () => import('./noop-entrypoint.mjs'),
    middleware: () => import('./_noop-middleware.mjs')
});
const _args = {
    "middlewareSecret": "f7857a9d-61f6-459f-9dac-dc403bc5450e",
    "skewProtection": false
};
const _exports = createExports(_manifest, _args);
const __astrojsSsrVirtualEntry = _exports.default;
const _start = 'start';
if (Object.prototype.hasOwnProperty.call(serverEntrypointModule, _start)) ;

export { __astrojsSsrVirtualEntry as default, pageMap };
