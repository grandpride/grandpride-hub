# Moving the Hub to the new backend (Cloudflare) — the switch

The Hub still runs on Supabase. The new backend (gl-api on Cloudflare Workers + D1, Better Auth login) is only used
on a phone or PC where **the switch is on**. With the switch off nothing changes: `cf-client.js` and `cf-page.js` are not
even downloaded (each page only has a 2-line inline check of `localStorage.gp_backend`).

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
| `gp-fleet.html`, `gp-jobs.html`, `gp-chauffeur.html`, `gp-chauffeur-hod.html`, `gp-marketing.html` | yes | own `supabase.createClient(...)`; guard snippet loads `cf-client.js` + `cf-page.js`, which makes `createClient` return the cf client |
| `gp-agreement.html`, `gp-checklist.html`, `gp-qc.html`, `gp-sign.html`, `gp-minigames.html` | yes | direct `fetch` to Supabase REST / storage; `cf-page.js` answers those fetches through `GPCF.handleSupabaseFetch` (no network to Supabase) |
| `gp-booking.html`, `gp-damage.html`, `gp-checkin-view.html` | **no** (still Supabase) | no-login customer pages; with the switch on they only show a dismissible "not on the new system yet" note |
| other `gp-*` pages (appointment, daily-update, deposit-return, record-summary, vehicle-fleet, vehicle-use), `grandlab_jobcard.html` | **no** — untouched | direct Supabase REST; not in this step |
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

**Storage** (`docs/storage-contract.md`, server: gl-platform `docs/step5/files.md`), Bearer login, `POST /gp/api/storage/*`:

| Page calls | cf-client does |
|---|---|
| `upload(path, blob, {contentType, upsert})` / `update(...)` | `/storage/upload`, raw bytes, headers `x-bucket`, `x-path` = `encodeURIComponent(path)`, `x-upsert`, `Content-Type`. Keeps the answer's `data.signedUrl` (falls back to one `/sign` if an older server leaves it out). Size checked first (checkins + emp-docs 50 MB, others 10 MB) so a phone never sends a file the server will refuse. |
| `getPublicUrl(path)` (sync) | the signed URL of the upload / `createSignedUrl(s)` made in this page (7 days). Pages save it into rows — fine: `/db` turns our own signed links back into the key and signs again on every read. Not uploaded in this page: returns `<api>/gp/files/gp/storage/<bucket>/<path>` (unsigned → 403) and signs in the background so the next call is right. |
| `createSignedUrl` / `createSignedUrls` | `/sign` / `/sign-many`, `expiresIn` capped at 7 days |
| `download` / `remove` / `list(prefix,{limit,offset})` | `/download` (→ Blob) / `/remove` / `/list` |

Storage errors look like storage-js: `{ data:null, error:{ name:'StorageApiError', message, status, statusCode:'4xx', error } }`.
Signed URLs coming back from `/api/db` are passed through untouched.

**Direct Supabase REST** (`GPCF.handleSupabaseFetch`, used by `cf-page.js`) — exactly the shapes the pages use:

| Supabase request | becomes |
|---|---|
| `GET /rest/v1/<t>?select=&<col>=eq.\|neq.\|gt.\|gte.\|lt.\|lte.\|like.\|ilike.\|in.(…)\|is.\|not.is.&order=c.asc\|desc[.nullsfirst\|.nullslast]&limit=&offset=` | `from(t).select().<filters>.order().limit()/range()` → JSON array, 200 |
| `POST /rest/v1/<t>[?on_conflict=c]` with `Prefer: resolution=merge-duplicates` | `upsert(body,{onConflict})`; otherwise `insert(body)`; 201 |
| `PATCH` / `DELETE /rest/v1/<t>?<filters>` | `update(body)` / `delete()`; 204 (or 200 + rows with `Prefer: return=representation`) |
| `POST /rest/v1/rpc/<fn>` | `rpc(fn, body)`; 200 + JSON |
| `PUT\|POST /storage/v1/object/<bucket>/<path>` (`x-upsert`) | `storage.from(bucket).upload(path, body)`; 200 `{Key}` |
| `/functions/v1/*` | **not changed** — still goes to Supabase |
| anything else (`or=`, `not.<op>` other than `is`, `/auth/v1`, public storage GET, Request objects…) | 400 `CF_UNSUPPORTED`, no request |

Values stay strings like PostgREST (`id=eq.5` sends `"5"`), except `is.null/true/false`. `*` in like/ilike → `%`. Errors come
back as PostgREST-style JSON (`{code,message,details,hint}`, 401 when not logged in).
Photo links the page builds for the OLD storage (`https://gpdb.grandlab.com.my/storage/v1/object/public/<bucket>/<path>`,
gp-checklist and gp-qc build these themselves) are rewritten: in data sent to the API (whole JSON string values only) to the
bare key `gp/storage/<bucket>/<path>` (the server signs it on read; same key the cutover copies old files to); in any
other request body (Apps Script PDF payload) to the signed URL of the upload made in this page.

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

