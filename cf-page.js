/* ============================================================
   cf-page.js — new-backend glue for Hub pages that do NOT use supa.js
   (gp-fleet, gp-jobs, gp-chauffeur, gp-chauffeur-hod, gp-marketing, gp-minigames,
    gp-agreement, gp-checklist, gp-qc, gp-sign).

   LOADED ONLY WHEN THE SWITCH IS ON (localStorage.gp_backend === "cf"), by the small guard
   <script> in each page, right after cf-client.js. Switch off = this file is never downloaded.

   What it does (switch on only):
   1. supabase.createClient(<Supabase URL>, ...) returns the cf-client instead (pages keep their sb.* code).
   2. fetch() to the Supabase server (/rest/v1, /rest/v1/rpc, /storage/v1/object) is answered by
      GPCF.handleSupabaseFetch -> the new API. /functions/v1/* still goes to Supabase unchanged.
      Photo links the page builds for the OLD storage (…/storage/v1/object/public/<bucket>/<path>) become the
      bare key gp/storage/<bucket>/<path> in data sent to the new API (server signs keys on read), and the
      signed URL of this page's upload in any other request body (Apps Script PDF).
   3. Shows who is on what: a small "NEW SYSTEM" tag; a bar when not signed in on the new system;
      on no-login pages (window.GPCF_PAGE_CFG.public) a full-screen notice, because the new server
      has no public (no-login) data route yet.
   Realtime: none of these pages subscribes to realtime today, so no polling fallback is needed.
   ============================================================ */
