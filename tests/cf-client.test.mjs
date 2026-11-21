// Run: node --test tests/cf-client.test.mjs          (no packages needed)
// Asserts the exact JSON cf-client.js sends for every query shape the login pages and the
// Daily Task Log use today, plus Better Auth token handling. fetch is mocked; nothing goes on the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/* ---------- fake browser bits ---------- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };

const require = createRequire(import.meta.url);
const GPCF = require('../cf-client.js');

const API = 'https://api.test';
let calls = [];
let replies = [];   // queue of {status, json, headers}
function reply(json, status = 200, headers = {}) { replies.push({ status, json, headers }); }
function mockFetch(url, init) {
  let body;
  if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } } else body = init.body;
  calls.push({ url, init, body });
  const r = replies.shift() || { status: 200, json: { data: [], error: null, count: null }, headers: {} };
  const h = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.status === 200 ? 'OK' : 'ERR',
    headers: { get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) },
    json: () => (r.json === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(r.json)),
    blob: () => Promise.resolve(r.blob),
  });
}
function fresh() {
  calls = []; replies = []; warnings.length = 0; store.clear();
  return GPCF.createClient({ apiBase: API, tenant: 'gp', fetch: mockFetch, sessionCacheMs: 0 });
}
const dbBody = () => { assert.equal(calls.length, 1, 'one request'); assert.equal(calls[0].url, API + '/gp/api/db'); return calls[0].body; };

/* =================== switch =================== */
test('switch: off by default, ?backend=cf turns on, ?backend=sb turns off', () => {
  store.clear();
  assert.equal(GPCF.enabled(), false);
  assert.equal(GPCF.applyUrlSwitch('?x=1'), false);
  assert.equal(GPCF.applyUrlSwitch('?backend=cf'), true);
  assert.equal(store.get('gp_backend'), 'cf');
  assert.equal(GPCF.applyUrlSwitch('?a=1&backend=sb'), false);
  assert.equal(store.has('gp_backend'), false);
  assert.equal(GPCF.applyUrlSwitch('?backend=cfx'), false);
});

/* =================== Daily Task Log (employee/index.html: loadDayLog / dlSave / openTeamLogs) =================== */
test('daylog: today row  .select(*).eq(id).maybeSingle()', async () => {
  const sb = fresh();
  reply({ data: { id: 'jimmy|2026-11-21', data: { today: [] } }, error: null, count: null });
  const r = await sb.from('gp_emp_daylog').select('*').eq('id', 'jimmy|2026-11-21').maybeSingle();
  assert.deepEqual(dbBody(), { table: 'gp_emp_daylog', op: 'select', columns: '*', filters: [['id', 'eq', 'jimmy|2026-11-21']], maybeSingle: true });
  assert.deepEqual(r.data, { id: 'jimmy|2026-11-21', data: { today: [] } });
  assert.equal(r.error, null);
});
test('daylog: previous log  .select(date_key,data).eq.lt.order(desc).limit(1)', async () => {
  const sb = fresh();
  await sb.from('gp_emp_daylog').select('date_key,data').eq('username', 'jimmy').lt('date_key', '2026-11-21').order('date_key', { ascending: false }).limit(1);
  assert.deepEqual(dbBody(), {
    table: 'gp_emp_daylog', op: 'select', columns: 'date_key,data',
    filters: [['username', 'eq', 'jimmy'], ['date_key', 'lt', '2026-11-21']],
    order: [['date_key', { ascending: false, nullsFirst: true }]], limit: 1,
  });
});
test('daylog: save  .upsert(row,{onConflict:"id"})  (safeUpsert)', async () => {
  const sb = fresh();
  const row = { id: 'jimmy|2026-11-21', username: 'jimmy', date_key: '2026-11-21', data: { pending: [], today: ['a'], updates: [], resolved: [], improve: '', remark: '' }, planned_at: null, submitted_at: null, updated_at: '2026-11-21T01:00:00.000Z' };
  reply({ data: null, error: null, count: null });
  const r = await sb.from('gp_emp_daylog').upsert(row, { onConflict: 'id' });
  assert.deepEqual(dbBody(), { table: 'gp_emp_daylog', op: 'upsert', values: row, onConflict: 'id' });
  assert.equal(r.error, null);
});
test('daylog: team view  .select(*).eq(date_key).in(username,[..])', async () => {
  const sb = fresh();
  const us = ['iqa', 'alex'];
  await sb.from('gp_emp_daylog').select('*').eq('date_key', '2026-11-21').in('username', us);
  assert.deepEqual(dbBody(), { table: 'gp_emp_daylog', op: 'select', columns: '*', filters: [['date_key', 'eq', '2026-11-21'], ['username', 'in', ['iqa', 'alex']]] });
});
test('daylog: offline queue flush  .upsert(row,{onConflict})', async () => {
  const sb = fresh();
  await sb.from('gp_emp_daylog').upsert({ id: 'x' }, { onConflict: 'id' });
  assert.deepEqual(dbBody(), { table: 'gp_emp_daylog', op: 'upsert', values: { id: 'x' }, onConflict: 'id' });
});