- Realtime: `channel()`, `removeChannel()`, `removeAllChannels()` (stubs, no events). **No Hub page uses realtime today**
  (checked all pages incl. gp-chauffeur / gp-chauffeur-hod: the HOD board has a manual ↻ Refresh; the chauffeur page
  sends its GPS ping every 2 min with setInterval, which keeps working). So no page loses live updates with the switch
  on and no polling fallback was added. If realtime is added later: HOD board 60 s, chauffeur job list 60 s, while visible.
- Storage: `move`, `copy`, `createSignedUploadUrl`, `uploadToSignedUrl`, `upload(FormData)`, `list({search})`
  or `sortBy` other than name asc, `download/createSignedUrl` with `transform`/`download`.
- Edge functions: `functions.invoke()`. Direct `fetch` to Supabase functions is not changed (see per page).
- Embedded selects / joins / aliases: `select('*, rel(*)')`, `'a:b'`, `'x!inner(...)'`. None found in Hub pages today.
- Filters: `contains`, `containedBy`, `overlaps`, `textSearch`, `range*`, `like/ilikeAllOf/AnyOf`, `not()` with any op except `is`.
- More than one `or()`; `or/order/limit` on a foreign table; `upsert({ignoreDuplicates:true})`; `csv()`, `explain()`.
- Filters or modifiers chained after `rpc()`; `schema('other')`.
- Auth: `signUp`, sign-up by email code (`shouldCreateUser:true`, `verifyOtp type:'signup'`), phone OTP,
  Supabase email links (invite / recovery / magic link: `#access_token=…`, `?code=…`), `resetPasswordForEmail`,
  `updateUser` for anything but the password, `setSession`, admin API.

### Per page (switch on)

**Status with the switch on, signed in on the new system** (works / partial / not yet):

| Page | Status | What does not work yet |
|---|---|---|
| `gp-fleet.html` | works | Reminder push still goes to the Supabase `push-send` function (unchanged; uses the old `gp_push_subs`). |
| `gp-jobs.html` | partial | **Agreement PDF** (`functions.invoke('job-agreement')` → "not supported" toast). **Check-in share link** for the customer points to the Supabase `checkin-share` function, which cannot see check-ins saved in the new database. |
| `gp-chauffeur.html` | works | — (GPS ping, attendance, trip status all via `/api/db`) |
| `gp-chauffeur-hod.html` | works | — (manual refresh, as today) |
| `gp-marketing.html` | works | needs composite `onConflict` (`ym,bucket`; `campaign_name,period_start,period_end`) on the server |
| `gp-minigames.html` | works | not signed in → scores fall back to "Local device" (as today offline). The source label still says "Team · Supabase" (cosmetic). |
| `gp-agreement.html` | works | Apps Script PDF unchanged. |
| `gp-checklist.html` | partial | Data, photos, videos and Apps Script PDF work. **Customer sign link** (`gp-sign.html?id=`) and **check-in share link** (`/functions/v1/checkin-share`) are opened by customers on the current system, which cannot see checklists saved in the new database. |
| `gp-qc.html` | not yet | Needs RPCs `qc_list, qc_relink, qc_create, qc_load, qc_save_draft, qc_submit, qc_set_pdf` on the server; driver links are no-login → full-screen "not on the new system yet" notice. Uploads already go to new storage. |
| `gp-sign.html` | not yet (customers) / works (signed-in staff) | No-login → full-screen notice with "Open on current system". |
| `gp-booking.html`, `gp-damage.html`, `gp-checkin-view.html` | not yet | Not on the switch at all; still Supabase; note shown when the switch is on. |

