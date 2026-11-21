# Moving the Hub to the new backend (Cloudflare) — the switch

The Hub still runs on Supabase. The new backend (gl-api on Cloudflare Workers + D1, Better Auth login) is used on a
phone or PC where **the switch is on**: either that device chose it (`?backend=cf`), or — after go-live — the central
default in `gp-backend-config.js` says `"cf"`. With the switch off nothing changes: `cf-client.js` and `cf-page.js` are
not even downloaded (each page loads the tiny `gp-backend-config.js` and runs a 2-line inline check).

## The go-live switch (one line, `gp-backend-config.js`)

```js
window.GP_BACKEND_DEFAULT = "sb";   // today: everyone on Supabase unless a device chose ?backend=cf
```

| Setting | Device has no choice stored | Device opened `?backend=cf` | Device opened `?backend=sb` |
|---|---|---|---|
| `"sb"` (today) | current system | new system | current system (choice cleared, as before) |
| `"cf"` (go-live) | **new system** | new system | **current system, remembered** (emergency fallback) |

- `?backend=auto` forgets the device choice (follows the default again).
- Every page honours it: `supa.js` pages (Hub, Staff Manager, Stock, Set password, gp-agreement/checklist/qc/sign), the
  Employee app (`../gp-backend-config.js`), every `gp-*` page with its own client, and the customer / driver links
  (gp-sign, gp-qc driver, gp-damage, gp-checkin-view) — customers' phones never chose anything, so they follow the default.
- If `gp-backend-config.js` cannot load (offline, first visit), pages fall back to the old rule (`localStorage.gp_backend === "cf"`).
- `?backend=sb` while the default is `"sb"` still just clears the device choice (exactly as before). Only while the
  default is `"cf"` does it store `"sb"`, so a device that switched back during testing is NOT stuck on Supabase after go-live.

## Go-live procedure (switch-over day)

1. Server ready (lead): Worker deployed with data cut over (incl. `gp_push_subs`, `gp/storage/checkins/*`), Cron Triggers on,
   the 4 Supabase pg_cron jobs off, VAPID keys = the Supabase ones, CORS fix for `x-bucket/x-path/x-upsert` (see below).
2. Flip: in `gp-backend-config.js` change `"sb"` → `"cf"`. Commit + push (GitHub Pages). Nothing else changes.
3. It reaches phones on their next online page load (all service workers are network-first; GitHub Pages may cache the file
   up to 10 minutes). No `APP_BUILD` bump is needed for the flip itself (only `gp-backend-config.js` changes). When THIS
   change set is deployed (before Monday), do the usual Employee app `APP_BUILD` bump (its file changed) and gp-checklist's.
4. Check on one phone with no `?backend`: Hub console shows `[supa] using the NEW backend (Cloudflare)`; log in; open
   gp-fleet / Employee app; open a customer sign link from a checklist on a phone that never used the Hub.
5. Staff log in once (sessions are not moved). Send the WhatsApp message below.

**Emergency fallback**
- One phone: open `https://grandpride.github.io/grandpride-hub/index.html?backend=sb` — that phone stays on the current
  system (remembered) until it opens `?backend=auto` or `?backend=cf`.
- Everyone: change the line back to `"sb"` and push. Devices that chose `?backend=cf` by hand stay on the new system
  (open `?backend=auto` on them). Data written to the new system meanwhile is NOT copied back to Supabase.

## Monday-morning message to staff (WhatsApp)

> Good morning team 👋 From today the Hub runs on our NEW system.
> 1. Open the Hub as usual: https://grandpride.github.io/grandpride-hub/
> 2. Log in again with your username + password (one time only).
> 3. Password not working / first time? Tap *"First time? / Forgot password?"*, enter your email, key in the 6-digit code from your email, set a new password.
> 4. Employee app: same — log in once more.
> 5. Notifications: if the Hub asks, tap *Allow* again.
> Anything not loading? Screenshot it and send to Jimmy. Thank you! 🙏

