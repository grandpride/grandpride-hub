// Run: node --test tests/cf-golive.test.mjs        (no packages needed)
// Go-live additions: central default switch (gp-backend-config.js), no-login customer / driver routes
// (gl-platform docs/step6/gaps.md), invite / push / sign-up routes (docs/step5/jobs.md).
// fetch is mocked; nothing goes on the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* ---------- fake browser bits ---------- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const realWarn = console.warn;
console.warn = () => {};

const require = createRequire(import.meta.url);
const GPCF = require('../cf-client.js');

const API = 'https://api.test';
const SB = 'https://gpdb.grandlab.com.my';
const SIGNED = API + '/gp/files/gp/storage/checkins/qc1/x.jpg?exp=1&sig=a';
let calls = [];
let replies = [];
function reply(json, status = 200, headers = {}) { replies.push({ status, json, headers }); }
function mockFetch(url, init) {
  let body;
  if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } } else body = init.body;
  calls.push({ url, init, body });
  const r = replies.shift() || { status: 200, json: { data: null, error: null }, headers: {} };
  const h = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.status === 200 ? 'OK' : 'ERR',
    headers: { get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) },
    json: () => (r.json === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(r.json)),
  });
}
function fresh() {
  calls = []; replies = []; store.clear();
  return GPCF.createClient({ apiBase: API, tenant: 'gp', fetch: mockFetch, sessionCacheMs: 0 });
}

/* =================== gp-backend-config.js (go-live switch) =================== */
const CONFIG_SRC = readFileSync(new URL('../gp-backend-config.js', import.meta.url), 'utf8');
function loadConfig(search, def) {
  const win = { location: { search }, localStorage: globalThis.localStorage };
  const src = def ? CONFIG_SRC.replace(/^window\.GP_BACKEND_DEFAULT = "(sb|cf)";/m, 'window.GP_BACKEND_DEFAULT = "' + def + '";') : CONFIG_SRC;
  vm.runInNewContext(src, { window: win });
  return win;
}
test('config: the file is LIVE: GP_BACKEND_DEFAULT = "cf" (since 21 Nov 2026)', () => {
  assert.match(CONFIG_SRC, /^window\.GP_BACKEND_DEFAULT = "cf";/m);
  store.clear();
  const w = loadConfig('', null);
  assert.equal(w.GP_BACKEND_DEFAULT, 'cf');
  assert.equal(w.GP_BACKEND_PICK(), 'cf');
  assert.equal(w.GP_BACKEND_SOURCE(), 'default');
  assert.equal(store.has('gp_backend'), false);
});
test('config default "sb": ?backend=cf on (remembered), ?backend=sb clears it (same as before go-live code)', () => {
  store.clear();
  assert.equal(loadConfig('?backend=cf', 'sb').GP_BACKEND_PICK(), 'cf');
  assert.equal(store.get('gp_backend'), 'cf');
  const w = loadConfig('', 'sb');
  assert.equal(w.GP_BACKEND_PICK(), 'cf');
  assert.equal(w.GP_BACKEND_SOURCE(), 'device');
  assert.equal(loadConfig('?a=1&backend=sb', 'sb').GP_BACKEND_PICK(), 'sb');
  assert.equal(store.has('gp_backend'), false);
  assert.equal(loadConfig('?backend=cfx', 'sb').GP_BACKEND_PICK(), 'sb');
});
test('config default "cf": everyone on cf without ?backend=cf; ?backend=sb wins per device (emergency); ?backend=auto forgets', () => {
  store.clear();
  let w = loadConfig('', 'cf');
  assert.equal(w.GP_BACKEND_PICK(), 'cf');
  assert.equal(w.GP_BACKEND_SOURCE(), 'default');
  assert.equal(store.has('gp_backend'), false);
  w = loadConfig('?backend=sb', 'cf');
  assert.equal(w.GP_BACKEND_PICK(), 'sb');
  assert.equal(store.get('gp_backend'), 'sb');
  assert.equal(loadConfig('', 'cf').GP_BACKEND_PICK(), 'sb', 'stays on the current system on later visits');
  assert.equal(loadConfig('?backend=auto', 'cf').GP_BACKEND_PICK(), 'cf');
  assert.equal(store.has('gp_backend'), false);
  // a device that tested with ?backend=sb before go-live has nothing stored -> follows the new default
  store.clear();
  loadConfig('?backend=sb', 'sb').GP_BACKEND_PICK();
  assert.equal(loadConfig('', 'cf').GP_BACKEND_PICK(), 'cf');
});
test('cf-client enabled() follows GP_BACKEND_PICK when the config file is loaded', () => {
  store.clear();
  assert.equal(GPCF.enabled(), false);
  globalThis.GP_BACKEND_PICK = () => 'cf';
  try { assert.equal(GPCF.enabled(), true); assert.equal(GPCF.applyUrlSwitch(), true); }
  finally { delete globalThis.GP_BACKEND_PICK; }
  assert.equal(GPCF.enabled(), false);
});

