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
  calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
  const r = replies.shift() || { status: 200, json: { data: [], error: null, count: null }, headers: {} };
  const h = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.status === 200 ? 'OK' : 'ERR',
    headers: { get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) },
    json: () => (r.json === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(r.json)),
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
test('realtime / storage / functions stubs do not throw', async () => {
  const sb = fresh();
  const ch = sb.channel('x').on('postgres_changes', {}, () => {}).subscribe();
  assert.equal(typeof ch.unsubscribe, 'function');
  assert.equal(await sb.removeChannel(ch), 'ok');
  const up = await sb.storage.from('checkins').upload('a.jpg', {});
  assert.equal(up.error.code, 'CF_UNSUPPORTED');
  assert.equal(sb.storage.from('checkins').getPublicUrl('a.jpg').data.publicUrl, '');
  const fn = await sb.functions.invoke('invite-staff');
  assert.equal(fn.error.code, 'CF_UNSUPPORTED');
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
test('sign-up by OTP and verifyOtp(type signup) fail soft without network', async () => {
  const sb = fresh();
  const a = await sb.auth.signInWithOtp({ email: 'new@x.com', options: { shouldCreateUser: true } });
  assert.equal(a.error.code, 'CF_UNSUPPORTED');
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

test.after(() => { console.warn = realWarn; });