(function (g) {
  'use strict';
  var CFG = g.GPCF_PAGE_CFG || {};
  if (!g.GPCF || !g.GPCF.createClient || !g.GPCF.handleSupabaseFetch) {
    try { g.console.warn('[cf-page] cf-client.js did not load — this page stays on the current system'); } catch (e) {}
    return;
  }
  var SB_ORIGIN = 'https://gpdb.grandlab.com.my';
  var realFetch = g.fetch ? g.fetch.bind(g) : null;
  var client = g.GPCF.createClient({ tenant: 'gp', fetch: realFetch ? function (u, i) { return realFetch(u, i); } : undefined });

  function origins() {
    var list = [SB_ORIGIN];
    try { /* global SUPABASE_URL */ if (typeof SUPABASE_URL === 'string' && SUPABASE_URL) list.push(new URL(SUPABASE_URL).origin); } catch (e) {}
    return list;
  }
  function isSupabaseUrl(url) {
    try { return origins().indexOf(new URL(String(url), g.location.href).origin) >= 0; } catch (e) { return false; }
  }
  function json400(code, msg, status) {
    var body = JSON.stringify({ code: code, message: msg, details: null, hint: 'Switch back with ?backend=sb' });
    return Promise.resolve(new g.Response(body, { status: status || 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  }

  var announced = false;
  function announce(how) {
    if (announced) return; announced = true;
    try { g.console.info('[cf-page] ' + (CFG.page || 'page') + ' is using the NEW backend (Cloudflare) via ' + how + '. Turn off with ?backend=sb'); } catch (e) {}
  }

  /* ---- 1. supabase-js pages: createClient -> cf client ---- */
  (function () {
    var lib = g.supabase;
    var origCreate = lib && lib.createClient;
    var wrapped = {};
    if (lib) { for (var k in lib) { try { wrapped[k] = lib[k]; } catch (e) {} } }
    wrapped.createClient = function (url) {
      if (isSupabaseUrl(url)) { announce('supabase.createClient'); return client; }
      return origCreate ? origCreate.apply(lib, arguments) : client;
    };
    try { g.supabase = wrapped; } catch (e) {}
  })();

  /* ---- 2. direct REST pages: fetch() to Supabase -> new API ---- */
  if (realFetch) {
    g.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && typeof input.href === 'string' ? input.href : null);
      if (url == null && input && typeof input.url === 'string' && isSupabaseUrl(input.url)) {
        return json400('CF_UNSUPPORTED', 'cf-page: fetch(Request) to Supabase is not supported on the new backend yet');
      }
      if (url != null && isSupabaseUrl(url)) {
        var path = '';
        try { path = new URL(url).pathname; } catch (e) {}
        if (path.indexOf('/functions/v1/') !== 0) {
          announce('fetch adapter');
          if (!client.auth.token()) return json400('401', 'Not signed in (new backend). Log in on the Hub first, or use ?backend=sb', 401);
          var p = g.GPCF.handleSupabaseFetch(client, url, init);
          if (p) return p;
        }
      } else if (init && typeof init.body === 'string' && g.GPCF.storageUrlsToSigned && init.body.indexOf('/storage/v1/object/public/') >= 0) {
        // e.g. Apps Script PDF payloads with photo links the page built for the OLD storage: send the signed
        // links of the files this page just uploaded to the new storage instead (fetchable for 7 days)
        var nb = g.GPCF.storageUrlsToSigned(client, init.body);
        if (nb !== init.body) { var ni = {}; for (var k in init) ni[k] = init[k]; ni.body = nb; return realFetch(input, ni); }
      }
      return realFetch(input, init);
    };
  }

  /* ---- 3. status UI ---- */
  function backUrl() {
    try { var u = new URL(g.location.href); u.searchParams.set('backend', 'sb'); return u.href; } catch (e) { return '?backend=sb'; }
  }
  function el(html) { var d = g.document.createElement('div'); d.innerHTML = html; return d.firstChild; }
  var bar = null, pill = null, block = null;
  function clear() { [bar, pill, block].forEach(function (x) { if (x && x.parentNode) x.parentNode.removeChild(x); }); bar = pill = block = null; }
  var FONT = 'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif';
  function render() {
    var d = g.document; if (!d || !d.body) return;
    clear();
    var signedIn = !!client.auth.token();
    if (signedIn) {
      pill = el('<div id="gpcf-pill" style="position:fixed;left:8px;bottom:8px;z-index:2147483000;' + FONT + ';font-size:11px;background:#1d4ed8;color:#fff;border-radius:999px;padding:4px 10px;opacity:.9;box-shadow:0 1px 4px rgba(0,0,0,.3)">NEW SYSTEM · <a href="' + backUrl() + '" style="color:#fff;text-decoration:underline">switch back</a></div>');
      d.body.appendChild(pill);
    } else if (CFG.public) {
      block = el('<div id="gpcf-block" role="alertdialog" style="position:fixed;inset:0;z-index:2147483000;background:rgba(10,10,10,.94);color:#fff;display:flex;align-items:center;justify-content:center;padding:24px;' + FONT + '">' +
        '<div style="max-width:420px;text-align:center"><div style="font-size:18px;font-weight:800;margin-bottom:10px">This page is not on the new system yet</div>' +
        '<div style="font-weight:400;opacity:.85;margin-bottom:18px">This phone is switched to the new (test) system, which cannot open this link without a login yet. Open it on the current system instead.</div>' +
        '<a href="' + backUrl() + '" style="display:inline-block;background:#d8bd78;color:#111;border-radius:10px;padding:12px 18px;text-decoration:none;font-weight:800">Open on current system (?backend=sb)</a></div></div>');
      d.body.appendChild(block);
    } else {
      bar = el('<div id="gpcf-bar" role="status" style="position:fixed;left:0;right:0;top:0;z-index:2147483000;background:#b45309;color:#fff;padding:8px 12px;text-align:center;' + FONT + '">' +
        'New system: not signed in. Log in on the Hub first, or <a href="' + backUrl() + '" style="color:#fff;text-decoration:underline">use the current system (?backend=sb)</a></div>');
      d.body.appendChild(bar);
    }
  }
  function onReady(fn) {
    if (g.document.readyState === 'loading') g.document.addEventListener('DOMContentLoaded', fn); else fn();
  }
  onReady(render);
  // re-render when this page (or another tab) signs in/out on the new system
  try { g.addEventListener('storage', function (e) { if (e.key === 'gp_ba_token') render(); }); } catch (e) {}
  var lastTok = client.auth.token();
  setInterval(function () { var t = client.auth.token(); if (t !== lastTok) { lastTok = t; render(); } }, 1500);

  g.GPCF_PAGE = { client: client, cfg: CFG, isSupabaseUrl: isSupabaseUrl, render: render };
})(window);
