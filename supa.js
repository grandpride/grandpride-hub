/* ============================================================
   GRANDPRIDE & GRANDLAB — SHARED SUPABASE HELPER  (supa.js)
   Loaded by both the Hub and the Stock app.
   Provides a tiny wrapper so both apps talk to the same database.
   Google Sheets sync stays as-is; this ADDS live cloud sync.
   ============================================================ */

var SUPABASE_URL = "https://iefevjkeckysdluzazeq.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImllZmV2amtlY2t5c2RsdXphemVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwODI1MTMsImV4cCI6MjA5NjY1ODUxM30.xVqifxHta7rPtxf0hh1C4_rexhwWQhaiOxEzVr_oM5k";

/* Capture invite/recovery type from the URL hash IMMEDIATELY, before the
   supabase-js client loads and scrubs the hash. The link looks like:
   .../#access_token=...&type=invite   (or type=recovery) */
var _capturedInviteType = (function(){
  try{
    var h = window.location.hash || '';
    var q = window.location.search || '';
    var m = h.match(/[#&]type=([a-zA-Z_]+)/) || q.match(/[?&]type=([a-zA-Z_]+)/);
    var hasToken = /access_token=/.test(h) || /access_token=/.test(q) || /code=/.test(q);
    if(m && hasToken && (m[1]==='invite' || m[1]==='recovery' || m[1]==='signup')) return m[1];
  }catch(e){}
  return null;
})();

var SUPA = (function(){
  var client = null;
  var ready = false;

  function loadLib(){
    return new Promise(function(resolve){
      if(window.supabase && window.supabase.createClient) return resolve(true);
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      s.onload = function(){ resolve(true); };
      s.onerror = function(){ resolve(false); };
      document.head.appendChild(s);
    });
  }

  async function init(){
    if(!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
    var ok = await loadLib();
    if(!ok || !window.supabase) return false;
    try{
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      ready = true;
      return true;
    }catch(e){ ready = false; return false; }
  }

  function isReady(){ return ready && client; }

  /* ===== AUTH ===== */
  // sign in with a username (looks up email via RPC) + password
  async function signInUsername(username, password){
    if(!isReady()){ var ok = await init(); if(!ok) return { ok:false, error:'No connection' }; }
    try{
      // 1) resolve username -> email (safe RPC, callable before login)
      var er = await client.rpc('email_for_username', { p_username: username });
      if(er.error) return { ok:false, error:er.error.message };
      var email = er.data;
      if(!email) return { ok:false, error:'Unknown user or no email set' };
      // 2) real Supabase Auth sign-in
      var ar = await client.auth.signInWithPassword({ email: email, password: password });
      if(ar.error) return { ok:false, error:'Wrong username or password.' };
      return { ok:true, user: ar.data.user };
    }catch(e){ return { ok:false, error:String(e) }; }
  }

  async function signOut(){
    try{ if(client) await client.auth.signOut(); }catch(e){}
  }

  // current Auth user (null if not signed in)
  async function currentAuthUser(){
    if(!isReady()){ var ok = await init(); if(!ok) return null; }
    try{ var r = await client.auth.getUser(); return (r && r.data) ? r.data.user : null; }
    catch(e){ return null; }
  }

  // fetch this logged-in user's gp_staff profile (by auth_id)
  async function myProfile(){
    if(!isReady()) return null;
    try{
      var u = await currentAuthUser(); if(!u) return null;
      var r = await client.from('gp_staff').select('*').eq('auth_id', u.id).limit(1);
      if(r.error || !r.data || !r.data.length) return null;
      return r.data[0];
    }catch(e){ return null; }
  }

  /* ===== INVITE / PASSWORD RECOVERY =====
     When a user clicks an invite or password-recovery email link, Supabase
     puts them in a temporary session. We must force them to set a password
     BEFORE letting them into the app. */

  // 'invite' | 'recovery' | 'signup' | null  (captured before the hash was scrubbed)
  function pendingInviteType(){ return _capturedInviteType; }

  // True if the current page load came from an invite/recovery link AND a session exists
  async function hasInviteSession(){
    if(!_capturedInviteType) return false;
    if(!isReady()){ var ok = await init(); if(!ok) return false; }
    try{
      var r = await client.auth.getSession();
      return !!(r && r.data && r.data.session);
    }catch(e){ return false; }
  }

  // Set (or reset) the password for the user in the current invite/recovery session
  async function setMyPassword(newPassword){
    if(!isReady()){ var ok = await init(); if(!ok) return { ok:false, error:'No connection' }; }
    try{
      var r = await client.auth.updateUser({ password: newPassword });
      if(r.error) return { ok:false, error:r.error.message };
      return { ok:true, user: r.data ? r.data.user : null };
    }catch(e){ return { ok:false, error:String(e) }; }
  }

  // Clear the invite type + scrub any leftover auth hash from the URL
  function clearAuthHash(){
    _capturedInviteType = null;
    try{
      var clean = window.location.pathname + (window.location.search.replace(/[?&](access_token|refresh_token|type|expires_in|token_type|code)=[^&]*/g,'').replace(/^&/,'?') || '');
      window.history.replaceState({}, document.title, window.location.pathname);
    }catch(e){}
  }

  // upsert one or many rows into a table
  async function up(table, rows, onConflict){
    if(!isReady()) return { ok:false, offline:true };
    try{
      var q = client.from(table).upsert(rows, onConflict?{ onConflict:onConflict }:undefined);
      var r = await q;
      if(r.error){ console.warn('supa up '+table, r.error.message); return { ok:false, error:r.error.message }; }
      return { ok:true };
    }catch(e){ return { ok:false, error:String(e) }; }
  }

  // select all rows (optionally filtered)
  async function all(table, match){
    if(!isReady()) return { ok:false, offline:true, data:[] };
    try{
      var q = client.from(table).select('*');
      if(match){ Object.keys(match).forEach(function(k){ q = q.eq(k, match[k]); }); }
      var r = await q;
      if(r.error){ console.warn('supa all '+table, r.error.message); return { ok:false, error:r.error.message, data:[] }; }
      return { ok:true, data:r.data||[] };
    }catch(e){ return { ok:false, error:String(e), data:[] }; }
  }

  // delete by match
  async function del(table, match){
    if(!isReady()) return { ok:false, offline:true };
    try{
      var q = client.from(table).delete();
      Object.keys(match).forEach(function(k){ q = q.eq(k, match[k]); });
      var r = await q;
      if(r.error){ return { ok:false, error:r.error.message }; }
      return { ok:true };
    }catch(e){ return { ok:false, error:String(e) }; }
  }

  return { init:init, isReady:isReady, up:up, all:all, del:del, client:function(){return client;},
           signInUsername:signInUsername, signOut:signOut, currentAuthUser:currentAuthUser, myProfile:myProfile,
           pendingInviteType:pendingInviteType, hasInviteSession:hasInviteSession, setMyPassword:setMyPassword, clearAuthHash:clearAuthHash };
})();
