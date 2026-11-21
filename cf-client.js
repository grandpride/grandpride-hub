/* ============================================================
   cf-client.js — supabase-js-shaped client for the new backend
   (gl-api on Cloudflare Workers + D1, Better Auth login).

   OFF BY DEFAULT. Pages only use this when the switch is on:
     localStorage.gp_backend === "cf"     (?backend=cf sets it, ?backend=sb clears it)
   supa.js (and the employee app) load this file ONLY when the switch is on.

   Surface (same shape as supabase-js v2, returns {data, error} / {data, error, count}):
     client.auth   signInWithPassword, signInWithOtp, verifyOtp, updateUser({password}),
                   getSession, getUser, signOut, onAuthStateChange
     client.from(table)  select/insert/update/upsert/delete + filters  -> POST /{tenant}/api/db
     client.rpc(name, args)                                            -> POST /{tenant}/api/rpc/:name
   Not supported yet (fail soft: console.warn + {error:{code:"CF_UNSUPPORTED"}}):
     realtime channels, storage, edge functions, embedded selects, see GPCF.UNSUPPORTED.

   Plain browser JS, no build step, no CDN.
   ============================================================ */
(function (g) {
  'use strict';

  var DEFAULT_API = 'https://gl-api.jimmykuek94.workers.dev';
  var SWITCH_KEY = 'gp_backend';
  var API_KEY = 'gp_api_base';          // optional override, e.g. http://localhost:8787 for testing
  var UNSUPPORTED_CODE = 'CF_UNSUPPORTED';

  /* ---------- tiny storage helpers (never throw) ---------- */
  function lsGet(k) { try { return g.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) g.localStorage.removeItem(k); else g.localStorage.setItem(k, v); } catch (e) {} }

  /* ---------- switch ---------- */
  function applyUrlSwitch(search) {
    try {
      var s = search != null ? search : (g.location && g.location.search) || '';
      var m = /[?&]backend=(cf|sb)(?:&|$)/.exec(s);
      if (m) { if (m[1] === 'cf') lsSet(SWITCH_KEY, 'cf'); else lsSet(SWITCH_KEY, null); }
    } catch (e) {}
    return enabled();
  }
  function enabled() { return lsGet(SWITCH_KEY) === 'cf'; }

  /* ---------- fail-soft helpers ---------- */
  var warned = {};
  function warnOnce(what) {
    if (warned[what]) return;
    warned[what] = true;
    try { g.console && g.console.warn('[cf-client] not supported on the new backend yet: ' + what); } catch (e) {}
  }
  function unsupportedError(what) {
    warnOnce(what);
    return { message: 'cf-client: ' + what + ' is not supported on the new backend yet', code: UNSUPPORTED_CODE, details: null, hint: 'Switch back with ?backend=sb' };
  }

  // Features this client does not provide yet (documented in docs/cf-migration.md)
  var UNSUPPORTED = [
    'realtime: client.channel(), removeChannel(), removeAllChannels()',
    'storage: client.storage.from(bucket).upload/download/remove/list/createSignedUrl (getPublicUrl returns publicUrl "")',
    'edge functions: client.functions.invoke()',
    'client.schema() (non-public schemas)',
    'embedded selects / joins / aliases in select(): "rel(*)", "a:b", "x!inner(..)"',
    'filters: contains, containedBy, overlaps, textSearch, range*, likeAllOf/AnyOf, not() with any op except "is"',
    'more than one or() per query; or()/order()/limit() with foreignTable/referencedTable',
    'upsert({ignoreDuplicates:true}); csv(); explain(); geojson()',
    'filters/modifiers chained after rpc()',
    'auth: signUp, sign-up by OTP (signInWithOtp shouldCreateUser:true, verifyOtp type signup/invite), phone OTP, magic/invite/recovery links, resetPasswordForEmail, updateUser for anything except password, refreshSession/setSession, admin API'
  ];

  /* ---------- user / session mapping (Better Auth -> supabase-js shape) ---------- */
  function mapUser(u) {
    if (!u) return null;
    var out = {};
    for (var k in u) if (Object.prototype.hasOwnProperty.call(u, k)) out[k] = u[k];
    out.aud = 'authenticated';
    out.user_metadata = { name: u.name || null, full_name: u.name || null };
    out.app_metadata = { provider: 'email', role: u.role || null };
    out.email_confirmed_at = u.emailVerified ? (u.updatedAt || u.createdAt || null) : null;
    out.created_at = u.createdAt || null;
    out.updated_at = u.updatedAt || null;
    return out;
  }
  function mapSession(token, s, u) {
    if (!token || !u) return null;
    var exp = s && s.expiresAt ? Math.floor(Date.parse(s.expiresAt) / 1000) : null;
    return { access_token: token, token_type: 'bearer', expires_at: exp, expires_in: exp ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : null, refresh_token: null, user: mapUser(u) };
  }

  /* ============================================================
     createClient
     ============================================================ */
  function createClient(opts) {
    opts = opts || {};
    var tenant = opts.tenant || 'gp';
    var storageKey = opts.storageKey || (tenant + '_ba_token');
    function apiBase() { return String(opts.apiBase || lsGet(API_KEY) || DEFAULT_API).replace(/\/+$/, ''); }
    function doFetch(url, init) { var f = opts.fetch || g.fetch; return f.call(g, url, init); }
    function token() { return lsGet(storageKey); }
    function setToken(t) { lsSet(storageKey, t || null); }

    /* ---------- auth ---------- */
    var listeners = [];
    var subSeq = 0;
    var cache = null;           // { at, session, user }
    var CACHE_MS = opts.sessionCacheMs != null ? opts.sessionCacheMs : 60000;
    var pendingReset = null;    // { email, otp } between verifyOtp and updateUser({password})

    function emit(ev, session) {
      listeners.slice().forEach(function (l) { try { l.cb(ev, session); } catch (e) {} });
    }

    function authCall(path, method, body) {
      var headers = { 'Content-Type': 'application/json' };
      var t = token(); if (t) headers.Authorization = 'Bearer ' + t;
      var init = { method: method || 'POST', headers: headers, credentials: 'omit' };
      if (body !== undefined) init.body = JSON.stringify(body);
      return Promise.resolve().then(function () { return doFetch(apiBase() + '/' + tenant + '/auth' + path, init); }).then(function (res) {
        var nt = res.headers && res.headers.get ? res.headers.get('set-auth-token') : null;
        return res.json().catch(function () { return null; }).then(function (json) {
          if (!res.ok) {
            return { data: null, newToken: null, error: { name: 'AuthApiError', status: res.status, code: (json && json.code) || String(res.status), message: (json && (json.message || json.error)) || res.statusText || ('HTTP ' + res.status) } };
          }
          return { data: json, newToken: nt, error: null };
        });
      }, function (e) {
        return { data: null, newToken: null, error: { name: 'AuthRetryableFetchError', status: 0, code: 'network', message: 'Network error: ' + (e && e.message ? e.message : String(e)) } };
      });
    }

    function fetchSession(force) {
      var t = token();
      if (!t) { cache = null; return Promise.resolve({ session: null, user: null, error: null }); }
      if (!force && cache && (Date.now() - cache.at) < CACHE_MS) return Promise.resolve({ session: cache.session, user: cache.user, error: null });
      return authCall('/get-session', 'GET').then(function (r) {
        if (r.error && r.error.status === 401) { setToken(null); cache = null; return { session: null, user: null, error: null }; }
        if (r.error) return { session: null, user: null, error: r.error };
        if (!r.data || !r.data.user) { setToken(null); cache = null; return { session: null, user: null, error: null }; }
        var u = mapUser(r.data.user);
        var s = mapSession(t, r.data.session, r.data.user);
        cache = { at: Date.now(), session: s, user: u };
        return { session: s, user: u, error: null };
      });
    }

    function signedIn(email, password) {
      return authCall('/sign-in/email', 'POST', { email: String(email || '').trim().toLowerCase(), password: password }).then(function (r) {
        if (r.error) {
          if (r.error.status === 401 || r.error.status === 400) r.error.message = r.error.message || 'Invalid login credentials';
          return { data: { user: null, session: null }, error: r.error };
        }
        if (!r.newToken) {
          return { data: { user: null, session: null }, error: { name: 'AuthApiError', status: 0, code: 'no_token', message: 'Signed in but no token came back (set-auth-token header missing / not exposed by CORS).' } };
        }
        setToken(r.newToken);
        cache = null;
        var u = r.data && r.data.user;
        var s = mapSession(r.newToken, null, u);
        cache = u ? { at: Date.now(), session: s, user: mapUser(u) } : null;
        emit('SIGNED_IN', s);
        return { data: { user: mapUser(u), session: s }, error: null };
      });
    }

    var auth = {
      signInWithPassword: function (creds) {
        creds = creds || {};
        if (creds.phone) return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.signInWithPassword({phone})') });
        return signedIn(creds.email, creds.password);
      },

      // Email OTP is only used for "first time / forgot password" on the hub pages.
      // We ask Better Auth for a password-reset code (works for staff with or without a password).
      signInWithOtp: function (creds) {
        creds = creds || {};
        var o = creds.options || {};
        if (creds.phone) return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.signInWithOtp({phone})') });
        if (o.shouldCreateUser === true) return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('sign-up by email code (shouldCreateUser:true)') });
        var email = String(creds.email || '').trim().toLowerCase();
        pendingReset = { email: email, otp: null };
        return authCall('/email-otp/request-password-reset', 'POST', { email: email }).then(function (r) {
          return { data: { user: null, session: null }, error: r.error };
        });
      },

      // Checks the code WITHOUT using it up; updateUser({password}) then uses it to set the password.
      verifyOtp: function (p) {
        p = p || {};
        var type = p.type || 'email';
        if (p.phone || type === 'sms' || type === 'phone_change') return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.verifyOtp (phone)') });
        if (type !== 'email' && type !== 'recovery' && type !== 'magiclink') return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.verifyOtp type "' + type + '"') });
        if (p.token_hash) return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.verifyOtp({token_hash}) (email links)') });
        var email = String(p.email || '').trim().toLowerCase();
        var otp = String(p.token || '').trim();
        return authCall('/email-otp/check-verification-otp', 'POST', { email: email, type: 'forget-password', otp: otp }).then(function (r) {
          if (r.error) return { data: { user: null, session: null }, error: r.error };
          pendingReset = { email: email, otp: otp };
          emit('PASSWORD_RECOVERY', null);
          return { data: { user: null, session: null }, error: null };
        });
      },

      // {password} after verifyOtp -> /email-otp/reset-password, then signs in with the new password.
      // {password, currentPassword} while signed in -> /change-password (extension; supabase-js has no currentPassword).
      updateUser: function (attrs) {
        attrs = attrs || {};
        var keys = Object.keys(attrs).filter(function (k) { return k !== 'password' && k !== 'currentPassword' && k !== 'nonce'; });
        if (keys.length) return Promise.resolve({ data: { user: null }, error: unsupportedError('auth.updateUser(' + keys.join(',') + ')') });
        if (!attrs.password) return Promise.resolve({ data: { user: null }, error: { name: 'AuthApiError', status: 400, code: 'bad_request', message: 'Nothing to update' } });
        if (pendingReset && pendingReset.otp) {
          var pr = pendingReset;
          return authCall('/email-otp/reset-password', 'POST', { email: pr.email, otp: pr.otp, password: attrs.password }).then(function (r) {
            if (r.error) return { data: { user: null }, error: r.error };
            pendingReset = null;
            emit('USER_UPDATED', null);
            return signedIn(pr.email, attrs.password).then(function (s) {
              return { data: { user: s.data ? s.data.user : null }, error: null };
            });
          });
        }
        if (attrs.currentPassword && token()) {
          return authCall('/change-password', 'POST', { currentPassword: attrs.currentPassword, newPassword: attrs.password, revokeOtherSessions: true }).then(function (r) {
            if (r.error) return { data: { user: null }, error: r.error };
            if (r.newToken) setToken(r.newToken);
            cache = null;
            var u = r.data && r.data.user ? mapUser(r.data.user) : null;
            emit('USER_UPDATED', null);
            return { data: { user: u }, error: null };
          });
        }
        return Promise.resolve({ data: { user: null }, error: unsupportedError('auth.updateUser({password}) without an email code — use "First time / Forgot password"') });
      },

      getSession: function () {
        return fetchSession(false).then(function (r) { return { data: { session: r.session }, error: r.error }; });
      },

      getUser: function () {
        return fetchSession(true).then(function (r) {
          if (r.error) return { data: { user: null }, error: r.error };
          if (!r.user) return { data: { user: null }, error: { name: 'AuthSessionMissingError', status: 400, code: 'session_missing', message: 'Auth session missing!' } };
          return { data: { user: r.user }, error: null };
        });
      },

      signOut: function () {
        var had = !!token();
        var p = had ? authCall('/sign-out', 'POST', {}) : Promise.resolve(null);
        return p.then(function () {
          setToken(null); cache = null; pendingReset = null;
          emit('SIGNED_OUT', null);
          return { error: null };
        });
      },

      onAuthStateChange: function (cb) {
        var l = { id: 'cf-' + (++subSeq), cb: cb };
        listeners.push(l);
        setTimeout(function () {
          fetchSession(false).then(function (r) { if (listeners.indexOf(l) >= 0) { try { cb('INITIAL_SESSION', r.session); } catch (e) {} } });
        }, 0);
        var sub = { id: l.id, callback: cb, unsubscribe: function () { var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); } };
        return { data: { subscription: sub } };
      },

      // extra (not in supabase-js)
      token: token,

      // not supported yet
      signUp: function () { return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.signUp') }); },
      resetPasswordForEmail: function () { return Promise.resolve({ data: null, error: unsupportedError('auth.resetPasswordForEmail (email links)') }); },
      refreshSession: function () { return fetchSession(true).then(function (r) { return { data: { session: r.session, user: r.user }, error: r.error }; }); },
      setSession: function () { return Promise.resolve({ data: { session: null, user: null }, error: unsupportedError('auth.setSession') }); },
      exchangeCodeForSession: function () { return Promise.resolve({ data: { session: null, user: null }, error: unsupportedError('auth.exchangeCodeForSession (email links)') }); },
      startAutoRefresh: function () { return Promise.resolve(); },
      stopAutoRefresh: function () { return Promise.resolve(); }
    };

    // other tabs signing in/out on the same origin
    try {
      g.addEventListener && g.addEventListener('storage', function (e) {
        if (e.key === storageKey) { cache = null; emit(e.newValue ? 'SIGNED_IN' : 'SIGNED_OUT', null); }
      });
    } catch (e) {}

    /* ---------- data: query builder ---------- */
    function postJSON(path, body, signal) {
      var headers = { 'Content-Type': 'application/json' };
      var t = token(); if (t) headers.Authorization = 'Bearer ' + t;
      var init = { method: 'POST', headers: headers, body: JSON.stringify(body), credentials: 'omit' };
      if (signal) init.signal = signal;
      return Promise.resolve().then(function () { return doFetch(apiBase() + '/' + tenant + '/api' + path, init); }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          if (res.status === 401) {
            if (t) { setToken(null); cache = null; emit('SIGNED_OUT', null); }
            return { data: null, error: { message: 'Not signed in (new backend). Please log in again.', code: '401', details: null, hint: null }, count: null, status: 401, statusText: res.statusText || 'Unauthorized' };
          }
          if (!res.ok) {
            return { data: null, error: { message: (json && (json.message || json.error)) || res.statusText || ('HTTP ' + res.status), code: (json && json.code) || String(res.status), details: null, hint: null }, count: null, status: res.status, statusText: res.statusText || '' };
          }
          json = json || {};
          return { data: json.data === undefined ? null : json.data, error: json.error || null, count: json.count === undefined ? null : json.count, status: res.status, statusText: res.statusText || 'OK' };
        });
      }, function (e) {
        return { data: null, error: { message: 'TypeError: ' + (e && e.message ? e.message : String(e)), code: '', details: String(e), hint: null }, count: null, status: 0, statusText: '' };
      });
    }

    var SIMPLE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is'];
    var NOT_OPS = ['is'];   // contract v1: only not.is

    function cleanCols(c) {
      if (c == null) return '*';
      var quoted = false;
      return String(c).split('').filter(function (ch) {
        if (/\s/.test(ch) && !quoted) return false;
        if (ch === '"') quoted = !quoted;
        return true;
      }).join('');
    }

    function Q(table) {
      this._table = table;
      this._op = null;
      this._columns = null;
      this._filters = [];
      this._or = null;
      this._order = [];
      this._limit = null;
      this._offset = null;
      this._count = null;
      this._head = false;
      this._single = false;
      this._maybeSingle = false;
      this._values = undefined;
      this._onConflict = null;
      this._returning = false;
      this._uns = [];
      this._signal = null;
      this._throw = false;
      this._rpc = null;
      this._promise = null;
    }
    Q.prototype._bad = function (what) { this._uns.push(what); return this; };
    Q.prototype._write = function (op, values, o) {
      if (this._rpc) return this._bad(op + '() after rpc()');
      if (this._op) return this._bad(op + '() after ' + this._op + '()');
      this._op = op;
      if (values !== undefined) this._values = values;
      o = o || {};
      if (o.count) this._count = o.count;
      return this;
    };

    /* ---- operations ---- */
    Q.prototype.select = function (columns, o) {
      o = o || {};
      var cols = cleanCols(columns == null ? '*' : columns);
      if (/[()]/.test(cols) || /[^:]:[^:]/.test(cols) || cols.indexOf('!') >= 0) this._bad('embedded select / alias "' + cols + '"');
      if (this._rpc) return this._bad('select() after rpc()');
      if (!this._op) {
        this._op = 'select';
        this._columns = cols;
        if (o.count) this._count = o.count;
        if (o.head) this._head = true;
      } else {
        this._returning = true;
        this._columns = cols;
      }
      return this;
    };
    Q.prototype.insert = function (values, o) {
      return this._write('insert', values, o);
    };
    Q.prototype.upsert = function (values, o) {
      o = o || {};
      this._write('upsert', values, o);
      if (o.onConflict) this._onConflict = cleanCols(o.onConflict);
      if (o.ignoreDuplicates) this._bad('upsert({ignoreDuplicates:true})');
      return this;
    };
    Q.prototype.update = function (values, o) { return this._write('update', values, o); };
    Q.prototype['delete'] = function (o) { return this._write('delete', undefined, o); };

    /* ---- filters ---- */
    Q.prototype._f = function (col, op, val) {
      if (this._rpc) return this._bad('filter ' + op + '() after rpc()');
      if (typeof col !== 'string' || !col) return this._bad('filter with no column');
      if (op === 'in') {
        if (typeof val === 'string') val = val.replace(/^\(|\)$/g, '').split(',').map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
        val = Array.isArray(val) ? val.slice() : [val];
      }
      this._filters.push([col, op, val === undefined ? null : val]);
      return this;
    };
    SIMPLE_OPS.forEach(function (op) {
      Q.prototype[op] = function (col, val) { return this._f(col, op, val); };
    });
    Q.prototype.not = function (col, op, val) {
      if (NOT_OPS.indexOf(op) < 0) return this._bad('not(' + col + ', "' + op + '")');
      return this._f(col, 'not.' + op, val);
    };
    Q.prototype.filter = function (col, op, val) {
      op = String(op || '');
      if (op.indexOf('not.') === 0) return this.not(col, op.slice(4), val);
      if (SIMPLE_OPS.indexOf(op) < 0) return this._bad('filter(' + col + ', "' + op + '")');
      return this._f(col, op, val);
    };
    Q.prototype.match = function (obj) {
      var self = this;
      Object.keys(obj || {}).forEach(function (k) { self._f(k, 'eq', obj[k]); });
      return this;
    };
    Q.prototype.or = function (str, o) {
      o = o || {};
      if (this._rpc) return this._bad('or() after rpc()');
      if (o.foreignTable || o.referencedTable) return this._bad('or() on a foreign table');
      if (this._or != null) return this._bad('more than one or()');
      this._or = cleanCols(str);
      return this;
    };
    ['contains', 'containedBy', 'overlaps', 'textSearch', 'rangeGt', 'rangeGte', 'rangeLt', 'rangeLte', 'rangeAdjacent',
     'likeAllOf', 'likeAnyOf', 'ilikeAllOf', 'ilikeAnyOf', 'regexMatch', 'imatch', 'isDistinct'].forEach(function (m) {
      Q.prototype[m] = function () { return this._bad(m + '()'); };
    });

    /* ---- modifiers ---- */
    Q.prototype.order = function (col, o) {
      o = o || {};
      if (this._rpc) return this._bad('order() after rpc()');
      if (o.foreignTable || o.referencedTable) return this._bad('order() on a foreign table');
      var asc = o.ascending !== false;
      // Postgres default: NULLS LAST when ascending, NULLS FIRST when descending. Sent explicitly so D1 matches.
      var nf = o.nullsFirst === undefined ? !asc : !!o.nullsFirst;
      this._order.push([col, { ascending: asc, nullsFirst: nf }]);
      return this;
    };
    Q.prototype.limit = function (n, o) {
      o = o || {};
      if (this._rpc) return this._bad('limit() after rpc()');
      if (o.foreignTable || o.referencedTable) return this._bad('limit() on a foreign table');
      this._limit = n;
      return this;
    };
    Q.prototype.range = function (from, to, o) {
      o = o || {};
      if (this._rpc) return this._bad('range() after rpc()');
      if (o.foreignTable || o.referencedTable) return this._bad('range() on a foreign table');
      this._offset = from;
      this._limit = to - from + 1;
      return this;
    };
    Q.prototype.single = function () { if (this._rpc) return this._bad('single() after rpc()'); this._single = true; return this; };
    Q.prototype.maybeSingle = function () { if (this._rpc) return this._bad('maybeSingle() after rpc()'); this._maybeSingle = true; return this; };
    Q.prototype.abortSignal = function (s) { this._signal = s; return this; };
    Q.prototype.throwOnError = function () { this._throw = true; return this; };
    Q.prototype.returns = function () { return this; };
    Q.prototype.overrideTypes = function () { return this; };
    Q.prototype.setHeader = function () { return this; };
    ['csv', 'geojson', 'explain', 'rollback'].forEach(function (m) {
      Q.prototype[m] = function () { return this._bad(m + '()'); };
    });

    /* ---- the JSON sent to /api/db (exactly the compat contract) ---- */
    Q.prototype.toJSON = function () {
      var b = { table: this._table, op: this._op };
      if (this._op === 'select' || this._returning) b.columns = this._columns || '*';
      if (this._filters.length) b.filters = this._filters;
      if (this._or != null) b.or = this._or;
      if (this._order.length) b.order = this._order;
      if (this._limit != null) b.limit = this._limit;
      if (this._offset != null) b.offset = this._offset;
      if (this._count) b.count = this._count;
      if (this._head) b.head = true;
      if (this._single) b.single = true;
      if (this._maybeSingle) b.maybeSingle = true;
      if (this._values !== undefined) b.values = this._values;
      if (this._onConflict) b.onConflict = this._onConflict;
      if (this._returning) b.returning = true;
      return b;
    };

    Q.prototype._exec = function () {
      if (this._promise) return this._promise;
      var self = this;
      var p;
      if (this._uns.length) {
        var err = unsupportedError(this._uns.join('; ') + (this._rpc ? ' (rpc ' + this._rpc.name + ')' : ' (table ' + this._table + ')'));
        p = Promise.resolve({ data: null, error: err, count: null, status: 0, statusText: '' });
      } else if (this._rpc) {
        p = postJSON('/rpc/' + encodeURIComponent(this._rpc.name), this._rpc.args || {}, this._signal).then(function (r) {
          return { data: r.data, error: r.error, count: null, status: r.status, statusText: r.statusText };
        });
      } else if (!this._op) {
        p = Promise.resolve({ data: null, error: { message: 'cf-client: from(' + this._table + ') needs select/insert/update/upsert/delete', code: 'CF_BAD_QUERY', details: null, hint: null }, count: null, status: 0, statusText: '' });
      } else {
        p = postJSON('/db', this.toJSON(), this._signal);
      }
      this._promise = p.then(function (r) {
        if (self._throw && r.error) { var e = new Error(r.error.message); e.code = r.error.code; e.details = r.error.details; throw e; }
        return r;
      });
      return this._promise;
    };
    Q.prototype.then = function (a, b) { return this._exec().then(a, b); };
    Q.prototype['catch'] = function (b) { return this._exec()['catch'](b); };
    Q.prototype['finally'] = function (f) { return this._exec()['finally'](f); };

    function from(table) {
      var q = new Q(String(table));
      if (!/^[A-Za-z0-9_]+$/.test(String(table))) q._bad('table name "' + table + '"');
      return q;
    }

    function rpc(name, args, o) {
      var q = new Q(null);
      q._rpc = { name: String(name), args: args || {} };
      if (!/^[A-Za-z0-9_]+$/.test(String(name))) q._bad('rpc name "' + name + '"');
      o = o || {};
      if (o.head || o.count) q._bad('rpc() with head/count');
      return q;
    }

    /* ---------- not supported yet: realtime, storage, functions ---------- */
    function fakeChannel(name) {
      warnOnce('realtime channel()');
      var ch = {
        topic: 'realtime:' + name,
        state: 'closed',
        on: function () { return ch; },
        subscribe: function () { warnOnce('realtime channel().subscribe()'); return ch; },
        unsubscribe: function () { return Promise.resolve('ok'); },
        send: function () { return Promise.resolve('error'); },
        track: function () { return Promise.resolve('error'); },
        untrack: function () { return Promise.resolve('error'); },
        presenceState: function () { return {}; }
      };
      return ch;
    }
    function fakeBucket(bucket) {
      var no = function (what) { return function () { return Promise.resolve({ data: null, error: unsupportedError('storage.' + what + ' (bucket ' + bucket + ')') }); }; };
      return {
        upload: no('upload'), update: no('update'), download: no('download'), remove: no('remove'), list: no('list'),
        move: no('move'), copy: no('copy'), createSignedUrl: no('createSignedUrl'), createSignedUrls: no('createSignedUrls'),
        createSignedUploadUrl: no('createSignedUploadUrl'), uploadToSignedUrl: no('uploadToSignedUrl'),
        getPublicUrl: function () { warnOnce('storage.getPublicUrl (bucket ' + bucket + ')'); return { data: { publicUrl: '' } }; }
      };
    }

    var client = {
      _cf: true,
      tenant: tenant,
      auth: auth,
      from: from,
      rpc: rpc,
      schema: function (s) {
        var what = 'schema("' + s + '")';
        return { from: function (t) { return from(t)._bad(what); }, rpc: function (n, a) { return rpc(n, a)._bad(what); } };
      },
      channel: fakeChannel,
      removeChannel: function () { return Promise.resolve('ok'); },
      removeAllChannels: function () { return Promise.resolve([]); },
      getChannels: function () { return []; },
      storage: { from: fakeBucket },
      functions: { invoke: function (n) { return Promise.resolve({ data: null, error: unsupportedError('functions.invoke("' + n + '")') }); } },
      apiBase: apiBase
    };
    return client;
  }

  var GPCF = {
    version: '1.0.0',
    DEFAULT_API: DEFAULT_API,
    SWITCH_KEY: SWITCH_KEY,
    UNSUPPORTED: UNSUPPORTED,
    enabled: enabled,
    applyUrlSwitch: applyUrlSwitch,
    createClient: createClient
  };
  g.GPCF = GPCF;
  if (typeof module !== 'undefined' && module.exports) module.exports = GPCF;
})(typeof window !== 'undefined' ? window : globalThis);
