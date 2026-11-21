# Moving the Hub to the new backend (Cloudflare) — the switch

The Hub still runs on Supabase. The new backend (gl-api on Cloudflare Workers + D1, Better Auth login) is only used
on a phone or PC where **the switch is on**. With the switch off nothing changes: `cf-client.js` is not even downloaded.

## Turn it on / off

| What | How |
|---|---|
| Turn ON (this browser only) | open any Hub page with `?backend=cf`, e.g. `https://grandpride.github.io/grandpride-hub/index.html?backend=cf` |
| Turn OFF | open any Hub page with `?backend=sb` |
| Check | browser console shows `[supa] using the NEW backend (Cloudflare)`; or `localStorage.gp_backend` is `"cf"` |
| Manual | `localStorage.setItem('gp_backend','cf')` / `localStorage.removeItem('gp_backend')` |
| Test against a local Worker | `localStorage.setItem('gp_api_base','http://localhost:8787')` (remove it to go back to the default) |

- The switch is per browser (localStorage on `grandpride.github.io`). Hub pages and the Employee app share it.
- Default API: `https://gl-api.jimmykuek94.workers.dev`, tenant `gp` (`/gp/auth/*`, `/gp/api/db`, `/gp/api/rpc/:name`).
- Login token: localStorage key `gp_ba_token` (Better Auth bearer token from the `set-auth-token` header). The old
  Supabase login (`sb-…-auth-token`) is not touched, so switching back to `sb` keeps the old login.
- Everyone signs in once after switching on (sessions are not moved).

## Which pages follow the switch

| Page | Follows switch? | How |
|---|---|---|
| `index.html` (Hub) | yes | `supa.js` → `SUPA.client()` is the cf client |
| `set-password.html` | yes | `supa.js` |
| `staff-manager.html` | yes (except Invite) | `supa.js` |
| `stock-report.html` | yes | `supa.js` |
| `employee/index.html` (attendance, **Daily Task Log**, leave, …) | yes | small guarded hook in `initSupabase()` |
| `gp-agreement.html`, `gp-checklist.html`, `gp-qc.html`, `gp-sign.html` | **no** — stay on Supabase | they call Supabase REST (`/rest/v1`, `/rest/v1/rpc`) directly with `SUPABASE_URL` from `supa.js`; not through the client |
| `gp-fleet.html`, `gp-jobs.html`, `gp-chauffeur.html`, `gp-chauffeur-hod.html`, `gp-marketing.html`, `gp-minigames.html` | **no** — stay on Supabase | each creates its own supabase-js client |
| `daily-task-log.html` | n/a | has no database at all (localStorage + Google Sheet + WhatsApp). The database Daily Task Log is inside `employee/index.html` (table `gp_emp_daylog`) |

Note: on a "no" page the user is still signed in to Supabase only if they also logged in there before; with the switch on,
the Hub login no longer creates a Supabase session.

## What `cf-client.js` supports

Same calls and the same `{ data, error }` / `{ data, error, count }` results as supabase-js v2.

**Data** (`POST /gp/api/db`, JSON exactly as in gl-platform `docs/api/compat-contract.md`):
`select(cols, {count, head})`, `insert`, `update`, `upsert(values, {onConflict})`, `delete`,
`.select()` after a write (`returning: true`), `eq neq gt gte lt lte like ilike in is`, `not(col,'is',val)`,
`filter(col, op, val)` and `match({...})` for the same ops, one `or('a.eq.1,b.eq.2')`, `order` (Postgres null order
is sent explicitly: ascending → `nullsFirst:false`, descending → `nullsFirst:true`, unless the page sets it),
`limit`, `range(a,b)` → `offset=a, limit=b-a+1`, `single`, `maybeSingle`, `abortSignal`, `throwOnError`.
Only keys that are set are sent (e.g. no `filters` key when there are no filters).

**RPC**: `rpc(name, args)` → `POST /gp/api/rpc/:name` with `args` as the body.

**Login** (Better Auth endpoints under `/gp/auth`):

| Page calls (supabase-js) | cf-client does |
|---|---|
| `signInWithPassword({email,password})` | `POST /sign-in/email`, stores `set-auth-token` |
| `signInWithOtp({email, options:{shouldCreateUser:false}})` (first time / forgot password) | `POST /email-otp/request-password-reset` (sends a 6-digit code) |
| `verifyOtp({email, token, type:'email'})` | `POST /email-otp/check-verification-otp` with `type:"forget-password"` (checks the code, does not use it up) |
| `updateUser({password})` right after `verifyOtp` | `POST /email-otp/reset-password`, then signs in with the new password (so the page has a session, like Supabase) |
| `updateUser({password, currentPassword})` while signed in | `POST /change-password` (extension: Better Auth needs the current password) |
| `getSession()` / `getUser()` | `GET /get-session` (cached 60 s for getSession; getUser always asks the server) |
| `signOut()` | `POST /sign-out`, clears the token |
| `onAuthStateChange(cb)` | local events `INITIAL_SESSION`, `SIGNED_IN`, `SIGNED_OUT`, `PASSWORD_RECOVERY`, `USER_UPDATED` + other tabs |

A `401` from `/api/*` clears the token and fires `SIGNED_OUT`.

## Not supported yet (fails soft)

Unsupported calls never throw and never send a partial query (a filter is never silently dropped). They return
`{ data: null, error: { code: "CF_UNSUPPORTED", message } }` and print one `[cf-client] not supported…` warning in the console.