Not signed in on the new system: no-login pages (`gp-sign`, `gp-qc`) show a full-screen notice ("This page is not on the
new system yet — Open on current system (?backend=sb)"); staff pages show an orange bar ("New system: not signed in…")
and their own login/gate as before. Signed in: a small blue "NEW SYSTEM · switch back" tag bottom-left.

**Other features that do not work with the switch on:**

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

For the **pages added in this step** (shapes in `tests/cf-client.test.mjs`):

8. Table policies (staff) for: `gp_fleet` (select/insert/update/delete), `gp_fleet_service`, `gp_fleet_accident`, `gp_fleet_log`,
   `gp_jobs`, `gp_customers`, `gp_checklists` (upsert `onConflict id`), `gp_checkins` (insert), `gp_records`
   (update + returning, upsert `onConflict job_id`), `gp_staff` (chauffeur ping: update `last_lat,last_lng,last_ping_at`
   own row), `gp_attendance` (upsert `onConflict id`), `gp_mkt_counts`, `gp_mkt_campaigns`, `gp_mkt_imports`,
   `gp_training_scores` (insert, select), `gp_agreements` (upsert/select/delete), `gp_bookings` (select), `gp_app_config` (select).
9. **Composite `onConflict`** for upsert: `ym,bucket` and `campaign_name,period_start,period_end` (gp-marketing).
10. Values from the REST pages arrive as strings (`id=eq.5` → `"5"`): compare with column affinity (D1 does this for typed columns).
11. RPCs for gp-qc: `qc_list, qc_relink, qc_create, qc_load, qc_save_draft, qc_submit, qc_set_pdf` (photo links inside
    their args arrive as bare `gp/storage/checkins/...` keys).
12. **Public (no-login) routes** — until these exist the customer/driver links must stay on Supabase: checklist by id + customer
    signature (gp-sign), token-scoped QC (gp-qc driver), check-in share page (`checkin-share`), damage approval, check-in view, booking.
13. Edge functions: `job-agreement` (gp-jobs), `push-send` + `gp_push_subs`, `checkin-share`.
14. Storage: done by Agent A (`x-path` decoded, `data.signedUrl` in the upload answer, own signed links → key on write).
    Also accept the bare `gp/storage/<bucket>/<path>` keys this client writes for old-style links (doc says keys in any
    column / JSON are signed on read).

Note: the chauffeur service worker (`gp-chauffeur-sw.js`) caches every GET except `supabase.co` hosts (network-first), so
`GET /gp/auth/get-session` can be served from cache when offline. Harmless today; exclude the API host when the SW is next bumped.

## Tests

- `node --test tests/cf-client.test.mjs` — no packages. Mocks `fetch`; checks the exact JSON for every query shape the
  Daily Task Log and the login pages use, the auth/token flow, and that unsupported calls fail soft without a request.
  Added: storage (upload headers/raw body, signedUrl kept, /sign fallback, 409/415/401 errors, 7-day cap, size limits,
  sign/sign-many/remove/list/download, lazy getPublicUrl) and every direct-REST shape of gp-agreement, gp-checklist,
  gp-qc, gp-sign, gp-minigames (select/upsert/insert/update/delete/rpc/storage upload, return=minimal vs representation,
  AbortSignal, error mapping, old storage links → keys / signed), plus unsupported REST shapes. 53 tests.
- Headless Chromium, switch OFF, all external hosts blocked: the 10 changed pages (+ gp-qc `?t=`, gp-sign `?id=` and
  `?backend=sb`) and booking/damage/check-in view, untouched copy vs this branch: identical console messages, page errors,
  requested URLs, localStorage keys and page text; `cf-client.js` / `cf-page.js` never requested.
- Headless Chromium, switch ON, Worker mocked: every page reaches `/gp/api/*` with `Bearer`, never Supabase; supabase-js
  `createClient` (stubbed as a frozen namespace) is replaced; gp-checklist upload → `/storage/upload` and the saved link
  becomes a key; no-login gp-sign / gp-qc show the notice and send nothing; booking/damage/check-in view show the note.
- Headless Chromium (switch OFF) loaded every changed page and every page that loads `supa.js` on `origin/main` and on this
  branch with Supabase/Cloudflare blocked: identical console-error lists, and `cf-client.js` is not loaded.
- Headless Chromium (switch ON, Worker mocked): Hub username login reaches the Hub screen with a `gp_ba_token`;
  the employee app loads, `loadDayLog()` and `dlSave()` send the expected `gp_emp_daylog` requests with `Authorization: Bearer`.

## Files

- `cf-client.js` — the client (new file). Loaded only when the switch is on.
- `supa.js` — adds the switch (`GP_BACKEND`), `SUPA.backend()`, loads `cf-client.js` in `init()` when on; Invite returns a clear message when on. Off = unchanged.
- `employee/index.html` — `gpUseCf()` + 6 lines at the top of `initSupabase()`. Off = unchanged. (Remember the
  usual `APP_BUILD` bump when deploying the employee app.)
- `cf-page.js` — new. Glue for the non-`supa.js` pages: `createClient` → cf client, fetch adapter, status tag / bar / notice.
  Loaded only when the switch is on.
- `gp-fleet`, `gp-jobs`, `gp-chauffeur`, `gp-chauffeur-hod`, `gp-marketing`, `gp-minigames`, `gp-agreement`, `gp-checklist`,
  `gp-qc`, `gp-sign` (`.html`) — one inline guard `<script>` each (after the supabase-js / `supa.js` tag; gp-minigames before
  its script): reads `?backend=` and `localStorage.gp_backend`; only when `"cf"` it `document.write`s `cf-client.js` +
  `cf-page.js`. `GPCF_PAGE_CFG.public` is true for gp-qc and gp-sign. Off = nothing else runs.
- `gp-booking`, `gp-damage`, `gp-checkin-view` (`.html`) — one inline `<script>` before `</body>`: when the switch is on,
  a dismissible note "not on the new system yet". Off = nothing happens.
- Deploy note: gp-checklist has `APP_BUILD` / remote `app_version`; gp-qc and gp-chauffeur have their own service workers
  (network-first, so the new files arrive on next online load).
