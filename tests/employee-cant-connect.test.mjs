// emailIsStaff must tell apart: staff (true) / not staff (false) / can't reach server (null).
// Extracts the real function + message from employee/index.html and runs it against a stubbed client.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../employee/index.html', import.meta.url), 'utf8');
const msgSrc = /const CANT_CONNECT_MSG=[^\n]+;/.exec(html)[0];
const fnSrc = /async function emailIsStaff\(email\)\{[\s\S]*?\n\}/.exec(html)[0];

function load(sb) {
  const ctx = { sb };
  vm.createContext(ctx);
  vm.runInContext(msgSrc + '\n' + fnSrc + '\nthis.emailIsStaff=emailIsStaff; this.MSG=CANT_CONNECT_MSG;', ctx);
  return ctx;
}
const cf = (fn) => ({ _cf: true, rpc: fn });
const sbq = (fn) => ({ from: () => ({ select: () => ({ ilike: () => ({ limit: fn }) }) }) });

test('message text', () => {
  assert.equal(load(null).MSG, "Can't connect to the server. Check your internet and try again.");
});
test('cf: {data:true} -> true', async () => assert.equal(await load(cf(async () => ({ data: true, error: null }))).emailIsStaff('a@b.c'), true));
test('cf: {data:false} -> false', async () => assert.equal(await load(cf(async () => ({ data: false, error: null }))).emailIsStaff('a@b.c'), false));
test('cf: thrown network error -> null', async () => assert.equal(await load(cf(async () => { throw new TypeError('Failed to fetch'); })).emailIsStaff('a@b.c'), null));
test('cf: {error:{...}} (5xx / 429 / blocked) -> null', async () => {
  assert.equal(await load(cf(async () => ({ data: null, error: { code: '429', message: 'Too many' } }))).emailIsStaff('a@b.c'), null);
  assert.equal(await load(cf(async () => ({ data: null, error: { code: '503', message: 'x' } }))).emailIsStaff('a@b.c'), null);
});
test('cf: non-JSON reply (data null, no error) -> null, not "not staff"', async () => assert.equal(await load(cf(async () => ({ data: null, error: null }))).emailIsStaff('a@b.c'), null));
test('cf: undefined reply -> null', async () => assert.equal(await load(cf(async () => undefined)).emailIsStaff('a@b.c'), null));
test('supabase path: row -> true, empty -> false, error/throw -> null', async () => {
  assert.equal(await load(sbq(async () => ({ data: [{ username: 'x' }], error: null }))).emailIsStaff('a@b.c'), true);
  assert.equal(await load(sbq(async () => ({ data: [], error: null }))).emailIsStaff('a@b.c'), false);
  assert.equal(await load(sbq(async () => ({ data: null, error: { message: 'boom' } }))).emailIsStaff('a@b.c'), null);
  assert.equal(await load(sbq(async () => { throw new Error('net'); })).emailIsStaff('a@b.c'), null);
});
test('callers handle null before the not-staff / already-staff branches', () => {
  assert.ok(/isStaffFg===null\)\{[^}]*CANT_CONNECT_MSG/.test(html));
  assert.ok(/isStaffSu===null\)\{[^}]*CANT_CONNECT_MSG/.test(html));
  assert.ok(html.includes("Not registered as staff yet. New here? Use \"Sign up\"."));
});
test('APP_BUILD matches service worker cache name', () => {
  const b = /const APP_BUILD = (\d+);/.exec(html)[1];
  const sw = fs.readFileSync(new URL('../employee/sw.js', import.meta.url), 'utf8');
  assert.ok(sw.includes("'gp-employee-v" + b + "'"));
});