- Realtime: `channel()`, `removeChannel()`, `removeAllChannels()` (stubs, no events). No Hub page uses realtime today.
- Storage: `storage.from(bucket)` upload/download/remove/list/createSignedUrl… (`getPublicUrl` returns `publicUrl: ""`).
- Edge functions: `functions.invoke()`. Direct `fetch` to Supabase functions is not changed (see per page).
- Embedded selects / joins / aliases: `select('*, rel(*)')`, `'a:b'`, `'x!inner(...)'`. None found in Hub pages today.
- Filters: `contains`, `containedBy`, `overlaps`, `textSearch`, `range*`, `like/ilikeAllOf/AnyOf`, `not()` with any op except `is`.
- More than one `or()`; `or/order/limit` on a foreign table; `upsert({ignoreDuplicates:true})`; `csv()`, `explain()`.
- Filters or modifiers chained after `rpc()`; `schema('other')`.
- Auth: `signUp`, sign-up by email code (`shouldCreateUser:true`, `verifyOtp type:'signup'`), phone OTP,
  Supabase email links (invite / recovery / magic link: `#access_token=…`, `?code=…`), `resetPasswordForEmail`,
  `updateUser` for anything but the password, `setSession`, admin API.

### Per page

| Page | Feature that does NOT work with the switch on |
|---|---|
| `index.html` | Invite / recovery **email links** (set-password screen only appears from the email-code flow now). Before login it reads `gp_staff` (staff list) and, if that read fails, tries to re-seed `gp_staff` with upserts — these will fail with 401 unless the server allows them (harmless, but noisy). Push sending still goes to the Supabase `push-send` function. |
| `set-password.html` | Whole page (it only works from Supabase invite/recovery links). Staff use "First time / Forgot password" on the Hub instead. |
| `staff-manager.html` | **Invite staff** (Supabase `invite-staff` function) → shows "not available on the new backend yet". |
| `stock-report.html` | nothing known. |
| `employee/index.html` | **Sign up** for new staff (email code with `shouldCreateUser:true`); **Documents & SOP** files and **checks photos** (storage buckets `emp-docs`, `emp-checks`); **Invite** (direct fetch to Supabase `invite-staff` with the session token → fails); push still goes to Supabase `push-send`. Daily Task Log itself: supported (see below). |
| `daily-task-log.html` | nothing to switch (no database). |

## What the server (gl-api) must provide for the switch-on pages

For the **Daily Task Log** (`employee/index.html`, table `gp_emp_daylog`, 4 query shapes, all tested):
1. `gp_emp_daylog` in the GP policy: `select` + `upsert` (onConflict `id`) for staff; columns
   `id, username, date_key, data, planned_at, submitted_at, updated_at`; `data` is JSON and must come back as an object.
   Ops used: `eq`, `lt`, `in`, `order(date_key desc, nullsFirst true)`, `limit 1`, `maybeSingle`.
   Rows are keyed by staff `username` (not the auth uid), and managers read other people's rows for a day, so a plain
   `own:<column>` rule does not fit; copy today's RLS on `gp_emp_daylog` (not checked from here).
2. To get into the employee app at all: `gp_staff` select by `auth_id` (eq) and by `email` (ilike), update `auth_id` by `username`;
   `gp_emp_signups` select (maybeSingle by `id`); `gp_settings` select; and the tables loaded on start
   (`gp_attendance, gp_reminders, gp_leave, gp_announce, gp_emp_projects, gp_emp_docs, gp_emp_sop, gp_emp_checks,
   gp_emp_doc_acks, gp_emp_sop_acks, gp_emp_check_log`). Unknown tables just return `42501`, which the app tolerates.
3. **Login before a session exists**: RPC `email_for_username` (username → email) and the `gp_staff` email check used by
   "First time / Forgot password" must be callable **without** a token (today `/gp/api/*` requires one). Without this,
   username login and forgot-password fail; email + password login still works.
4. `or()` values contain dots (emails: `email.eq.a.b@x.com,auth_id.eq.<uuid>`), so the or-parser must split on the first two dots only.
5. Better Auth `minPasswordLength`: the Hub and employee pages accept 6+ characters; Better Auth's default is 8.
   Set it to 6 (or change the pages) or first-time passwords of 6–7 characters will be refused.
6. CORS: allow the `grandpride.github.io` origin for `/gp/*` and expose `set-auth-token` (already in `src/index.ts`).
7. RPC `gp_emp_set_resigned` (employee app, admin) if that action should work on the new backend.

## Tests

- `node --test tests/cf-client.test.mjs` — no packages. Mocks `fetch`; checks the exact JSON for every query shape the
  Daily Task Log and the login pages use, the auth/token flow, and that unsupported calls fail soft without a request.
- Headless Chromium (switch OFF) loaded every changed page and every page that loads `supa.js` on `origin/main` and on this
  branch with Supabase/Cloudflare blocked: identical console-error lists, and `cf-client.js` is not loaded.
- Headless Chromium (switch ON, Worker mocked): Hub username login reaches the Hub screen with a `gp_ba_token`;
  the employee app loads, `loadDayLog()` and `dlSave()` send the expected `gp_emp_daylog` requests with `Authorization: Bearer`.

## Files

- `cf-client.js` — the client (new file). Loaded only when the switch is on.
- `supa.js` — adds the switch (`GP_BACKEND`), `SUPA.backend()`, loads `cf-client.js` in `init()` when on; Invite returns a clear message when on. Off = unchanged.
- `employee/index.html` — `gpUseCf()` + 6 lines at the top of `initSupabase()`. Off = unchanged. (Remember the
  usual `APP_BUILD` bump when deploying the employee app.)