/* =================== Hub login (supa.js used by index.html / set-password.html) =================== */
test('login: username -> email  rpc(email_for_username)', async () => {
  const sb = fresh();
  reply({ data: 'jimmy@x.com', error: null });
  const r = await sb.rpc('email_for_username', { p_username: 'jimmy' });
  assert.equal(calls[0].url, API + '/gp/public/rpc/email_for_username');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(calls[0].body, { p_username: 'jimmy' });
  assert.equal(r.data, 'jimmy@x.com');
});
test('login: staff email check  rpc(staff_email_exists) on public route', async () => {
  const sb = fresh();
  reply({ data: true, error: null });
  const r = await sb.rpc('staff_email_exists', { p_email: 'Ali@x.com' });
  assert.equal(calls[0].url, API + '/gp/public/rpc/staff_email_exists');
  assert.deepEqual(calls[0].body, { p_email: 'Ali@x.com' });
  assert.equal(r.data, true);
});
test('login: myProfile  .select(*).eq(auth_id).limit(1)', async () => {
  const sb = fresh();
  await sb.from('gp_staff').select('*').eq('auth_id', 'uuid-1').limit(1);
  assert.deepEqual(dbBody(), { table: 'gp_staff', op: 'select', columns: '*', filters: [['auth_id', 'eq', 'uuid-1']], limit: 1 });
});
test('login: emailExistsInStaff  .select(username).ilike(email).limit(1)', async () => {
  const sb = fresh();
  await sb.from('gp_staff').select('username').ilike('email', 'Ali@x.com').limit(1);
  assert.deepEqual(dbBody(), { table: 'gp_staff', op: 'select', columns: 'username', filters: [['email', 'ilike', 'Ali@x.com']], limit: 1 });
});
test('hub: SUPA.up  .upsert(row,{onConflict:"username"})', async () => {
  const sb = fresh();
  const row = { username: 'iqa', name: 'Iqa', apps: ['attendance'], reports_to: null, can_post_notice: true };
  await sb.from('gp_staff').upsert(row, { onConflict: 'username' });
  assert.deepEqual(dbBody(), { table: 'gp_staff', op: 'upsert', values: row, onConflict: 'username' });
});
test('hub: SUPA.up without onConflict  .upsert(rows, undefined)', async () => {
  const sb = fresh();
  await sb.from('gp_push_subs').upsert([{ a: 1 }, { a: 2 }], undefined);
  assert.deepEqual(dbBody(), { table: 'gp_push_subs', op: 'upsert', values: [{ a: 1 }, { a: 2 }] });
});
test('hub: SUPA.all  .select(*) and .select(*).eq().eq()', async () => {
  let sb = fresh();
  await sb.from('gp_staff').select('*');
  assert.deepEqual(dbBody(), { table: 'gp_staff', op: 'select', columns: '*' });
  sb = fresh();
  await sb.from('gp_stock').select('*').eq('company', 'Grandlab').eq('active', true);
  assert.deepEqual(dbBody(), { table: 'gp_stock', op: 'select', columns: '*', filters: [['company', 'eq', 'Grandlab'], ['active', 'eq', true]] });
});
test('hub: SUPA.del  .delete().eq()', async () => {
  const sb = fresh();
  await sb.from('gp_staff').delete().eq('username', 'old');
  assert.deepEqual(dbBody(), { table: 'gp_staff', op: 'delete', filters: [['username', 'eq', 'old']] });
});
test('hub: photo  .update({photo_url}).eq(auth_id)', async () => {
  const sb = fresh();
  await sb.from('gp_staff').update({ photo_url: 'https://i/x.jpg' }).eq('auth_id', 'uuid-1');
  assert.deepEqual(dbBody(), { table: 'gp_staff', op: 'update', values: { photo_url: 'https://i/x.jpg' }, filters: [['auth_id', 'eq', 'uuid-1']] });
});

/* =================== Employee app login screen =================== */
test('employee login: signup lookup  .select(*).eq(id).maybeSingle()', async () => {
  const sb = fresh();
  await sb.from('gp_emp_signups').select('*').eq('id', 'uuid-1').maybeSingle();
  assert.deepEqual(dbBody(), { table: 'gp_emp_signups', op: 'select', columns: '*', filters: [['id', 'eq', 'uuid-1']], maybeSingle: true });
});
test('employee login: link auth_id  .update({auth_id}).eq(username)', async () => {
  const sb = fresh();
  await sb.from('gp_staff').update({ auth_id: 'uuid-1' }).eq('username', 'iqa');
  assert.deepEqual(dbBody(), { table: 'gp_staff', op: 'update', values: { auth_id: 'uuid-1' }, filters: [['username', 'eq', 'iqa']] });
});
test('employee login: settings  .select(data).eq(id).maybeSingle()', async () => {
  const sb = fresh();
  await sb.from('gp_settings').select('data').eq('id', 'emp_signup_approver').maybeSingle();
  assert.deepEqual(dbBody(), { table: 'gp_settings', op: 'select', columns: 'data', filters: [['id', 'eq', 'emp_signup_approver']], maybeSingle: true });
});