## Turn it on / off by hand (testing)

| What | How |
|---|---|
| Turn ON (this browser only) | open any Hub page with `?backend=cf`, e.g. `https://grandpride.github.io/grandpride-hub/index.html?backend=cf` |
| Turn OFF | open any Hub page with `?backend=sb` |
| Follow the default again | `?backend=auto` |
| Check | browser console shows `[supa] using the NEW backend (Cloudflare)`; `GP_BACKEND_PICK()` in the console |
| Test against a local Worker | `localStorage.setItem('gp_api_base','http://localhost:8787')` (remove it to go back to the default) |

- The switch is per browser (localStorage on `grandpride.github.io`). Hub pages and the Employee app share it.
- Default API: `https://gl-api.jimmykuek94.workers.dev`, tenant `gp` (`/gp/auth/*`, `/gp/api/*`, `/gp/public/*`).
- Login token: localStorage key `gp_ba_token` (Better Auth bearer token from the `set-auth-token` header). The old
  Supabase login (`sb-…-auth-token`) is not touched, so switching back to `sb` keeps the old login.
- Everyone signs in once after switching on (sessions are not moved).
- Status UI: a small blue "NEW SYSTEM · switch back" tag only on a device switched **by hand**; after go-live nobody sees it.
  Staff pages show an orange "not signed in" bar when there is no new-system login. Customer / driver links show nothing extra.

## Which pages follow the switch

| Page | How |
|---|---|
| `index.html`, `set-password.html`, `staff-manager.html`, `stock-report.html` | `supa.js` → `SUPA.client()` is the cf client |
| `employee/index.html` | guarded hook in `initSupabase()` + small `sb._cf` branches (sign-up, invite, push, approve/reject, staff-email check) |
| `gp-fleet`, `gp-jobs`, `gp-chauffeur`, `gp-chauffeur-hod`, `gp-marketing` | own `supabase.createClient(...)`; guard loads `cf-client.js` + `cf-page.js`, `createClient` returns the cf client |
| `gp-agreement`, `gp-checklist`, `gp-minigames`, `gp-booking`, `gp-appointment`, `gp-daily-update`, `gp-deposit-return`, `gp-record-summary`, `gp-vehicle-fleet`, `gp-vehicle-use` | direct `fetch` to Supabase REST / storage / push-send; `cf-page.js` answers them (`GPCF.handleSupabaseFetch`, `handleFunctionFetch`) |
| `gp-sign`, `gp-qc` (driver `?t=`), `gp-damage`, `gp-checkin-view` | no-login links (`GPCF_PAGE_CFG.public`): public RPCs + `GPCF.handlePublicFetch` → `/gp/public/*` |
| `daily-task-log.html`, `grandlab_jobcard.html` | n/a — no Supabase (localStorage / Google Sheet / Apps Script) |

## Per page status (switch on)