/* =================== public RPCs (no login) =================== */
test('no-login RPCs go to /gp/public/rpc without Authorization; signed in -> /gp/api/rpc with Bearer', async () => {
  for (const name of ['qc_load', 'qc_save_draft', 'qc_submit', 'qc_set_pdf', 'get_checkin', 'get_damage_approval', 'submit_damage_approval', 'gp_sign_load', 'gp_sign_submit']) {
    let sb = fresh();
    reply({ data: { ok: true }, error: null });
    let r = await sb.rpc(name, { p_token: 't' });
    assert.equal(calls[0].url, API + '/gp/public/rpc/' + name);
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.deepEqual(r.data, { ok: true });
    sb = fresh();
    store.set('gp_ba_token', 'tok1');
    reply({ data: { ok: true }, error: null });
    await sb.rpc(name, { p_token: 't' });
    assert.equal(calls[0].url, API + '/gp/api/rpc/' + name);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok1');
  }
  // staff-only RPCs never go public
  const sb = fresh();
  await sb.rpc('qc_list', { p_code: '' });
  assert.equal(calls[0].url, API + '/gp/api/rpc/qc_list');
});
test('no-login RPC with a stale login: 401 on /api -> one retry on /public', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'old');
  reply({ error: 'unauthenticated' }, 401);
  reply({ data: { ok: true, stage: 'out' }, error: null });
  const r = await sb.rpc('qc_load', { p_token: 'abc' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, API + '/gp/api/rpc/qc_load');
  assert.equal(calls[1].url, API + '/gp/public/rpc/qc_load');
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.deepEqual(calls[1].body, { p_token: 'abc' });
  assert.deepEqual(r.data, { ok: true, stage: 'out' });
  assert.equal(store.has('gp_ba_token'), false);
});
test('public RPC rate limit 429 -> error (page shows its own "could not" message)', async () => {
  const sb = fresh();
  reply({ data: null, error: { code: '429', message: 'Too many requests, try again in a minute' } }, 429);
  const r = await sb.rpc('get_checkin', { p_token: 'ci_x' });
  assert.equal(r.data, null);
  assert.match(r.error.message, /Too many requests/);
});