/* =================== every other builder shape in the contract =================== */
test('all filter ops + or + range + count/head + single', async () => {
  const sb = fresh();
  await sb.from('t').select('id, name ,  created_at', { count: 'exact', head: true })
    .neq('x', 1).gt('a', 1).gte('b', 2).lte('c', 3).like('d', 'a%').is('deleted_at', null).not('archived_at', 'is', null)
    .or('status.eq.open, status.eq.late').range(10, 29).single();
  assert.deepEqual(dbBody(), {
    table: 't', op: 'select', columns: 'id,name,created_at',
    filters: [['x', 'neq', 1], ['a', 'gt', 1], ['b', 'gte', 2], ['c', 'lte', 3], ['d', 'like', 'a%'], ['deleted_at', 'is', null], ['archived_at', 'not.is', null]],
    or: 'status.eq.open,status.eq.late', limit: 20, offset: 10, count: 'exact', head: true, single: true,
  });
});
test('order defaults follow Postgres (asc -> nulls last), explicit nullsFirst kept', async () => {
  const sb = fresh();
  await sb.from('t').select('*').order('a').order('b', { ascending: false, nullsFirst: false });
  assert.deepEqual(dbBody().order, [['a', { ascending: true, nullsFirst: false }], ['b', { ascending: false, nullsFirst: false }]]);
});
test('match() and filter() map to the same filters', async () => {
  const sb = fresh();
  await sb.from('t').select('*').match({ a: 1, b: 'x' }).filter('c', 'in', '(1,2)').filter('d', 'not.is', null);
  assert.deepEqual(dbBody().filters, [['a', 'eq', 1], ['b', 'eq', 'x'], ['c', 'in', ['1', '2']], ['d', 'not.is', null]]);
});
test('writes with chained .select() -> returning + columns; insert array; count on delete', async () => {
  let sb = fresh();
  await sb.from('t').insert([{ a: 1 }, { a: 2 }]).select('id');
  assert.deepEqual(dbBody(), { table: 't', op: 'insert', columns: 'id', values: [{ a: 1 }, { a: 2 }], returning: true });
  sb = fresh();
  await sb.from('t').update({ a: 1 }).eq('id', 5).select().single();
  assert.deepEqual(dbBody(), { table: 't', op: 'update', columns: '*', filters: [['id', 'eq', 5]], single: true, values: { a: 1 }, returning: true });
  sb = fresh();
  await sb.from('t').delete({ count: 'exact' }).in('id', [1, 2]);
  assert.deepEqual(dbBody(), { table: 't', op: 'delete', filters: [['id', 'in', [1, 2]]], count: 'exact' });
});
test('response shape {data,error,count} passes through, incl. server error', async () => {
  const sb = fresh();
  reply({ data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' }, count: null });
  const r = await sb.from('t').select('*').eq('id', 1).single();
  assert.equal(r.data, null);
  assert.equal(r.error.code, 'PGRST116');
  const sb2 = fresh();
  reply({ data: null, error: null, count: 42 });
  const c = await sb2.from('t').select('*', { count: 'exact', head: true });
  assert.equal(c.count, 42);
});
test('builder is thenable once (no double send) and throwOnError rejects', async () => {
  const sb = fresh();
  const q = sb.from('t').select('*');
  await q; await q;
  assert.equal(calls.length, 1);
  const sb2 = fresh();
  reply({ data: null, error: { message: 'nope', code: '42501' }, count: null });
  await assert.rejects(sb2.from('t').select('*').throwOnError(), /nope/);
});

/* =================== fail soft: unsupported features never hit the network =================== */
test('embedded select, unsupported filters, multi-or, ignoreDuplicates -> CF_UNSUPPORTED, no request', async () => {
  const cases = [
    (sb) => sb.from('t').select('*, rel(*)'),
    (sb) => sb.from('t').select('name:full_name'),
    (sb) => sb.from('t').select('*').contains('tags', ['a']),
    (sb) => sb.from('t').select('*').not('a', 'eq', 1),
    (sb) => sb.from('t').select('*').or('a.eq.1').or('b.eq.2'),
    (sb) => sb.from('t').upsert({ a: 1 }, { ignoreDuplicates: true }),
    (sb) => sb.from('t').delete().textSearch('a', 'x'),       // a dropped filter on delete must never be sent
    (sb) => sb.rpc('x', {}).eq('a', 1),
    (sb) => sb.schema('private').from('t').select('*'),
  ];
  for (const make of cases) {
    const sb = fresh();
    const r = await make(sb);
    assert.equal(calls.length, 0, 'no request sent');
    assert.equal(r.data, null);
    assert.equal(r.error.code, 'CF_UNSUPPORTED');
  }
  assert.ok(warnings.length > 0, 'warned in console');
});
test('realtime / functions stubs do not throw; unsupported storage calls fail soft', async () => {
  const sb = fresh();
  const ch = sb.channel('x').on('postgres_changes', {}, () => {}).subscribe();
  assert.equal(typeof ch.unsubscribe, 'function');
  assert.equal(await sb.removeChannel(ch), 'ok');
  const fn = await sb.functions.invoke('invite-staff');
  assert.equal(fn.error.code, 'CF_UNSUPPORTED');
  for (const r of [await sb.storage.from('checkins').move('a', 'b'), await sb.storage.from('checkins').list('', { search: 'x' }),
    await sb.storage.from('checkins').createSignedUrl('a', 60, { download: true }), await sb.storage.from('bad bucket').upload('a', {})]) {
    assert.equal(r.error.code, 'CF_UNSUPPORTED');
  }
  assert.equal(calls.length, 0);
});

/* =================== auth + token handling =================== */
test('signInWithPassword stores set-auth-token; later calls send Bearer; no cookies', async () => {
  const sb = fresh();
  reply({ redirect: false, token: 'unsigned', user: { id: 'uuid-1', email: 'jimmy@x.com', name: 'Jimmy', role: 'staff', emailVerified: true } }, 200, { 'set-auth-token': 'signed.tok' });
  const events = [];
  sb.auth.onAuthStateChange((e) => events.push(e));
  const r = await sb.auth.signInWithPassword({ email: ' Jimmy@X.com ', password: 'pw123456' });
  assert.equal(calls[0].url, API + '/gp/auth/sign-in/email');
  assert.deepEqual(calls[0].body, { email: 'jimmy@x.com', password: 'pw123456' });
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(store.get('gp_ba_token'), 'signed.tok');
  assert.equal(r.error, null);
  assert.equal(r.data.user.id, 'uuid-1');
  assert.equal(r.data.session.access_token, 'signed.tok');
  assert.ok(events.includes('SIGNED_IN'));
  await sb.from('gp_staff').select('*');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer signed.tok');
});
test('signInWithPassword: wrong password -> error, no token', async () => {
  const sb = fresh();
  reply({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }, 401);
  const r = await sb.auth.signInWithPassword({ email: 'a@x.com', password: 'bad' });
  assert.equal(r.data.user, null);
  assert.equal(r.error.status, 401);
  assert.equal(store.has('gp_ba_token'), false);
});
test('getSession / getUser: no token -> no network; with token -> /get-session; 401 clears token', async () => {
  let sb = fresh();
  let s = await sb.auth.getSession();
  assert.deepEqual(s, { data: { session: null }, error: null });
  const u0 = await sb.auth.getUser();
  assert.equal(u0.data.user, null);
  assert.equal(calls.length, 0);

  sb = fresh();
  store.set('gp_ba_token', 'tok1');
  reply({ session: { expiresAt: '2030-01-01T00:00:00.000Z' }, user: { id: 'uuid-1', email: 'a@x.com', name: 'A', role: 'staff' } });
  s = await sb.auth.getSession();
  assert.equal(calls[0].url, API + '/gp/auth/get-session');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok1');
  assert.equal(s.data.session.access_token, 'tok1');
  assert.equal(s.data.session.user.id, 'uuid-1');
  reply({ session: {}, user: { id: 'uuid-1', email: 'a@x.com' } });
  const u = await sb.auth.getUser();
  assert.equal(u.data.user.email, 'a@x.com');

  reply({ message: 'unauthorized' }, 401);
  s = await sb.auth.getSession();
  assert.equal(s.data.session, null);
  assert.equal(store.has('gp_ba_token'), false);
});
test('data call 401 clears token and emits SIGNED_OUT', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'old');
  const ev = [];
  sb.auth.onAuthStateChange((e) => ev.push(e));
  reply({ error: 'unauthenticated' }, 401);
  const r = await sb.from('gp_staff').select('*');
  assert.equal(r.error.code, '401');
  assert.equal(store.has('gp_ba_token'), false);
  assert.ok(ev.includes('SIGNED_OUT'));
});
test('signOut calls /sign-out with the token, then clears it', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  reply({ success: true });
  const r = await sb.auth.signOut();
  assert.equal(r.error, null);
  assert.equal(calls[0].url, API + '/gp/auth/sign-out');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok1');
  assert.equal(store.has('gp_ba_token'), false);
});
test('first-time / forgot password: signInWithOtp -> verifyOtp -> updateUser({password}) -> signed in', async () => {
  const sb = fresh();
  reply({ success: true });
  let r = await sb.auth.signInWithOtp({ email: 'Iqa@X.com', options: { shouldCreateUser: false } });
  assert.equal(r.error, null);
  assert.equal(calls[0].url, API + '/gp/auth/email-otp/request-password-reset');
  assert.deepEqual(calls[0].body, { email: 'iqa@x.com' });

  reply({ success: true });
  r = await sb.auth.verifyOtp({ email: 'iqa@x.com', token: '123456', type: 'email' });
  assert.equal(r.error, null);
  assert.equal(calls[1].url, API + '/gp/auth/email-otp/check-verification-otp');
  assert.deepEqual(calls[1].body, { email: 'iqa@x.com', type: 'forget-password', otp: '123456' });

  reply({ success: true });
  reply({ token: 'u', user: { id: 'uuid-9', email: 'iqa@x.com' } }, 200, { 'set-auth-token': 'tok9' });
  r = await sb.auth.updateUser({ password: 'newpass1' });
  assert.equal(r.error, null);
  assert.equal(calls[2].url, API + '/gp/auth/email-otp/reset-password');
  assert.deepEqual(calls[2].body, { email: 'iqa@x.com', otp: '123456', password: 'newpass1' });
  assert.equal(calls[3].url, API + '/gp/auth/sign-in/email');
  assert.equal(store.get('gp_ba_token'), 'tok9');
  assert.equal(r.data.user.id, 'uuid-9');
});
test('wrong OTP -> error, and updateUser then refuses (no reset sent)', async () => {
  const sb = fresh();
  reply({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 400);
  const r = await sb.auth.verifyOtp({ email: 'a@x.com', token: '000000', type: 'email' });
  assert.equal(r.error.status, 400);
  const u = await sb.auth.updateUser({ password: 'x12345678' });
  assert.equal(u.error.code, 'CF_UNSUPPORTED');
  assert.equal(calls.length, 1);
});
test('verifyOtp(type signup) without a started sign-up fails soft without network (sign-up flow: tests/cf-golive.test.mjs)', async () => {
  const sb = fresh();
  const b = await sb.auth.verifyOtp({ email: 'new@x.com', token: '1', type: 'signup' });
  assert.equal(b.error.code, 'CF_UNSUPPORTED');
  assert.equal(calls.length, 0);
});
test('change password while signed in needs currentPassword (extension) -> /change-password', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  reply({ token: null, user: { id: 'uuid-1' } });
  const r = await sb.auth.updateUser({ password: 'new12345', currentPassword: 'old12345' });
  assert.equal(r.error, null);
  assert.deepEqual(calls[0].body, { currentPassword: 'old12345', newPassword: 'new12345', revokeOtherSessions: true });
});
test('network failure -> {data:null,error}, never throws', async () => {
  const sb = GPCF.createClient({ apiBase: API, fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  const r = await sb.from('t').select('*');
  assert.equal(r.data, null);
  assert.match(r.error.message, /Failed to fetch/);
  const a = await sb.auth.signInWithPassword({ email: 'a@x.com', password: 'p' });
  assert.equal(a.error.code, 'network');
});
test('default API base + localStorage override', () => {
  store.clear();
  assert.equal(GPCF.createClient().apiBase(), 'https://gl-api.jimmykuek94.workers.dev');
  store.set('gp_api_base', 'http://localhost:8787/');
  assert.equal(GPCF.createClient().apiBase(), 'http://localhost:8787');
  store.clear();
});

/* =================== storage (docs/storage-contract.md) =================== */
const SIGNED = API + '/gp/files/gp/storage/checkins/tok/photo_01.jpg?exp=1795000000&sig=abc123';
test('storage: upload without signedUrl in the answer (older server) -> falls back to /sign; getPublicUrl = signed URL', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  const blob = new Blob(['x'], { type: 'image/jpeg' });
  reply({ data: { path: 'tok/photo_01.jpg', fullPath: 'checkins/tok/photo_01.jpg' }, error: null });
  reply({ data: { signedUrl: SIGNED }, error: null });
  const up = await sb.storage.from('checkins').upload('tok/photo_01.jpg', blob, { contentType: blob.type || undefined, upsert: true });
  assert.equal(up.error, null);
  assert.deepEqual(up.data, { path: 'tok/photo_01.jpg', fullPath: 'checkins/tok/photo_01.jpg' });
  assert.equal(calls[0].url, API + '/gp/api/storage/upload');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { 'x-bucket': 'checkins', 'x-path': 'tok%2Fphoto_01.jpg', 'x-upsert': 'true', 'Content-Type': 'image/jpeg', Authorization: 'Bearer tok1' });
  assert.equal(calls[0].body, blob, 'raw bytes, not JSON');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[1].url, API + '/gp/api/storage/sign');
  assert.deepEqual(calls[1].body, { bucket: 'checkins', path: 'tok/photo_01.jpg', expiresIn: 604800 });
  assert.equal(sb.storage.from('checkins').getPublicUrl('tok/photo_01.jpg').data.publicUrl, SIGNED, 'signed URL untouched');
  assert.equal(calls.length, 2, 'getPublicUrl is sync, no request');
});
test('storage: upload (server answer has data.signedUrl) -> one request; x-path encodeURIComponent; getPublicUrl = that URL', async () => {
  const sb = fresh();
  reply({ data: { path: 'a/b.png', fullPath: 'emp-docs/a/b.png', signedUrl: SIGNED }, error: null });
  const up = await sb.storage.from('emp-docs').upload('/a//b.png/', new Blob(['x']), { contentType: 'image/png' });
  assert.equal(up.error, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['x-path'], 'a%2Fb.png', 'path cleaned like storage-js, then encodeURIComponent');
  assert.equal(calls[0].init.headers['x-upsert'], 'false');
  assert.equal(sb.storage.from('emp-docs').getPublicUrl('a/b.png').data.publicUrl, SIGNED);
});
test('storage: upload conflict / 401 -> {data:null,error} (409 statusCode kept; 401 clears token)', async () => {
  let sb = fresh();
  reply({ data: null, error: { message: 'The resource already exists', statusCode: '409', error: 'Duplicate' } }, 409);
  let r = await sb.storage.from('checkins').upload('x.jpg', new Blob(['x']));
  assert.equal(r.data, null);
  assert.equal(r.error.message, 'The resource already exists');
  assert.equal(r.error.statusCode, '409');
  assert.equal(r.error.error, 'Duplicate');
  assert.equal(r.error.status, 409);
  sb = fresh();
  reply({ data: null, error: { message: 'mime type text/html is not supported', statusCode: '415', error: 'invalid_mime_type' } }, 415);
  r = await sb.storage.from('checkins').upload('x.html', new Blob(['x'], { type: 'text/html' }));
  assert.equal(r.error.statusCode, '415');
  sb = fresh();
  store.set('gp_ba_token', 'old');
  reply({ error: 'unauthenticated' }, 401);
  r = await sb.storage.from('checkins').upload('x.jpg', new Blob(['x']));
  assert.equal(r.error.status, 401);
  assert.equal(store.has('gp_ba_token'), false);
});
test('storage: getPublicUrl before any upload -> unsigned files URL + one lazy /sign; next call is signed', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  reply({ data: { signedUrl: SIGNED }, error: null });
  const u1 = sb.storage.from('checkins').getPublicUrl('a b/x.jpg').data.publicUrl;
  assert.equal(u1, API + '/gp/files/gp/storage/checkins/a%20b/x.jpg');
  sb.storage.from('checkins').getPublicUrl('a b/x.jpg');          // no second lazy sign while one is running
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  // (only storage calls: a deferred onAuthStateChange timer from an earlier test may also fire here)
  const signs = calls.filter((c) => c.url.includes('/storage/'));
  assert.equal(signs.length, 1, JSON.stringify(signs.map((c) => [c.url, c.body])));
  assert.deepEqual(signs[0].body, { bucket: 'checkins', path: 'a b/x.jpg', expiresIn: 604800 });
  assert.equal(sb.storage.from('checkins').getPublicUrl('a b/x.jpg').data.publicUrl, SIGNED);
});
test('storage: createSignedUrl / createSignedUrls / remove / list bodies', async () => {
  const sb = fresh();
  reply({ data: { signedUrl: SIGNED }, error: null });
  let r = await sb.storage.from('emp-checks').createSignedUrl('u/1.jpg', 3600);
  assert.deepEqual(calls[0].body, { bucket: 'emp-checks', path: 'u/1.jpg', expiresIn: 3600 });
  assert.equal(r.data.signedUrl, SIGNED);
  reply({ data: [{ path: 'u/1.jpg', signedUrl: SIGNED, error: null }, { path: 'u/2.jpg', signedUrl: null, error: 'not found' }], error: null });
  r = await sb.storage.from('emp-checks').createSignedUrls(['u/1.jpg', 'u/2.jpg'], 60);
  assert.equal(r.data[1].signedUrl, null);
  assert.equal(calls[1].url, API + '/gp/api/storage/sign-many');
  assert.deepEqual(calls[1].body, { bucket: 'emp-checks', paths: ['u/1.jpg', 'u/2.jpg'], expiresIn: 60 });
  assert.equal(r.data.length, 2);
  reply({ data: [{ name: 'u/1.jpg' }], error: null });
  r = await sb.storage.from('emp-checks').remove(['u/1.jpg']);
  assert.equal(calls[2].url, API + '/gp/api/storage/remove');
  assert.deepEqual(calls[2].body, { bucket: 'emp-checks', paths: ['u/1.jpg'] });
  assert.deepEqual(r.data, [{ name: 'u/1.jpg' }]);
  reply({ data: [{ name: '1.jpg', id: 'k', metadata: { size: 1, mimetype: 'image/jpeg' }, created_at: 'x' }], error: null });
  r = await sb.storage.from('emp-checks').list('u', { limit: 10, offset: 5, sortBy: { column: 'name', order: 'asc' } });
  assert.equal(calls[3].url, API + '/gp/api/storage/list');
  assert.deepEqual(calls[3].body, { bucket: 'emp-checks', prefix: 'u', limit: 10, offset: 5 });
  assert.equal(r.data[0].name, '1.jpg');
  await sb.storage.from('emp-checks').list();
  assert.deepEqual(calls[4].body, { bucket: 'emp-checks', prefix: '', limit: 100, offset: 0 });
});
test('storage: download -> Blob; JSON error -> error', async () => {
  const sb = fresh();
  const b = new Blob(['img'], { type: 'image/jpeg' });
  replies.push({ status: 200, json: undefined, blob: b, headers: { 'content-type': 'image/jpeg' } });
  let r = await sb.storage.from('emp-docs').download('a/b.jpg');
  assert.equal(calls[0].url, API + '/gp/api/storage/download');
  assert.deepEqual(calls[0].body, { bucket: 'emp-docs', path: 'a/b.jpg' });
  assert.equal(r.data, b);
  assert.equal(r.error, null);
  reply({ data: null, error: { message: 'Object not found', statusCode: '404' } }, 404, { 'content-type': 'application/json' });
  r = await sb.storage.from('emp-docs').download('nope.jpg');
  assert.equal(r.data, null);
  assert.equal(r.error.message, 'Object not found');
});
test('signed photo URLs read from /api/db come back unchanged', async () => {
  const sb = fresh();
  const row = { id: 'c1', out_photos: [{ label: 'front', url: SIGNED }], out_sig_customer: SIGNED };
  reply({ data: [row], error: null, count: null });
  const r = await sb.from('gp_checklists').select('*').eq('id', 'c1');
  assert.deepEqual(r.data, [row]);
});