| Page | Status | Notes |
|---|---|---|
| `index.html` (Hub) | works | login (username/email), First time / Forgot password (email code), push subscribe (`gp_push_subs`), push send → `/gp/api/push/send` |
| `set-password.html` | works (n/a) | only for old Supabase email links; on the new system it tells staff to use "First time / Forgot password" on the Hub |
| `staff-manager.html` | works | Invite → `/gp/api/admin/invite` (flat profile fields sent as `profile`); invitee gets a 6-digit code, not a link |
| `stock-report.html` | works | |
| `employee/index.html` | works | login, forgot password, **self sign-up** (`/gp/public/signup/start` → code sign-in → `/gp/api/signup/submit` with the password) + approve/reject (`/gp/api/admin/signups/*`), invite, push, Daily Task Log, docs/check photos (storage) |
| `gp-fleet.html` | works | reminder push → `/gp/api/push/send` |
| `gp-jobs.html` | partial | **Agreement PDF** (`functions.invoke('job-agreement')`) not on the Worker → "not supported" toast. Customer check-in link → `gp-checkin-view.html?t=` (no WhatsApp photo preview until `checkin-share` is on the Worker; then set `CHECKIN_SHARE_BASE` in `cf-page.js`) |
| `gp-chauffeur.html`, `gp-chauffeur-hod.html` | works | |
| `gp-marketing.html` | works | composite `onConflict` (server step 6) |
| `gp-minigames.html` | works | source label still says "Team · Supabase" (cosmetic) |
| `gp-agreement.html` | works | Apps Script PDF unchanged |
| `gp-checklist.html` | works | customer sign link → gp-sign (new route); check-in link as gp-jobs (no WhatsApp preview yet); uploaded photos/videos shown from the new storage |
| `gp-booking.html` | works | staff login (no public route by design); assign chauffeur = `gp_staff` chauffeur columns (server step 6 policy) |
| `gp-appointment`, `gp-daily-update`, `gp-deposit-return`, `gp-record-summary`, `gp-vehicle-fleet`, `gp-vehicle-use` | works | now on the switch (were untouched); need the Hub login like the other staff pages; vehicle-use push → `/gp/api/push/send` |
| `gp-qc.html` | works | ops: `qc_*` RPCs with the Hub login; driver link `?t=`: `qc_load/save_draft/submit/set_pdf` on `/gp/public/rpc`, photos/videos → `/gp/public/storage/upload?t=&path=` (no overwrite; names are unique); the page keeps the upload's signed link (thumbnails, Apps Script, saved draft) |
| `gp-sign.html` | works | `gp_sign_load` / `gp_sign_submit` (no login); signs **once** — second visit / second submit shows "Already signed" |
| `gp-damage.html` | works | `get_damage_approval` / `submit_damage_approval` (no login); one time |
| `gp-checkin-view.html` | works | `get_checkin` (no login), signed photo links |
| `daily-task-log.html`, `grandlab_jobcard.html` | n/a | no database |

Still not on the new system: the `job-agreement` PDF (gp-jobs) and the `checkin-share` WhatsApp preview page (agent E).
Public routes are limited to 10 calls / minute / IP (uploads 60): a driver pressing Save many times quickly sees "Too many requests".

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
`email_for_username`, `staff_email_exists` always go to `/gp/public/rpc/:name` (before login). The no-login link RPCs
(`qc_load, qc_save_draft, qc_submit, qc_set_pdf, get_checkin, get_damage_approval, submit_damage_approval, gp_sign_load,
gp_sign_submit`) go to `/gp/public/rpc/:name` without a login and `/gp/api/rpc/:name` with one (a 401 there is retried once
on `/public`). Public route errors (`429` etc.) come back as `{data:null, error:{code, message}}`.

**Server routes** (`client.gp.*`, extension, answers `{ok, data|error, status}`):

| Call | Route |
|---|---|
| `inviteStaff(payload)` (also `SUPA.inviteStaff`, fetch to `/functions/v1/invite-staff`) | `POST /gp/api/admin/invite` — keys other than `email, username, name, role, existing, profile` are moved into `profile` |
| `pushSend({title, body, target})` (also fetch to `/functions/v1/push-send`) | `POST /gp/api/push/send` (target default `all`) |
| `signupStart(email)` (also `signInWithOtp({shouldCreateUser:true})`) | `POST /gp/public/signup/start` |
| `signupSubmit({name, phone, company, role_req, password})` | `POST /gp/api/signup/submit` |
| `signupApprove({id, username, title, level, reports_to, join, company})` / `signupReject({id, note})` | `POST /gp/api/admin/signups/approve` / `reject` |
| `storage.publicUpload(qcToken, path, blob, {contentType})` | `POST /gp/public/storage/upload?t=&path=` (raw body; keeps the signed link) |

