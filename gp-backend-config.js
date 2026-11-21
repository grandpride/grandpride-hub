/* GO-LIVE SWITCH for the new backend (Cloudflare). docs/cf-migration.md
   "sb" = everyone stays on the current system (Supabase) unless a device chose ?backend=cf
   "cf" = everyone uses the new system unless a device chose ?backend=sb (emergency fallback)
   Switch-over day: change the next line to "cf" (one-word commit). Going back: change it to "sb". */
window.GP_BACKEND_DEFAULT = "cf";   // LIVE on Cloudflare since 21 Nov 2026 night. Emergency: change back to "sb".

/* ---- do not change below (shared by every Hub page, supa.js and the Employee app) ----
   GP_BACKEND_PICK() -> "cf" | "sb" for this page load:
     ?backend=cf    this device: new system (remembered)
     ?backend=sb    this device: current system (remembered while the default is "cf";
                    while the default is "sb" it just clears the device choice, as before)
     ?backend=auto  this device: forget the choice, follow GP_BACKEND_DEFAULT
     otherwise      the remembered device choice (localStorage.gp_backend), else GP_BACKEND_DEFAULT
   GP_BACKEND_SOURCE() -> "device" | "default" (where the answer came from) */
(function (g) {
  var KEY = 'gp_backend';
  function def() { return g.GP_BACKEND_DEFAULT === 'cf' ? 'cf' : 'sb'; }
  function get() { try { return g.localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { if (v == null) g.localStorage.removeItem(KEY); else g.localStorage.setItem(KEY, v); } catch (e) {} }
  function applyUrl() {
    try {
      var m = /[?&]backend=(cf|sb|auto)(?:&|$)/.exec((g.location && g.location.search) || '');
      if (!m) return;
      if (m[1] === 'cf') set('cf');
      else if (m[1] === 'sb') set(def() === 'cf' ? 'sb' : null);
      else set(null);
    } catch (e) {}
  }
  g.GP_BACKEND_PICK = function () {
    applyUrl();
    var v = get();
    if (v === 'cf' || v === 'sb') return v;
    return def();
  };
  g.GP_BACKEND_SOURCE = function () {
    var v = get();
    return (v === 'cf' || v === 'sb') ? 'device' : 'default';
  };
})(window);