/* =================== gp-checkin-view / gp-damage (direct REST rpc, page code unchanged) =================== */
const H = () => ({ 'Content-Type': 'application/json', apikey: 'anon', Authorization: 'Bearer anon' });
test('gp-checkin-view: POST /rest/v1/rpc/get_checkin -> /gp/public/rpc/get_checkin; null -> body null', async () => {
  let sb = fresh();
  const row = { customer_name: 'A', media: [{ type: 'photo', url: SIGNED }], photo_count: 1, video_count: 0 };
  reply({ data: row, error: null });
  let res = await GPCF.handleSupabaseFetch(sb, SB + '/rest/v1/rpc/get_checkin', { method: 'POST', headers: H(), body: JSON.stringify({ p_token: 'ci_abc' }) });
  assert.equal(calls[0].url, API + '/gp/public/rpc/get_checkin');
  assert.deepEqual(calls[0].body, { p_token: 'ci_abc' });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), row);
  sb = fresh();
  reply({ data: null, error: null });
  res = await GPCF.handleSupabaseFetch(sb, SB + '/rest/v1/rpc/get_checkin', { method: 'POST', headers: H(), body: JSON.stringify({ p_token: 'nope' }) });
  assert.equal(await res.json(), null);
});
test('gp-damage: get_damage_approval + submit_damage_approval (ok / already_agreed) via public RPC', async () => {
  const sb = fresh();
  const id = '11111111-2222-3333-4444-555555555555';
  reply({ data: { id, customer_name: 'B', deposit_amount: 500, damages: [{ mark_no: '1', type: 'Dent', loc: 'door', note: null, price: 120 }], already_agreed: false }, error: null });
  let res = await GPCF.handleSupabaseFetch(sb, SB + '/rest/v1/rpc/get_damage_approval', { method: 'POST', headers: H(), body: JSON.stringify({ p_job_id: id }) });
  assert.equal(calls[0].url, API + '/gp/public/rpc/get_damage_approval');
  assert.deepEqual(calls[0].body, { p_job_id: id });
  assert.equal((await res.json()).damages[0].price, 120);
  reply({ data: { ok: true }, error: null });
  res = await GPCF.handleSupabaseFetch(sb, SB + '/rest/v1/rpc/submit_damage_approval', { method: 'POST', headers: H(), body: JSON.stringify({ p_job_id: id, p_signature: 'data:image/png;base64,AAAA' }) });
  assert.equal(calls[1].url, API + '/gp/public/rpc/submit_damage_approval');
  assert.deepEqual(calls[1].body, { p_job_id: id, p_signature: 'data:image/png;base64,AAAA' });
  assert.deepEqual(await res.json(), { ok: true });
  reply({ data: { ok: false, error: 'already_agreed' }, error: null });
  res = await GPCF.handleSupabaseFetch(sb, SB + '/rest/v1/rpc/submit_damage_approval', { method: 'POST', headers: H(), body: JSON.stringify({ p_job_id: id, p_signature: 'data:image/png;base64,AAAA' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, error: 'already_agreed' });
});

/* =================== gp-sign (table REST -> gp_sign_* RPCs) =================== */
test('gp-sign load: GET gp_checklists?id=eq.<id>&select=* -> gp_sign_load {p_id, p_mode}; row -> [row], null -> []', async () => {
  let sb = fresh();
  const row = { id: 'cl_abc123', customer_name: 'C', out_mileage: '1200', out_photos: [SIGNED], already_signed: false };
  reply({ data: row, error: null });
  let res = await GPCF.handlePublicFetch(sb, SB + '/rest/v1/gp_checklists?id=eq.cl_abc123&select=*', { headers: H() }, { page: 'gp-sign', mode: 'delivery' });
  assert.equal(calls[0].url, API + '/gp/public/rpc/gp_sign_load');
  assert.deepEqual(calls[0].body, { p_id: 'cl_abc123', p_mode: 'delivery' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [row]);
  sb = fresh();
  reply({ data: null, error: null });
  res = await GPCF.handlePublicFetch(sb, SB + '/rest/v1/gp_checklists?id=eq.nope1234&select=*', { headers: H() }, { page: 'gp-sign', mode: 'return' });
  assert.deepEqual(calls[0].body, { p_id: 'nope1234', p_mode: 'return' });
  assert.deepEqual(await res.json(), []);
});
test('gp-sign submit: PATCH {<pfx>_sig_customer, customer_signed_at} -> gp_sign_submit; 204 once, then 409 already_signed', async () => {
  const sb = fresh();
  const sig = 'data:image/png;base64,iVBOR';
  reply({ data: { ok: true, signed_at: '2026-11-23T01:00:00Z' }, error: null });
  let res = await GPCF.handlePublicFetch(sb, SB + '/rest/v1/gp_checklists?id=eq.cl_abc123', { method: 'PATCH', headers: Object.assign(H(), { Prefer: 'return=minimal' }), body: JSON.stringify({ customer_signed_at: 'x', out_sig_customer: sig }) }, { page: 'gp-sign', mode: 'delivery' });
  assert.equal(calls[0].url, API + '/gp/public/rpc/gp_sign_submit');
  assert.deepEqual(calls[0].body, { p_id: 'cl_abc123', p_mode: 'delivery', p_signature: sig });
  assert.equal(res.status, 204);
  assert.equal(res.ok, true);
  reply({ data: { ok: false, error: 'already_signed' }, error: null });
  res = await GPCF.handlePublicFetch(sb, SB + '/rest/v1/gp_checklists?id=eq.cl_abc123', { method: 'PATCH', headers: H(), body: JSON.stringify({ customer_signed_at: 'x', in_sig_customer: sig }) }, { page: 'gp-sign', mode: 'return' });
  assert.deepEqual(calls[1].body, { p_id: 'cl_abc123', p_mode: 'return', p_signature: sig });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'already_signed');
  reply({ data: { ok: false, error: 'not_found' }, error: null });
  res = await GPCF.handlePublicFetch(sb, SB + '/rest/v1/gp_checklists?id=eq.zz', { method: 'PATCH', headers: H(), body: JSON.stringify({ out_sig_customer: sig }) }, { page: 'gp-sign' });
  assert.equal(res.status, 404);
});
test('gp-sign with a staff login uses /gp/api/rpc; other pages / tables are not handled here (null)', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  reply({ data: null, error: null });
  await GPCF.handlePublicFetch(sb, SB + '/rest/v1/gp_checklists?id=eq.cl_1&select=*', {}, { page: 'gp-sign' });
  assert.equal(calls[0].url, API + '/gp/api/rpc/gp_sign_load');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok1');
  assert.equal(GPCF.handlePublicFetch(sb, SB + '/rest/v1/gp_checklists?id=eq.cl_1', {}, { page: 'gp-qc' }), null);
  assert.equal(GPCF.handlePublicFetch(sb, SB + '/rest/v1/rpc/qc_load', { method: 'POST', body: '{}' }, { page: 'gp-qc', qcToken: 't' }), null);
});

/* =================== gp-qc driver upload (no login) =================== */
test('gp-qc driver upload: PUT storage/v1/object/checkins/<id>/<file> -> POST /gp/public/storage/upload?t=&path=, raw body', async () => {
  const sb = fresh();
  const blob = new Blob(['jpeg'], { type: 'image/jpeg' });
  reply({ data: { path: 'qc1/out_photo_1_17.jpg', fullPath: 'checkins/qc1/out_photo_1_17.jpg', key: 'gp/storage/checkins/qc1/out_photo_1_17.jpg', signedUrl: SIGNED }, error: null });
  const res = await GPCF.handlePublicFetch(sb, SB + '/storage/v1/object/checkins/qc1/out_photo_1_17.jpg', { method: 'PUT', headers: { apikey: 'anon', Authorization: 'Bearer anon', 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': '3600' }, body: blob }, { page: 'gp-qc', qcToken: 'a'.repeat(32) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API + '/gp/public/storage/upload?t=' + 'a'.repeat(32) + '&path=qc1%2Fout_photo_1_17.jpg');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'image/jpeg' });
  assert.equal(calls[0].body, blob);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { Key: 'checkins/qc1/out_photo_1_17.jpg' });
  // the Apps Script payload gets the signed link of this upload; data to the API gets the bare key
  const pub = SB + '/storage/v1/object/public/checkins/qc1/out_photo_1_17.jpg';
  assert.deepEqual(JSON.parse(GPCF.storageUrlsToSigned(sb, JSON.stringify({ p: [pub] }))), { p: [SIGNED] });
  assert.deepEqual(JSON.parse(GPCF.storageUrlsToKeys(JSON.stringify({ url: pub }))), { url: 'gp/storage/checkins/qc1/out_photo_1_17.jpg' });
});
test('gp-qc driver upload errors keep the HTTP status (409 duplicate, 403 bad link, 429); size checked first', async () => {
  for (const [st, err] of [[409, 'Duplicate'], [403, 'Unauthorized'], [429, 'Too many requests'], [415, 'invalid_mime_type']]) {
    const sb = fresh();
    reply({ data: null, error: { message: 'x', statusCode: String(st), error: err } }, st);
    const res = await GPCF.handlePublicFetch(sb, SB + '/storage/v1/object/checkins/qc1/a.jpg', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: new Blob(['x']) }, { page: 'gp-qc', qcToken: 't' });
    assert.equal(res.status, st);
    assert.equal(res.ok, false);
    assert.equal((await res.json()).error, err);
  }
  const sb = fresh();
  const big = { size: 51 * 1048576, type: 'video/mp4' };
  const r = await sb.storage.publicUpload('t', 'qc1/v.mp4', big, {});
  assert.equal(r.error.status, 413);
  assert.equal(calls.length, 0);
});
test('gp-qc upload with a staff login stays on /gp/api/storage/upload (handlePublicFetch -> null)', () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  assert.equal(GPCF.handlePublicFetch(sb, SB + '/storage/v1/object/checkins/qc1/a.jpg', { method: 'PUT', body: new Blob(['x']) }, { page: 'gp-qc', qcToken: 't' }), null);
});

/* =================== push / invite (edge functions -> new routes) =================== */
test('push-send fetch -> POST /gp/api/push/send {title, body, target} with Bearer', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  reply({ ok: true, sent: 2, removed: 0 });
  const res = await GPCF.handleFunctionFetch(sb, SB + '/functions/v1/push-send', { method: 'POST', headers: { Authorization: 'Bearer anon', apikey: 'anon' }, body: JSON.stringify({ title: '🚗 WXX 1', body: 'Road tax due', target: 'all' }) });
  assert.equal(calls[0].url, API + '/gp/api/push/send');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok1');
  assert.deepEqual(calls[0].body, { title: '🚗 WXX 1', body: 'Road tax due', target: 'all' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  // client helper: default target "all", body ''
  reply({ ok: true });
  const r = await sb.gp.pushSend({ title: 'Hi' });
  assert.deepEqual(calls[1].body, { title: 'Hi', body: '', target: 'all' });
  assert.equal(r.ok, true);
  // staff only -> 403 error comes back as {ok:false,error}
  reply({ ok: false, error: 'Staff only' }, 403);
  const r2 = await sb.gp.pushSend({ title: 'x', target: 'ali' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'Staff only');
});
test('invite-staff: Staff Manager flat payload -> profile; employee payload passes through; errors as {ok:false,error}', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  reply({ ok: true, auth_id: 'u1', username: 'ali', user_created: true, staff_created: true, email_sent: true });
  const r = await sb.gp.inviteStaff({ email: 'ali@x.com', username: 'ali', name: 'Ali', role: 'Staff', company: 'Grandpride', title: 'Driver', birthday: null, reports_to: ['jimmy'], can_drive: true, apps: ['attendance'] });
  assert.equal(calls[0].url, API + '/gp/api/admin/invite');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok1');
  assert.deepEqual(calls[0].body, { email: 'ali@x.com', username: 'ali', name: 'Ali', role: 'Staff', profile: { company: 'Grandpride', title: 'Driver', birthday: null, reports_to: ['jimmy'], can_drive: true, apps: ['attendance'] } });
  assert.equal(r.ok, true);
  assert.equal(r.data.auth_id, 'u1');
  const emp = { email: 'b@x.com', username: 'b', name: 'B', role: 'Staff', existing: false, profile: { title: 'Ops' } };
  reply({ ok: false, error: 'Only an Admin can give a management role (Admin / HOD / Manager)' }, 403);
  const r2 = await sb.gp.inviteStaff(emp);
  assert.deepEqual(calls[1].body, emp);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Only an Admin/);
  // the same through a page's fetch to /functions/v1/invite-staff
  reply({ ok: true, auth_id: 'u2' });
  const res = await GPCF.handleFunctionFetch(sb, SB + '/functions/v1/invite-staff', { method: 'POST', body: JSON.stringify({ email: 'c@x.com', username: 'c', existing: true }) });
  assert.equal(calls[2].url, API + '/gp/api/admin/invite');
  assert.deepEqual(calls[2].body, { email: 'c@x.com', username: 'c', existing: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).auth_id, 'u2');
});
test('other edge functions are not handled (null) -> page sends them unchanged', () => {
  const sb = fresh();
  assert.equal(GPCF.handleFunctionFetch(sb, SB + '/functions/v1/job-agreement', { method: 'POST', body: '{}' }), null);
  assert.equal(GPCF.handleFunctionFetch(sb, SB + '/functions/v1/checkin-share?t=x', {}), null);
  assert.equal(calls.length, 0);
});

/* =================== employee self sign-up + approval =================== */
test('sign-up: signInWithOtp(shouldCreateUser) -> /gp/public/signup/start; verifyOtp -> /gp/auth/sign-in/email-otp (token kept)', async () => {
  const sb = fresh();
  const ev = [];
  sb.auth.onAuthStateChange((e) => ev.push(e));
  reply({ ok: true });
  const a = await sb.auth.signInWithOtp({ email: 'New@X.com', options: { shouldCreateUser: true } });
  assert.equal(a.error, null);
  assert.equal(calls[0].url, API + '/gp/public/signup/start');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(calls[0].body, { email: 'new@x.com' });
  reply({ token: 'x', user: { id: 'app-1', email: 'new@x.com', role: 'applicant' } }, 200, { 'set-auth-token': 'tokA' });
  const b = await sb.auth.verifyOtp({ email: 'new@x.com', token: '123456', type: 'email' });
  assert.equal(b.error, null);
  assert.equal(calls[1].url, API + '/gp/auth/sign-in/email-otp');
  assert.deepEqual(calls[1].body, { email: 'new@x.com', otp: '123456' });
  assert.equal(store.get('gp_ba_token'), 'tokA');
  assert.equal(b.data.user.id, 'app-1');
  assert.ok(ev.includes('SIGNED_IN'));
  // submit (password goes with the request)
  reply({ ok: true, signup: { id: 'app-1', status: 'pending', name: 'New Guy' }, password_set: true });
  const c = await sb.gp.signupSubmit({ name: 'New Guy', phone: '012', company: 'Grandpride', role_req: 'chauffeur', password: 'secret1' });
  assert.equal(calls[2].url, API + '/gp/api/signup/submit');
  assert.equal(calls[2].init.headers.Authorization, 'Bearer tokA');
  assert.deepEqual(calls[2].body, { name: 'New Guy', phone: '012', company: 'Grandpride', role_req: 'chauffeur', password: 'secret1' });
  assert.equal(c.data.signup.status, 'pending');
});
test('sign-up: staff email refused (409 already_staff) and wrong code -> errors, no token', async () => {
  let sb = fresh();
  reply({ ok: false, error: 'This email is already registered as staff. Use "First time / Forgot password" on the sign-in page.', code: 'already_staff' }, 409);
  const a = await sb.auth.signInWithOtp({ email: 'ali@x.com', options: { shouldCreateUser: true } });
  assert.equal(a.error.status, 409);
  assert.equal(a.error.code, 'already_staff');
  assert.match(a.error.message, /already registered/);
  sb = fresh();
  reply({ ok: true });
  await sb.auth.signInWithOtp({ email: 'n@x.com', options: { shouldCreateUser: true } });
  reply({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 400);
  const b = await sb.auth.verifyOtp({ email: 'n@x.com', token: '000000', type: 'email' });
  assert.equal(b.error.status, 400);
  assert.equal(store.has('gp_ba_token'), false);
});
test('approve / reject -> /gp/api/admin/signups/approve|reject', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tokM');
  reply({ ok: true, username: 'newguy', auth_id: 'app-1', login_created: false, email_sent: false });
  const a = await sb.gp.signupApprove({ id: 'app-1', username: 'newguy', title: 'Chauffeur', level: 'Staff', reports_to: ['jimmy'], join: '2026-11-23', company: 'Grandpride' });
  assert.equal(calls[0].url, API + '/gp/api/admin/signups/approve');
  assert.deepEqual(calls[0].body, { id: 'app-1', username: 'newguy', title: 'Chauffeur', level: 'Staff', reports_to: ['jimmy'], join: '2026-11-23', company: 'Grandpride' });
  assert.equal(a.ok, true);
  reply({ ok: false, error: 'No pending sign-up with that id' }, 409);
  const r = await sb.gp.signupReject({ id: 'app-2', note: 'no' });
  assert.equal(calls[1].url, API + '/gp/api/admin/signups/reject');
  assert.deepEqual(calls[1].body, { id: 'app-2', note: 'no' });
  assert.equal(r.ok, false);
  assert.match(r.error, /No pending/);
});
test('forgot password still uses the password-reset code (not the sign-up flow)', async () => {
  const sb = fresh();
  reply({ ok: true });
  await sb.auth.signInWithOtp({ email: 'n@x.com', options: { shouldCreateUser: true } });
  reply({ success: true });
  await sb.auth.signInWithOtp({ email: 'ali@x.com', options: { shouldCreateUser: false } });
  assert.equal(calls[1].url, API + '/gp/auth/email-otp/request-password-reset');
  reply({ success: true });
  await sb.auth.verifyOtp({ email: 'ali@x.com', token: '111111', type: 'email' });
  assert.equal(calls[2].url, API + '/gp/auth/email-otp/check-verification-otp');
  // staff_email_exists check before login is a public RPC
  reply({ data: true, error: null });
  const x = await sb.rpc('staff_email_exists', { p_email: 'ali@x.com' });
  assert.equal(calls[3].url, API + '/gp/public/rpc/staff_email_exists');
  assert.equal(x.data, true);
});

test.after(() => { console.warn = realWarn; });