`GPCF.handleFunctionFetch(client, url, init)`: page `fetch` to `/functions/v1/push-send` / `invite-staff` → the routes above
(other functions → `null`, sent unchanged). `GPCF.handlePublicFetch(client, url, init, {page, mode, qcToken})`: gp-sign
`GET /rest/v1/gp_checklists?id=eq.X` → `gp_sign_load` → `[row]`/`[]`; `PATCH` with `<out|in>_sig_customer` → `gp_sign_submit`
→ `204` / `409 already_signed` / `404` / `400`; gp-qc driver `PUT /storage/v1/object/checkins/<path>` (not signed in) → public upload.

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
| `signInWithOtp({email, options:{shouldCreateUser:true}})` (employee sign-up) | `POST /gp/public/signup/start`; the next `verifyOtp` for that email → `POST /sign-in/email-otp {email, otp}` (stores the token) |
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
- Edge functions: `functions.invoke()`; direct `fetch` to functions other than `push-send` / `invite-staff` is not changed.
- Embedded selects / joins / aliases: `select('*, rel(*)')`, `'a:b'`, `'x!inner(...)'`. None found in Hub pages today.
- Filters: `contains`, `containedBy`, `overlaps`, `textSearch`, `range*`, `like/ilikeAllOf/AnyOf`, `not()` with any op except `is`.
- More than one `or()`; `or/order/limit` on a foreign table; `upsert({ignoreDuplicates:true})`; `csv()`, `explain()`.
- Filters or modifiers chained after `rpc()`; `schema('other')`.
- Auth: `signUp`, phone OTP, Supabase email links (invite / recovery / magic link: `#access_token=…`, `?code=…`),
  `resetPasswordForEmail`, `updateUser` for anything but the password (and not right after a sign-up code: the password
  goes with `client.gp.signupSubmit`), `setSession`, admin API.

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
12. **Public (no-login) routes** — done in gl-platform step 6 (`docs/step6/gaps.md`) and wired here. gp-booking is a staff page (login).
13. Edge functions: `push-send` + `invite-staff` — done (step 5, wired here). Still missing: `job-agreement` (gp-jobs PDF),
    `checkin-share` (WhatsApp preview page; until then the Hub sends customers to `gp-checkin-view.html?t=`).
14. Storage: done by Agent A (`x-path` decoded, `data.signedUrl` in the upload answer, own signed links → key on write).
    Also accept the bare `gp/storage/<bucket>/<path>` keys this client writes for old-style links (doc says keys in any
    column / JSON are signed on read).
15. **CORS (blocking for staff uploads)**: the Worker's `allowHeaders` must include `x-bucket`, `x-path`, `x-upsert`, or the
    browser refuses every signed-in storage upload (gp-checklist, gp-jobs check-in, gp-fleet docs, employee docs / checks).
    Public upload (gp-qc driver) uses query parameters and is not affected. Also `exposeHeaders: set-auth-token`.
16. Data cut-over must include `gp_push_subs` (same VAPID key pair) so phones keep getting notifications without re-subscribing.
17. Tables now used by the newly switched pages: `gp_appointments`, `gp_records`, `gp_places`, `gp_fleet_maint_log`,
    `gp_vehicle_use`, `gp_chauffeur_log`, `gp_bookings` (all in `src/gp/policies.ts`).

Note: the chauffeur service worker (`gp-chauffeur-sw.js`) caches every GET except `supabase.co` hosts (network-first), so
`GET /gp/auth/get-session` can be served from cache when offline. Harmless today; exclude the API host when the SW is next bumped.

## Tests

- `node --test tests/cf-client.test.mjs tests/cf-golive.test.mjs` — no packages, fetch mocked (75 tests).
  `cf-client.test.mjs` (53): every query shape of the Daily Task Log / login pages, auth/token flow, storage, all direct-REST
  shapes of the REST pages, unsupported calls fail soft. `cf-golive.test.mjs` (22): `gp-backend-config.js` (ships `"sb"`;
  default sb/cf; `?backend=sb` emergency; `?backend=auto`), public vs logged-in RPC routing + 401 retry + 429, gp-checkin-view /
  gp-damage RPCs, gp-sign load/submit (204, 409 already_signed, 404), gp-qc public upload (URL, headers, raw body, 409/403/429/415,
  size, signed link kept), push-send + invite-staff (flat → profile), other functions untouched, sign-up start / code sign-in /
  submit / approve / reject, forgot-password still uses the reset code.