test('storage: expiresIn capped at 7 days; size limits (checkins/emp-docs 50 MB, others 10 MB) checked before sending', async () => {
  const sb = fresh();
  reply({ data: { signedUrl: SIGNED }, error: null });
  await sb.storage.from('checkins').createSignedUrl('a.jpg', 365 * 86400);
  assert.equal(calls[0].body.expiresIn, 604800);
  reply({ data: [], error: null });
  await sb.storage.from('checkins').createSignedUrls(['a.jpg'], 0);
  assert.equal(calls[1].body.expiresIn, 604800);
  const big = { size: 11 * 1048576, type: 'image/jpeg' };
  let r = await sb.storage.from('emp-checks').upload('a.jpg', big);
  assert.equal(r.error.statusCode, '413');
  assert.equal(calls.length, 2, 'not sent');
  reply({ data: { path: 'v.mp4', fullPath: 'checkins/v.mp4', signedUrl: SIGNED }, error: null });
  r = await sb.storage.from('checkins').upload('v.mp4', big);
  assert.equal(r.error, null);
  r = await sb.storage.from('checkins').upload('v2.mp4', { size: 51 * 1048576 });
  assert.equal(r.error.statusCode, '413');
  assert.equal(calls.length, 3);
});

/* =================== direct Supabase REST pages -> handleSupabaseFetch =================== */
const SB = 'https://gpdb.grandlab.com.my';
const H = (x) => Object.assign({ 'Content-Type': 'application/json', apikey: 'anon', Authorization: 'Bearer anon' }, x || {});
async function rest(url, init, replyJson, status = 200) {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  if (replyJson !== undefined) reply(replyJson, status);
  const res = await GPCF.handleSupabaseFetch(sb, url, init);
  return { res, body: calls[0] && calls[0].body, url: calls[0] && calls[0].url, init: calls[0] && calls[0].init };
}
test('REST gp-agreement: upsert (merge-duplicates, on_conflict=id) -> 201, no body', async () => {
  const row = { id: 'agr_1', data: { a: 1 } };
  const { res, body, url, init } = await rest(SB + '/rest/v1/gp_agreements?on_conflict=id', { method: 'POST', headers: H({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(row) }, { data: null, error: null });
  assert.equal(url, API + '/gp/api/db');
  assert.equal(init.headers.Authorization, 'Bearer tok1', 'cf token, not the anon key');
  assert.deepEqual(body, { table: 'gp_agreements', op: 'upsert', values: row, onConflict: 'id' });
  assert.equal(res.status, 201); assert.equal(res.ok, true);
});
test('REST gp-agreement / gp-checklist / gp-sign selects', async () => {
  const cases = [
    [SB + '/rest/v1/gp_agreements?select=*&order=created_at.desc', { table: 'gp_agreements', op: 'select', columns: '*', order: [['created_at', { ascending: false, nullsFirst: true }]] }],
    [SB + '/rest/v1/gp_agreements?id=eq.' + encodeURIComponent('agr 1&x') + '&select=*', { table: 'gp_agreements', op: 'select', columns: '*', filters: [['id', 'eq', 'agr 1&x']] }],
    [SB + '/rest/v1/gp_bookings?service=eq.leasing&select=*&order=created_at.desc', { table: 'gp_bookings', op: 'select', columns: '*', filters: [['service', 'eq', 'leasing']], order: [['created_at', { ascending: false, nullsFirst: true }]] }],
    [SB + '/rest/v1/gp_fleet?select=id,plate,model&order=plate.asc', { table: 'gp_fleet', op: 'select', columns: 'id,plate,model', order: [['plate', { ascending: true, nullsFirst: false }]] }],
    [SB + '/rest/v1/gp_app_config?select=key,value', { table: 'gp_app_config', op: 'select', columns: 'key,value' }],
    [SB + '/rest/v1/gp_checklists?status=eq.awaiting_return&select=*&order=created_at.desc', { table: 'gp_checklists', op: 'select', columns: '*', filters: [['status', 'eq', 'awaiting_return']], order: [['created_at', { ascending: false, nullsFirst: true }]] }],
    [SB + '/rest/v1/gp_agreements?type=eq.lease&select=*&order=created_at.desc', { table: 'gp_agreements', op: 'select', columns: '*', filters: [['type', 'eq', 'lease']], order: [['created_at', { ascending: false, nullsFirst: true }]] }],
    [SB + '/rest/v1/gp_checklists?car_plate=eq.WXY%201234&select=*&order=created_at.desc', { table: 'gp_checklists', op: 'select', columns: '*', filters: [['car_plate', 'eq', 'WXY 1234']], order: [['created_at', { ascending: false, nullsFirst: true }]] }],
    [SB + '/rest/v1/gp_checklists?job_id=eq.j1&select=*&order=created_at.desc&limit=1', { table: 'gp_checklists', op: 'select', columns: '*', filters: [['job_id', 'eq', 'j1']], order: [['created_at', { ascending: false, nullsFirst: true }]], limit: 1 }],
    [SB + '/rest/v1/gp_fleet?plate=eq.ABC123&select=id', { table: 'gp_fleet', op: 'select', columns: 'id', filters: [['plate', 'eq', 'ABC123']] }],
    [SB + '/rest/v1/gp_training_scores?select=staff_name,score&game=eq.inspect&order=score.desc&limit=10', { table: 'gp_training_scores', op: 'select', columns: 'staff_name,score', filters: [['game', 'eq', 'inspect']], order: [['score', { ascending: false, nullsFirst: true }]], limit: 10 }],
    // other ops the parser covers
    [SB + '/rest/v1/t?a=in.(x,"y,z")&b=is.null&c=not.is.null&d=ilike.*oil*&e=gte.2026-11-01&f=lt.5&order=a.asc.nullsfirst,b.desc.nullslast&limit=20&offset=40',
      { table: 't', op: 'select', columns: '*', filters: [['a', 'in', ['x', 'y,z']], ['b', 'is', null], ['c', 'not.is', null], ['d', 'ilike', '%oil%'], ['e', 'gte', '2026-11-01'], ['f', 'lt', '5']],
        order: [['a', { ascending: true, nullsFirst: true }], ['b', { ascending: false, nullsFirst: false }]], limit: 20, offset: 40 }],
  ];
  for (const [u, want] of cases) {
    const rows = [{ id: 1, photo: SIGNED }];
    const { res, body } = await rest(u, { headers: H() }, { data: rows, error: null, count: null });
    assert.deepEqual(body, want, u);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), rows);
  }
});
test('REST writes: insert / insert+representation / PATCH minimal+representation / DELETE', async () => {
  let r = await rest(SB + '/rest/v1/gp_fleet', { method: 'POST', headers: H({ Prefer: 'return=representation' }), body: JSON.stringify({ plate: 'A1' }) }, { data: [{ id: 7, plate: 'A1' }], error: null });
  assert.deepEqual(r.body, { table: 'gp_fleet', op: 'insert', columns: '*', values: { plate: 'A1' }, returning: true });
  assert.equal(r.res.status, 201); assert.deepEqual(await r.res.json(), [{ id: 7, plate: 'A1' }]);
  r = await rest(SB + '/rest/v1/gp_checkins', { method: 'POST', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({ share_token: 't' }) }, { data: null, error: null });
  assert.deepEqual(r.body, { table: 'gp_checkins', op: 'insert', values: { share_token: 't' } });
  assert.equal(r.res.status, 201); assert.equal(await r.res.text(), '');
  r = await rest(SB + '/rest/v1/gp_training_scores', { method: 'POST', headers: H({ Prefer: 'return-minimal' }), body: JSON.stringify({ game: 'x', score: 3 }) }, { data: null, error: null });
  assert.deepEqual(r.body, { table: 'gp_training_scores', op: 'insert', values: { game: 'x', score: 3 } });
  r = await rest(SB + '/rest/v1/gp_fleet?id=eq.5', { method: 'PATCH', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({ status: 'rented' }) }, { data: null, error: null });
  assert.deepEqual(r.body, { table: 'gp_fleet', op: 'update', filters: [['id', 'eq', '5']], values: { status: 'rented' } });
  assert.equal(r.res.status, 204); assert.equal(r.res.ok, true);
  r = await rest(SB + '/rest/v1/gp_records?car_plate=eq.A%201&customer_name=eq.Ali%20B&start_date=eq.2026-11-01', { method: 'PATCH', headers: H({ Prefer: 'return=representation' }), body: JSON.stringify({ end_mileage: 9 }) }, { data: [{ id: 3 }], error: null });
  assert.deepEqual(r.body, { table: 'gp_records', op: 'update', columns: '*', filters: [['car_plate', 'eq', 'A 1'], ['customer_name', 'eq', 'Ali B'], ['start_date', 'eq', '2026-11-01']], values: { end_mileage: 9 }, returning: true });
  assert.equal(r.res.status, 200); assert.deepEqual(await r.res.json(), [{ id: 3 }]);
  r = await rest(SB + '/rest/v1/gp_checklists?id=eq.c1', { method: 'PATCH', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({ out_sig_customer: 'data:image/png;base64,AAA' }) }, { data: null, error: null });
  assert.deepEqual(r.body, { table: 'gp_checklists', op: 'update', filters: [['id', 'eq', 'c1']], values: { out_sig_customer: 'data:image/png;base64,AAA' } });
  r = await rest(SB + '/rest/v1/gp_agreements?id=eq.agr_1', { method: 'DELETE', headers: H({ Prefer: 'return=minimal' }) }, { data: null, error: null });
  assert.deepEqual(r.body, { table: 'gp_agreements', op: 'delete', filters: [['id', 'eq', 'agr_1']] });
  assert.equal(r.res.status, 204);
});
test('REST gp-checklist upsert keeps its AbortSignal; errors map to PostgREST-like JSON', async () => {
  const ctrl = new AbortController();
  let r = await rest(SB + '/rest/v1/gp_checklists?on_conflict=id', { method: 'POST', headers: H({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify({ id: 'c1' }), signal: ctrl.signal }, { data: null, error: null });
  assert.equal(r.init.signal, ctrl.signal);
  r = await rest(SB + '/rest/v1/gp_checklists?on_conflict=id', { method: 'POST', headers: H({ Prefer: 'resolution=merge-duplicates' }), body: JSON.stringify({ id: 'c1' }) }, { data: null, error: { message: 'column x not allowed', code: '42501' } });
  assert.equal(r.res.ok, false); assert.equal(r.res.status, 400);
  assert.deepEqual(await r.res.json(), { code: '42501', message: 'column x not allowed', details: null, hint: null });
  r = await rest(SB + '/rest/v1/gp_checklists?select=*', { headers: H() }, { error: 'unauthenticated' }, 401);
  assert.equal(r.res.status, 401);
});
test('REST gp-qc: POST /rest/v1/rpc/qc_load -> client.rpc; text() is the JSON', async () => {
  const { res, body, url } = await rest(SB + '/rest/v1/rpc/qc_load', { method: 'POST', headers: H(), body: JSON.stringify({ p_token: 'tk' }) }, { data: { id: 'c1', stage: 'out' }, error: null });
  assert.equal(url, API + '/gp/api/rpc/qc_load');
  assert.deepEqual(body, { p_token: 'tk' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await res.text()), { id: 'c1', stage: 'out' });
  const r2 = await rest(SB + '/rest/v1/rpc/qc_set_pdf', { method: 'POST', headers: H(), body: JSON.stringify({ p_token: 'tk', p_pdf: 'u' }) }, { data: null, error: { message: 'function qc_set_pdf not found', code: '42501' } });
  assert.equal(r2.res.ok, false);
  assert.match(await r2.res.text(), /qc_set_pdf/);
});
test('REST storage upload (gp-checklist / gp-qc stUpload PUT x-upsert) -> storage upload; 200 {Key}', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  const blob = new Blob(['x'], { type: 'image/jpeg' });
  reply({ data: { path: 'ci_1/delivery_01.jpg', fullPath: 'checkins/ci_1/delivery_01.jpg' }, error: null });
  reply({ data: { signedUrl: SIGNED }, error: null });
  const res = await GPCF.handleSupabaseFetch(sb, SB + '/storage/v1/object/checkins/ci_1/delivery_01.jpg', { method: 'PUT', headers: { apikey: 'anon', Authorization: 'Bearer anon', 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': '3600' }, body: blob });
  assert.equal(calls[0].url, API + '/gp/api/storage/upload');
  assert.deepEqual(calls[0].init.headers, { 'x-bucket': 'checkins', 'x-path': 'ci_1%2Fdelivery_01.jpg', 'x-upsert': 'true', 'Content-Type': 'image/jpeg', Authorization: 'Bearer tok1' });
  assert.equal(calls[0].body, blob);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { Key: 'checkins/ci_1/delivery_01.jpg' });
});
test('REST: old Supabase public storage links -> bare keys in data sent to the API; signed in other bodies', async () => {
  const sb = fresh();
  store.set('gp_ba_token', 'tok1');
  const pub = SB + '/storage/v1/object/public/checkins/ci_1/delivery_01.jpg';
  // the page uploads (gp-checklist stUpload_) ...
  reply({ data: { path: 'ci_1/delivery_01.jpg', fullPath: 'checkins/ci_1/delivery_01.jpg', signedUrl: SIGNED }, error: null });
  await GPCF.handleSupabaseFetch(sb, SB + '/storage/v1/object/checkins/ci_1/delivery_01.jpg', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }, body: new Blob(['x']) });
  // ... then saves the link it built itself
  const rec = { share_token: 'ci_1', media: [{ type: 'photo', url: pub }], preview_url: pub, note: 'photo at ' + pub };
  reply({ data: null, error: null });
  await GPCF.handleSupabaseFetch(sb, SB + '/rest/v1/gp_checkins', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rec) });
  assert.deepEqual(calls[1].body.values, { share_token: 'ci_1', media: [{ type: 'photo', url: 'gp/storage/checkins/ci_1/delivery_01.jpg' }], preview_url: 'gp/storage/checkins/ci_1/delivery_01.jpg', note: 'photo at ' + pub });
  // Apps Script payload (not our API): signed URL of the upload made in this page; unknown links stay as they are
  const other = SB + '/storage/v1/object/public/checkins/old/x.jpg';
  const out = GPCF.storageUrlsToSigned(sb, JSON.stringify({ photo_urls: [pub, other] }));
  assert.deepEqual(JSON.parse(out), { photo_urls: [SIGNED, other] });
});
test('REST: functions/v1 is left alone (null); unsupported shapes -> 400 CF_UNSUPPORTED, no request', async () => {
  let sb = fresh();
  assert.equal(GPCF.handleSupabaseFetch(sb, SB + '/functions/v1/push-send', { method: 'POST' }), null);
  const bad = [
    [SB + '/rest/v1/t?or=(a.eq.1,b.eq.2)', {}],
    [SB + '/rest/v1/t?a=not.eq.1', {}],
    [SB + '/rest/v1/t?a=cs.{x}', {}],
    [SB + '/rest/v1/t?a=is.maybe', {}],
    [SB + '/rest/v1/t?offset=10', {}],
    [SB + '/rest/v1/t?a=eq.1', { method: 'POST', body: '{}' }],
    [SB + '/rest/v1/t', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: '{}' }],
    [SB + '/rest/v1/rpc/x', { method: 'GET' }],
    [SB + '/rest/v1/t', { method: 'POST', body: new Blob(['x']) }],
    [SB + '/auth/v1/token?grant_type=password', { method: 'POST', body: '{}' }],
    [SB + '/storage/v1/object/public/checkins/a.jpg', {}],
  ];
  for (const [u, init] of bad) {
    sb = fresh();
    const res = await GPCF.handleSupabaseFetch(sb, u, init);
    assert.equal(calls.length, 0, 'no request for ' + u);
    assert.equal(res.status, 400, u);
    assert.equal((await res.json()).code, 'CF_UNSUPPORTED', u);
  }
});

