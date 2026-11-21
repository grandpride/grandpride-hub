/* ============================================================
   cf-page.js — new-backend glue for Hub pages that do NOT use supa.js
   (gp-fleet, gp-jobs, gp-chauffeur, gp-chauffeur-hod, gp-marketing, gp-minigames,
    gp-agreement, gp-checklist, gp-qc, gp-sign).

   LOADED ONLY WHEN THE SWITCH IS ON (gp-backend-config.js: device choice ?backend=cf, or
   GP_BACKEND_DEFAULT = "cf" after go-live), by the small guard <script> in each page, right after
   cf-client.js. Switch off = this file is never downloaded.

   What it does (switch on only):
   1. supabase.createClient(<Supabase URL>, ...) returns the cf-client instead (pages keep their sb.* code).
   2. fetch() to the Supabase server (/rest/v1, /rest/v1/rpc, /storage/v1/object) is answered by
      GPCF.handleSupabaseFetch -> the new API. /functions/v1/* still goes to Supabase unchanged.
      Photo links the page builds for the OLD storage (…/storage/v1/object/public/<bucket>/<path>) become the
      bare key gp/storage/<bucket>/<path> in data sent to the new API (server signs keys on read), and the
      signed URL of this page's upload in any other request body (Apps Script PDF).
      /functions/v1/push-send and /functions/v1/invite-staff go to the new server routes; other functions unchanged.
      No-login pages (window.GPCF_PAGE_CFG.public: gp-sign, gp-qc driver link, gp-damage, gp-checkin-view) use the
      server's public routes when not signed in (GPCF.handlePublicFetch + public RPCs).
   3. Shows who is on what: a small "NEW SYSTEM" tag (only on a device switched by hand, ?backend=cf);
      a bar on staff pages when not signed in on the new system. Customers on public pages see nothing extra.
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
        if (path.indexOf('/functions/v1/') === 0) {
          // push-send / invite-staff -> new server routes; any other edge function still goes to Supabase
          var fp = g.GPCF.handleFunctionFetch ? g.GPCF.handleFunctionFetch(client, url, init) : null;
          if (fp) { announce('fetch adapter'); return fp; }
        } else {
          announce('fetch adapter');
          if (CFG.public && g.GPCF.handlePublicFetch) {
            var pp = g.GPCF.handlePublicFetch(client, url, init, publicCtx());
            if (pp) return pp;
          }
          if (!client.auth.token() && !CFG.public) return json400('401', 'Not signed in (new backend). Log in on the Hub first, or use ?backend=sb', 401);
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

  function qp(k) { try { return new URL(g.location.href).searchParams.get(k) || ''; } catch (e) { return ''; } }
  function publicCtx() { return { page: CFG.page || '', mode: qp('mode') || 'delivery', qcToken: CFG.page === 'gp-qc' ? qp('t') : '' }; }
  // "device" = switched by hand on this phone (?backend=cf); "default" = everyone after go-live (GP_BACKEND_DEFAULT)
  function source() { try { return typeof g.GP_BACKEND_SOURCE === 'function' ? g.GP_BACKEND_SOURCE() : 'device'; } catch (e) { return 'device'; } }

  /* ---- 3. status UI ---- */
  function backUrl() {
    try { var u = new URL(g.location.href); u.searchParams.set('backend', 'sb'); return u.href; } catch (e) { return '?backend=sb'; }
  }
  function hubUrl() { try { return new URL('index.html', g.location.href).href; } catch (e) { return 'index.html'; } }
  function el(html) { var d = g.document.createElement('div'); d.innerHTML = html; return d.firstChild; }
  var bar = null, pill = null, block = null;
  function clear() { [bar, pill, block].forEach(function (x) { if (x && x.parentNode) x.parentNode.removeChild(x); }); bar = pill = block = null; }
  var FONT = 'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif';
  function render() {
    var d = g.document; if (!d || !d.body) return;
    clear();
    var signedIn = !!client.auth.token();
    var byHand = source() !== 'default';
    if (CFG.public && !signedIn) return;          // customer / driver link: nothing extra on screen
    if (signedIn) {
      if (!byHand) return;                        // after go-live everyone is on it: no tag
      pill = el('<div id="gpcf-pill" style="position:fixed;left:8px;bottom:8px;z-index:2147483000;' + FONT + ';font-size:11px;background:#1d4ed8;color:#fff;border-radius:999px;padding:4px 10px;opacity:.9;box-shadow:0 1px 4px rgba(0,0,0,.3)">NEW SYSTEM · <a href="' + backUrl() + '" style="color:#fff;text-decoration:underline">switch back</a></div>');
      d.body.appendChild(pill);
    } else {
      bar = el('<div id="gpcf-bar" role="status" style="position:fixed;left:0;right:0;top:0;z-index:2147483000;background:#b45309;color:#fff;padding:8px 12px;text-align:center;' + FONT + '">' +
        (byHand ? 'New system: not signed in. Log in on the Hub first, or <a href="' + backUrl() + '" style="color:#fff;text-decoration:underline">use the current system (?backend=sb)</a>'
                : 'Not signed in. Please <a href="' + hubUrl() + '" style="color:#fff;text-decoration:underline">log in on the Hub</a> first, then open this page again.') + '</div>');
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

  /* ---- 4. photos / videos the page shows with links it built for the OLD storage ----
     gp-qc / gp-checklist show what they just uploaded as <img|video src=".../storage/v1/object/public/<bucket>/<path>">.
     Those files are in the new storage now: swap in the signed link of this page's upload (or ask /sign when signed in). */
  var PUB = SB_ORIGIN + '/storage/v1/object/public/';
  var asking = {};
  function fixMedia(node) {
    if (!node || node.nodeType !== 1) return;
    var list = [node];
    if (node.querySelectorAll) { var q = node.querySelectorAll('img[src],video[src],source[src],a[href]'); for (var i = 0; i < q.length; i++) list.push(q[i]); }
    list.forEach(function (el) {
      var attr = el.tagName === 'A' ? 'href' : 'src';
      var v = el.getAttribute && el.getAttribute(attr);
      if (!v || v.indexOf(PUB) !== 0) return;
      var nv = g.GPCF.storageUrlsToSigned(client, v);
      if (nv !== v) { el.setAttribute(attr, nv); return; }
      var m = /^([^/]+)\/([^?#]+)/.exec(v.slice(PUB.length));
      if (!m || !client.auth.token() || asking[v]) return;
      asking[v] = true;
      var path = m[2].split('/').map(function (x) { try { return decodeURIComponent(x); } catch (e) { return x; } }).join('/');
      client.storage.from(m[1]).createSignedUrl(path, 7 * 24 * 3600).then(function (r) {
        if (r && r.data && r.data.signedUrl && el.getAttribute(attr) === v) el.setAttribute(attr, r.data.signedUrl);
      });
    });
  }
  try {
    var mo = new g.MutationObserver(function (recs) {
      recs.forEach(function (r) {
        if (r.type === 'attributes') fixMedia(r.target);
        else for (var i = 0; i < r.addedNodes.length; i++) fixMedia(r.addedNodes[i]);
      });
    });
    onReady(function () {
      mo.observe(g.document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
      fixMedia(g.document.body);
    });
  } catch (e) {}

  /* ---- 5. customer check-in share link (gp-jobs, gp-checklist) ----
     The Supabase edge function checkin-share cannot see check-ins saved in the new database. Until its Worker
     replacement exists, send the customer straight to the Hub's gp-checkin-view.html (same photos and details,
     but no WhatsApp photo preview). When the Worker route is live, set CHECKIN_SHARE_BASE to it, e.g.
     'https://gl-api.jimmykuek94.workers.dev/gp/public/checkin-share?t=' (one line). */
  var CHECKIN_SHARE_BASE = '';
  function checkinShareLink(token) {
    if (CHECKIN_SHARE_BASE) return CHECKIN_SHARE_BASE + encodeURIComponent(token);
    try { return new URL('gp-checkin-view.html?t=' + encodeURIComponent(token), g.location.href).href; } catch (e) { return 'gp-checkin-view.html?t=' + encodeURIComponent(token); }
  }

  g.GPCF_PAGE = { client: client, cfg: CFG, isSupabaseUrl: isSupabaseUrl, render: render, checkinShareLink: checkinShareLink };
})(window);
