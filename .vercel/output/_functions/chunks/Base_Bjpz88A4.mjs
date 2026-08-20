import { e as createComponent, r as renderTemplate, n as renderSlot, g as addAttribute, o as renderHead, h as createAstro } from './astro/server_DfYfYe5M.mjs';
import 'piccolore';
import 'clsx';
/* empty css                             */

var __freeze = Object.freeze;
var __defProp = Object.defineProperty;
var __template = (cooked, raw) => __freeze(__defProp(cooked, "raw", { value: __freeze(cooked.slice()) }));
var _a;
const $$Astro = createAstro();
const $$Base = createComponent(($$result, $$props, $$slots) => {
  const Astro2 = $$result.createAstro($$Astro, $$props, $$slots);
  Astro2.self = $$Base;
  const { title, connected = false, connectionLabel = "Not connected" } = Astro2.props;
  const path = Astro2.url.pathname;
  return renderTemplate(_a || (_a = __template(['<html lang="en"> <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>', `</title><meta name="description" content="Manufacturing reports read live from Odoo over JSON-RPC."><script>
      // Restore the theme before first paint so the toggle never flashes.
      const stored = localStorage.getItem('mrp-theme');
      if (stored) document.documentElement.dataset.theme = stored;
    <\/script>`, '</head> <body> <div class="app"> <header class="topbar"> <div class="brand"> <span>Manufacturing Reports</span> <small>Odoo \xB7 JSON-RPC</small> </div> <nav class="nav" aria-label="Sections"> <a href="/"', '>Production report</a> <a href="/budget"', '>\nBudget follow-up\n</a> <a href="/analytics"', '>\nProduction ABC\n</a> </nav> <div class="topbar-spacer"></div> <div class="conn"> <span', "></span> <span>", '</span> </div> <button class="btn" id="theme-toggle" type="button" aria-label="Toggle colour theme">\nTheme\n</button> </header> ', " </div> <script>\n      document.getElementById('theme-toggle')?.addEventListener('click', () => {\n        const root = document.documentElement;\n        const isDark =\n          root.dataset.theme === 'dark' ||\n          (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);\n        const next = isDark ? 'light' : 'dark';\n        root.dataset.theme = next;\n        localStorage.setItem('mrp-theme', next);\n      });\n    <\/script> </body> </html>"])), title, renderHead(), addAttribute(["nav-link", { active: path === "/" }], "class:list"), addAttribute(["nav-link", { active: path.startsWith("/budget") }], "class:list"), addAttribute(["nav-link", { active: path.startsWith("/analytics") }], "class:list"), addAttribute(connected ? "dot" : "dot off", "class"), connectionLabel, renderSlot($$result, $$slots["default"]));
}, "E:/Khurram sir project/src/layouts/Base.astro", void 0);

export { $$Base as $ };
