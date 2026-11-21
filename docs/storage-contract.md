# Files / photos contract (gl-api, R2 bucket `gp-photos`, binding `GP_FILES`)

## Photos already in data
Migrated photo/signature cells hold an R2 key like `gp/<table>/<id>-<col>.<ext>` (or `...-<col>-<n>.<ext>` inside JSON).
On READ through /gp/api/db the API turns every such key into a signed URL the browser can use directly in `<img src>`:
`https://<api>/gp/files/<key>?exp=<unix seconds>&sig=<hex hmac-sha256(key + "." + exp)>`
- signing key: HMAC derived from BETTER_AUTH_SECRET (e.g. HMAC(secret, "gp-files-v1")); validity 7 days.
- GET /gp/files/<key> checks exp + sig, then streams the object with the right Content-Type (from extension) and
  `Cache-Control: private, max-age=3600`. Bad/expired sig -> 403. No login header needed (img tags can't send one).

## Pages that still WRITE base64 (data:image/...;base64,...) into photo columns
On insert/update/upsert through /gp/api/db, any `data:<mime>;base64,` string in a known photo column (or inside a JSON
column) is stored in R2 as `gp/<table>/<pk>-<col>[-n].<ext>` and the cell gets the key. Max 10 MB per image.
Reads then return signed URLs as above, so pages keep working unchanged.

## supabase-js storage emulation (`sb.storage.from(bucket)...`), all need Bearer login
R2 key for storage objects: `gp/storage/<bucket>/<path>`.
- POST /gp/api/storage/upload   headers: x-bucket, x-path, x-upsert ("true"/"false"), Content-Type; body = raw bytes
  -> `{ data: { path, fullPath: "<bucket>/<path>" }, error }` (409-style error `{message:"The resource already exists", statusCode:"409"}` when exists and not upsert)
- POST /gp/api/storage/sign     `{ bucket, path, expiresIn }` -> `{ data: { signedUrl }, error }` (signed /gp/files URL)
- POST /gp/api/storage/sign-many `{ bucket, paths, expiresIn }` -> `{ data: [{ path, signedUrl, error }], error }`
- POST /gp/api/storage/remove   `{ bucket, paths }` -> `{ data: [{ name }], error }`
- POST /gp/api/storage/list     `{ bucket, prefix, limit, offset }` -> `{ data: [{ name, id, metadata:{size, mimetype}, created_at }], error }`
- POST /gp/api/storage/download `{ bucket, path }` -> raw bytes (Content-Type set) or JSON error
- `getPublicUrl(path)` (client side, no request): returns the signed-style URL only if the server gave one; otherwise
  the client calls /sign lazily. Buckets allowed + who may write: defined server-side (default: staff read/write, size cap 10 MB).