- `python3 tests/pw_golive.py <hub dir> <untouched copy>` — headless Chromium, every host mocked (99 checks):
  1. switch OFF, 34 page/URL variants (all changed pages, customer links with ids, `?backend=sb`): untouched copy vs this
     version → same console messages, page errors, requests (except the new `gp-backend-config.js`), localStorage, page text;
     `cf-client.js` / `cf-page.js` never requested.
  2. switch ON, Worker mocked: gp-sign sign once → "Already signed" on revisit and on a second submit; gp-qc driver load +
     photo upload (public) + save draft, no request to Supabase; gp-qc ops without login → bar; check-in view; damage sign +
     "Already agreed"; Staff Manager invite; employee invite / push / approve / reject; Hub, gp-fleet, gp-vehicle-use push;
     gp-booking load + assign chauffeur; set-password message; employee self sign-up end to end; employee + Hub forgot
     password; and every staff page (20) loads with only `/gp/*` calls (Bearer), no "not supported", no errors.
  3. `GP_BACKEND_DEFAULT = "cf"`: gp-fleet, Hub, Employee app, Staff Manager, gp-sign, gp-damage use the new backend with
     no `?backend=cf`; `?backend=sb` wins and is remembered; `?backend=auto` returns to the default.

## Files

- `gp-backend-config.js` — **new**: the go-live line `GP_BACKEND_DEFAULT` + `GP_BACKEND_PICK()` / `GP_BACKEND_SOURCE()`.
  Loaded with a plain `<script>` before `supa.js` / the guard on every page that has a database.
- `cf-client.js` — the client. Loaded only when the switch is on. New: public RPC routing, `client.gp.*` routes, sign-up auth,
  `storage.publicUpload`, `GPCF.handleFunctionFetch`, `GPCF.handlePublicFetch`; `enabled()` follows the config file.
- `cf-page.js` — glue for non-`supa.js` pages. New: public pages use the public routes (no full-screen notice), push/invite
  function fetches, photos built for the old storage shown from the new one, `checkinShareLink`, tag only when switched by hand.
- `supa.js` — `GP_BACKEND` uses `GP_BACKEND_PICK()` when present; Invite → `/gp/api/admin/invite` when on. Off = unchanged.
- `employee/index.html` — loads `../gp-backend-config.js`; `gpUseCf()` uses it; `sb._cf` branches (see status). Off = unchanged.
- Guard pages (`gp-agreement, gp-chauffeur(-hod), gp-checklist, gp-fleet, gp-jobs, gp-marketing, gp-minigames, gp-qc, gp-sign`):
  guard now asks `GP_BACKEND_PICK()` (old inline rule as fallback); gp-qc is "public" only with `?t=`.
- `gp-booking, gp-damage, gp-checkin-view`: the "not on the new system yet" note is replaced by the real guard (before the page script).
- `gp-appointment, gp-daily-update, gp-deposit-return, gp-record-summary, gp-vehicle-fleet, gp-vehicle-use`: guard added.
- Small page changes, active only on the new backend: `gp-sign` ("Already signed"), `gp-qc` (`stUpload` returns the signed
  link), `gp-jobs` / `gp-checklist` (check-in link), `index.html` (`pushNotify`), `set-password.html` (message).
- Deploy note: gp-checklist has `APP_BUILD` / remote `app_version`; gp-qc and gp-chauffeur have their own service workers
  (network-first, so the new files arrive on next online load). `gp-chauffeur-sw.js` caches GETs incl. the API host (see note above).