test.after(() => { console.warn = realWarn; });

/* =================== functions.invoke('job-agreement') -> gl-api step 6 =================== */
test('functions.invoke(job-agreement) posts to /gp/api/fn/job-agreement with Bearer', async () => {
  const sb = fresh();
  localStorage.setItem('gp_ba_token', 'tokA');
  reply({ ok: true, pdf_url: 'https://x/y.pdf' });
  const r = await sb.functions.invoke('job-agreement', { body: { job_id: 'J1', force: false } });
  assert.equal(calls[0].url, API + '/gp/api/fn/job-agreement');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tokA');
  assert.deepEqual(calls[0].body, { job_id: 'J1', force: false });
  assert.equal(r.error, null);
  assert.equal(r.data.pdf_url, 'https://x/y.pdf');
});
test('functions.invoke(job-agreement) non-2xx -> FunctionsHttpError like supabase-js', async () => {
  const sb = fresh();
  reply({ error: 'already' }, 409);
  const r = await sb.functions.invoke('job-agreement', { body: { job_id: 'J1' } });
  assert.equal(r.data, null);
  assert.equal(r.error.name, 'FunctionsHttpError');
  assert.equal(r.error.message, 'Edge Function returned a non-2xx status code');
});
test('functions.invoke(other) stays unsupported and sends nothing', async () => {
  const sb = fresh();
  const r = await sb.functions.invoke('telegram-agreement', { body: {} });
  assert.equal(calls.length, 0);
  assert.ok(r.error);
});
