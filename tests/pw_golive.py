#!/usr/bin/env python3
"""Headless Chromium checks for the go-live switch (docs/cf-migration.md).

Run:  python3 tests/pw_golive.py <new hub dir> <untouched copy of the hub>
      (needs the Python playwright package + Chromium; nothing goes on the network:
       every page, the Worker API and Supabase are served by route mocks)

1. Switch OFF: every changed page, new vs untouched copy -> identical console, page errors, requests
   (except the new gp-backend-config.js), localStorage and page text. cf-client.js / cf-page.js never load.
2. Switch ON (mocked Worker): sign once + second sign refused, QC driver upload + save, check-in view, damage,
   invite, push, employee sign-up + approve, Hub + employee forgot password, gp-booking staff login path.
3. GP_BACKEND_DEFAULT = "cf" (config served with "cf"): pages use the new backend with no ?backend=cf,
   ?backend=sb still wins (old system, remembered), ?backend=auto goes back to the default.
"""
import json, mimetypes, os, re, sys
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

NEW, ORIG = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
API_HOST = 'gl-api.jimmykuek94.workers.dev'
SB_HOST = 'gpdb.grandlab.com.my'
HOSTS = {'new.test': NEW, 'orig.test': ORIG, 'golive.test': NEW}
CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': 'set-auth-token'}
SIGNED = 'https://' + API_HOST + '/gp/files/gp/storage/checkins/qc1/x.jpg?exp=1&sig=a'
PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
QC_TOKEN = 'ab' * 16
DMG_ID = '11111111-2222-3333-4444-555555555555'
FAILS = []


def check(cond, what):
    print(('  ok   ' if cond else '  FAIL ') + what)
    if not cond:
        FAILS.append(what)


def jbody(req):
    try:
        return json.loads(req.post_data or 'null')
    except Exception:
        return req.post_data


class Api:
    """Stateful mock of the Worker (gl-api) for one browser context."""
    def __init__(self):
        self.calls = []
        self.signed = {}           # gp-sign: stage -> True after first signature
        self.dmg_agreed = False

    def handle(self, route, req):
        u = urlparse(req.url)
        p = u.path
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers=CORS)
        body = jbody(req) if req.method != 'GET' and 'storage/upload' not in p else None
        auth = req.headers.get('authorization')
        self.calls.append({'path': p, 'query': u.query, 'body': body, 'auth': auth, 'ctype': req.headers.get('content-type')})
        hdr = dict(CORS)

        def ok(obj, status=200, extra=None):
            h = dict(hdr); h['content-type'] = 'application/json'
            if extra: h.update(extra)
            return route.fulfill(status=status, headers=h, body=json.dumps(obj))

        user = {'id': 'uid-1', 'email': 'ali@x.com', 'name': 'Ali', 'role': 'staff'}
        if p == '/gp/auth/get-session':
            return ok({'session': {'expiresAt': '2030-01-01T00:00:00Z'}, 'user': user} if auth else None)
        if p in ('/gp/auth/sign-in/email', '/gp/auth/sign-in/email-otp'):
            return ok({'token': 'x', 'user': user}, extra={'set-auth-token': 'tok-' + p.rsplit('/', 1)[1]})
        if p.startswith('/gp/auth/'):
            return ok({'success': True})
        m = re.match(r'^/gp/(api|public)/rpc/([a-z_]+)$', p)
        if m:
            return ok({'data': self.rpc(m.group(2), body or {}), 'error': None})
        if p == '/gp/public/storage/upload':
            q = parse_qs(u.query)
            path = q.get('path', [''])[0]
            return ok({'data': {'path': path, 'fullPath': 'checkins/' + path, 'key': 'gp/storage/checkins/' + path, 'signedUrl': SIGNED}, 'error': None})
        if p == '/gp/api/db':
            b = body or {}
            single = b.get('single') or b.get('maybeSingle')
            flt = b.get('filters') or []
            if b.get('table') == 'gp_staff' and any(f[0] == 'username' and f[2] != 'ali' for f in flt):
                return ok({'data': None if single else [], 'error': None, 'count': None})
            if b.get('table') == 'gp_staff' and b.get('op') == 'select' and auth:
                row = {'username': 'ali', 'name': 'Ali', 'role': 'Admin', 'auth_id': 'uid-1', 'email': 'ali@x.com', 'apps': ['attendance', 'tasklog']}
                return ok({'data': row if single else [row], 'error': None, 'count': None})
            return ok({'data': None if single else [], 'error': None, 'count': None})
        if p == '/gp/api/push/send':
            return ok({'ok': True, 'sent': 1})
        if p == '/gp/api/admin/invite':
            return ok({'ok': True, 'auth_id': 'new-uid', 'username': (body or {}).get('username'), 'email_sent': True})
        if p == '/gp/public/signup/start':
            return ok({'ok': True})
        if p == '/gp/api/signup/submit':
            b = body or {}
            return ok({'ok': True, 'signup': {'id': 'uid-1', 'email': 'new@x.com', 'name': b.get('name'), 'company': b.get('company'), 'role_req': b.get('role_req'), 'status': 'pending'}})
        if p.startswith('/gp/api/admin/signups/'):
            return ok({'ok': True, 'username': (body or {}).get('username'), 'auth_id': 'uid-9'})
        if p.startswith('/gp/api/storage/'):
            return ok({'data': {'signedUrl': SIGNED, 'path': 'x'}, 'error': None})
        return ok({'error': 'not mocked'}, 404)

    def rpc(self, name, a):
        if name == 'gp_sign_load':
            stage = 'in' if a.get('p_mode') == 'return' else 'out'
            if a.get('p_id') != 'cl_test1':
                return None
            return {'id': 'cl_test1', 'customer_name': 'SIGN CUSTOMER', 'car_model': 'Alphard', 'car_plate': 'VAA 1',
                    'lease_from': '2026-11-01', 'lease_to': '2026-11-30', stage + '_mileage': '1200', stage + '_petrol': 4,
                    stage + '_photos': [SIGNED], 'already_signed': bool(self.signed.get(stage)), 'customer_signed_at': None}
        if name == 'gp_sign_submit':
            stage = 'in' if a.get('p_mode') == 'return' else 'out'
            if self.signed.get(stage):
                return {'ok': False, 'error': 'already_signed'}
            self.signed[stage] = True
            return {'ok': True, 'signed_at': '2026-11-23T01:00:00Z'}
        if name == 'get_checkin':
            return {'customer_name': 'CHECKIN CUSTOMER', 'car_model': 'Vellfire', 'car_plate': 'VBB 2', 'stage': 'delivery', 'note': 'ok',
                    'media': [{'type': 'photo', 'url': SIGNED, 'label': 'Front'}], 'photo_count': 1, 'video_count': 0,
                    'preview_url': SIGNED, 'preview_thumb': None, 'diagram_url': None, 'defects': [], 'created_at': '2026-11-22T02:00:00Z'} if a.get('p_token') == 'ci_test1' else None
        if name == 'get_damage_approval':
            if a.get('p_job_id') != DMG_ID:
                return None
            return {'id': DMG_ID, 'customer_name': 'DAMAGE CUSTOMER', 'car_model': 'Camry', 'car_plate': 'VCC 3', 'deposit_amount': 500,
                    'exceed_km': 0, 'exceed_km_charge': 0, 'summons_charge': 0, 'already_agreed': self.dmg_agreed, 'agreed_at': None,
                    'damages': [{'mark_no': '1', 'type': 'Dent', 'loc': 'Door', 'note': None, 'price': 120}]}
        if name == 'submit_damage_approval':
            if self.dmg_agreed:
                return {'ok': False, 'error': 'already_agreed'}
            self.dmg_agreed = True
            return {'ok': True}
        if name == 'qc_load':
            return {'ok': True, 'stage': 'out', 'id': 'qc1', 'customer_name': 'QC CUSTOMER', 'car_model': 'Alphard', 'car_plate': 'VAA 1',
                    'driver': 'Abu', 'location': 'PJ', 'photos': [], 'interior_photos': [], 'defect_photos': [], 'videos': [],
                    'defects': [], 'checks': {}, 'items': {}, 'sig_inspector': '', 'sig_customer': ''}
        if name in ('qc_save_draft', 'qc_submit'):
            return {'ok': True, 'id': 'qc1', 'stage': 'out', 'saved_at': '2026-11-23T01:00:00Z'}
        if name == 'email_for_username':
            return 'ali@x.com'
        if name == 'staff_email_exists':
            return True
        return None


def sb_mock(route, req):
    """Deterministic stand-in for the Supabase server (switch OFF runs). Same answers for both copies."""
    u = urlparse(req.url)
    p = u.path
    h = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json'}
    if req.method == 'OPTIONS':
        return route.fulfill(status=204, headers=h)
    if p == '/rest/v1/gp_checklists' and req.method == 'GET' and 'cl_test1' in u.query:
        return route.fulfill(status=200, headers=h, body=json.dumps([{'id': 'cl_test1', 'customer_name': 'SB CUSTOMER', 'out_mileage': '1000', 'out_photos': []}]))
    if p == '/rest/v1/rpc/get_checkin':
        return route.fulfill(status=200, headers=h, body=json.dumps({'customer_name': 'SB CHECKIN', 'media': [], 'photo_count': 0, 'video_count': 0, 'defects': []}))
    if p == '/rest/v1/rpc/get_damage_approval':
        return route.fulfill(status=200, headers=h, body=json.dumps({'id': DMG_ID, 'customer_name': 'SB DAMAGE', 'damages': [], 'deposit_amount': 100}))
    if p == '/rest/v1/rpc/qc_load':
        return route.fulfill(status=200, headers=h, body=json.dumps({'ok': True, 'stage': 'out', 'id': 'qc1', 'customer_name': 'SB QC'}))
    if p.startswith('/rest/v1/rpc/'):
        return route.fulfill(status=200, headers=h, body='null')
    if p.startswith('/rest/v1/') and req.method == 'GET':
        return route.fulfill(status=200, headers=h, body='[]')
    if p.startswith('/rest/v1/'):
        return route.fulfill(status=201, headers=h, body='')
    return route.abort()


def make_context(browser, api=None, sb=True, golive_default='cf'):
    ctx = browser.new_context(service_workers='block', viewport={'width': 420, 'height': 900})

    def handler(route, req):
        u = urlparse(req.url)
        host = u.hostname
        if host in HOSTS:
            rel = u.path.lstrip('/') or 'index.html'
            fp = os.path.join(HOSTS[host], rel)
            if not os.path.isfile(fp):
                return route.fulfill(status=404, body='not found')
            data = open(fp, 'rb').read()
            if host == 'golive.test' and rel == 'gp-backend-config.js':
                data = data.replace(b'window.GP_BACKEND_DEFAULT = "sb";', ('window.GP_BACKEND_DEFAULT = "%s";' % golive_default).encode())
            ct = mimetypes.guess_type(fp)[0] or 'application/octet-stream'
            return route.fulfill(status=200, body=data, headers={'content-type': ct + ('; charset=utf-8' if ct.startswith('text') or 'javascript' in ct else '')})
        if host == API_HOST and api is not None:
            return api.handle(route, req)
        if host == SB_HOST and sb:
            return sb_mock(route, req)
        return route.abort()
    ctx.route('**/*', handler)
    return ctx


def snapshot(ctx, url, wait=2200):
    page = ctx.new_page()
    out = {'console': [], 'errors': [], 'requests': []}
    page.on('console', lambda m: out['console'].append(m.type + ': ' + re.sub(r'https?://(new|orig)\.test', 'HOST', m.text)))
    page.on('pageerror', lambda e: out['errors'].append(str(e)))
    page.on('request', lambda r: out['requests'].append(r.method + ' ' + re.sub(r'https?://(new|orig)\.test', 'HOST', r.url)))
    try:
        page.goto(url, wait_until='load', timeout=15000)
    except Exception as e:
        out['errors'].append('goto: ' + str(e)[:200])
    page.wait_for_timeout(wait)
    try:
        out['ls'] = page.evaluate("() => Object.keys(localStorage).sort().map(k => k + '=' + localStorage.getItem(k))")
        out['text'] = page.evaluate("() => document.body ? document.body.innerText : ''")
    except Exception as e:
        out['ls'], out['text'] = [], 'eval failed ' + str(e)[:100]
    page.close()
    return out


OFF_PAGES = ['index.html', 'set-password.html', 'staff-manager.html', 'stock-report.html', 'employee/index.html',
             'gp-agreement.html', 'gp-appointment.html', 'gp-booking.html', 'gp-chauffeur-hod.html', 'gp-chauffeur.html',
             'gp-checkin-view.html', 'gp-checkin-view.html?t=ci_test1', 'gp-checklist.html', 'gp-daily-update.html',
             'gp-damage.html', 'gp-damage.html?id=' + DMG_ID, 'gp-deposit-return.html', 'gp-fleet.html', 'gp-jobs.html',
             'gp-marketing.html', 'gp-minigames.html', 'gp-qc.html', 'gp-qc.html?t=' + QC_TOKEN, 'gp-record-summary.html',
             'gp-sign.html', 'gp-sign.html?id=cl_test1', 'gp-sign.html?id=cl_test1&mode=return', 'gp-vehicle-fleet.html',
             'gp-vehicle-use.html', 'gp-sign.html?id=cl_test1&backend=sb', 'gp-fleet.html?backend=sb', 'index.html?backend=sb',
             'employee/index.html?backend=sb', 'gp-damage.html?id=' + DMG_ID + '&backend=sb']


def norm_text(t):
    return re.sub(r'\d{1,2}:\d{2}(:\d{2})?', 'HH:MM', t or '')


def run_off(browser):
    print('\n== 1. switch OFF: new vs untouched copy')
    for pg in OFF_PAGES:
        res = {}
        for host in ('orig.test', 'new.test'):
            ctx = make_context(browser)
            res[host] = snapshot(ctx, 'http://%s/%s' % (host, pg))
            ctx.close()
        a, b = res['orig.test'], res['new.test']
        breq = [r for r in b['requests'] if not r.endswith('/gp-backend-config.js')]
        diffs = []
        # distinct messages / URLs (repeats of the same failed request depend on timing, e.g. staff-manager retries)
        if set(a['console']) != set(b['console']): diffs.append('console %s' % sorted(set(a['console']) ^ set(b['console']))[:4])
        if a['errors'] != b['errors']: diffs.append('errors %s vs %s' % (a['errors'], b['errors']))
        if set(a['requests']) != set(breq): diffs.append('requests %s' % sorted(set(a['requests']) ^ set(breq)))
        if a['ls'] != b['ls']: diffs.append('localStorage %s vs %s' % (a['ls'], b['ls']))
        if norm_text(a['text']) != norm_text(b['text']): diffs.append('text differs')
        if any('cf-client.js' in r or 'cf-page.js' in r for r in b['requests']): diffs.append('cf files loaded')
        check(not diffs, 'OFF identical: %s %s' % (pg, '; '.join(diffs)[:600]))


def cf_requests(page_reqs):
    return [r for r in page_reqs if 'cf-client.js' in r or 'cf-page.js' in r]


def draw(page, sel='#pad'):
    box = page.locator(sel).bounding_box()
    page.mouse.move(box['x'] + 20, box['y'] + 40)
    page.mouse.down()
    page.mouse.move(box['x'] + 120, box['y'] + 90, steps=5)
    page.mouse.move(box['x'] + 200, box['y'] + 50, steps=5)
    page.mouse.up()


def new_page(ctx):
    page = ctx.new_page()
    reqs, errs = [], []
    page.on('request', lambda r: reqs.append(r.url))
    page.on('pageerror', lambda e: errs.append(str(e)))
    return page, reqs, errs


def run_on(browser):
    print('\n== 2. switch ON (?backend=cf), Worker mocked')
    # --- gp-sign: sign once, second sign refused
    api = Api(); ctx = make_context(browser, api, sb=False)
    page, reqs, errs = new_page(ctx)
    page.goto('http://new.test/gp-sign.html?backend=cf&id=cl_test1&mode=delivery'); page.wait_for_timeout(800)
    check('SIGN CUSTOMER' in page.inner_text('body'), 'gp-sign: checklist shown (gp_sign_load, no login)')
    check(page.locator('#gpcf-block').count() == 0 and page.locator('#gpcf-pill').count() == 0, 'gp-sign: no notice / tag for the customer')
    c = [x for x in api.calls if x['path'].endswith('/gp_sign_load')]
    check(c and c[0]['path'] == '/gp/public/rpc/gp_sign_load' and c[0]['auth'] is None and c[0]['body'] == {'p_id': 'cl_test1', 'p_mode': 'delivery'}, 'gp-sign: POST /gp/public/rpc/gp_sign_load {p_id,p_mode}, no Authorization')
    draw(page); page.check('#agree'); page.click('text=Submit signature'); page.wait_for_timeout(800)
    s = [x for x in api.calls if x['path'].endswith('/gp_sign_submit')]
    check(s and s[0]['path'] == '/gp/public/rpc/gp_sign_submit' and s[0]['body']['p_mode'] == 'delivery' and str(s[0]['body']['p_signature']).startswith('data:image/png;base64,'), 'gp-sign: gp_sign_submit with the PNG signature')
    check(page.is_visible('#doneView') and 'Thank you' in page.inner_text('#doneView'), 'gp-sign: "Thank you" after signing')
    page.goto('http://new.test/gp-sign.html?id=cl_test1&mode=delivery'); page.wait_for_timeout(800)
    check(page.is_visible('#doneView') and 'Already signed' in page.inner_text('#doneView') and not page.is_visible('#content'), 'gp-sign: second visit -> "Already signed", no pad')
    # second sign attempt from a page opened before the first signature -> refused (409)
    api.signed = {}
    page.goto('http://new.test/gp-sign.html?id=cl_test1&mode=delivery'); page.wait_for_timeout(700)
    api.signed = {'out': True}
    draw(page); page.check('#agree'); page.click('text=Submit signature'); page.wait_for_timeout(800)
    check('Already signed' in page.inner_text('#doneView') and page.is_visible('#doneView'), 'gp-sign: second signature refused by the server -> "Already signed"')
    check(not any(SB_HOST in r for r in reqs), 'gp-sign: nothing sent to Supabase')
    check(not errs, 'gp-sign: no page errors %s' % errs)
    ctx.close()

    # --- gp-qc driver link: load, upload a photo, save draft
    api = Api(); ctx = make_context(browser, api, sb=False)
    page, reqs, errs = new_page(ctx)
    page.goto('http://new.test/gp-qc.html?backend=cf&t=' + QC_TOKEN); page.wait_for_timeout(1200)
    c = [x for x in api.calls if x['path'].endswith('/qc_load')]
    check(c and c[0]['path'] == '/gp/public/rpc/qc_load' and c[0]['body'] == {'p_token': QC_TOKEN}, 'gp-qc driver: qc_load on /gp/public/rpc')
    check('QC CUSTOMER' in page.inner_text('body') or 'Alphard' in page.inner_text('body'), 'gp-qc driver: job shown')
    check(page.locator('#gpcf-block').count() == 0, 'gp-qc driver: no "not on the new system" notice')
    page.evaluate("() => { D.photos.push({ blob: new Blob(['jpeg'], {type:'image/jpeg'}), label: 'Front' }); }")
    page.evaluate("() => driverSave()"); page.wait_for_timeout(1200)
    up = [x for x in api.calls if x['path'] == '/gp/public/storage/upload']
    q = parse_qs(up[0]['query']) if up else {}
    check(up and q.get('t') == [QC_TOKEN] and q.get('path', [''])[0].startswith('qc1/out_photo_1_') and up[0]['auth'] is None and up[0]['ctype'] == 'image/jpeg', 'gp-qc driver: photo -> POST /gp/public/storage/upload?t=&path=qc1/..., no login')
    sv = [x for x in api.calls if x['path'].endswith('/qc_save_draft')]
    photos = (sv[0]['body'] or {}).get('p', {}).get('photos') if sv else None
    check(sv and sv[0]['path'] == '/gp/public/rpc/qc_save_draft' and photos and photos[0]['url'] == SIGNED, 'gp-qc driver: qc_save_draft public, photo = signed link of the upload (server stores the key)')
    check(not any(SB_HOST in r for r in reqs), 'gp-qc driver: nothing sent to Supabase %s' % [r for r in reqs if SB_HOST in r][:2])
    srcs = page.evaluate("() => [...document.querySelectorAll('img')].map(i => i.getAttribute('src')).filter(s => s && s.indexOf('/storage/v1/object/public/') >= 0)")
    check(not srcs, 'gp-qc driver: no thumbnail left pointing at the old storage %s' % srcs[:2])
    check(not errs, 'gp-qc driver: no page errors %s' % errs)
    page.close()
    # ops mode without login -> staff bar, list asks /gp/api/rpc/qc_list
    page, reqs, errs = new_page(ctx)
    page.goto('http://new.test/gp-qc.html'); page.wait_for_timeout(1200)
    check(page.locator('#gpcf-bar').count() == 1, 'gp-qc ops (no login): "not signed in" bar')
    ctx.close()

    # --- check-in view
    api = Api(); ctx = make_context(browser, api, sb=False)
    page, reqs, errs = new_page(ctx)
    page.goto('http://new.test/gp-checkin-view.html?backend=cf&t=ci_test1'); page.wait_for_timeout(1000)
    c = [x for x in api.calls if x['path'].endswith('/get_checkin')]
    check(c and c[0]['path'] == '/gp/public/rpc/get_checkin' and c[0]['body'] == {'p_token': 'ci_test1'}, 'gp-checkin-view: get_checkin on /gp/public/rpc')
    check('CHECKIN CUSTOMER' in page.inner_text('body') and page.locator('#mediaGrid img').count() == 1, 'gp-checkin-view: details + signed photo shown')
    check(page.locator('#gpcf-note').count() == 0 and not any(SB_HOST in r for r in reqs) and not errs, 'gp-checkin-view: no old note, no Supabase, no errors')
    page.goto('http://new.test/gp-checkin-view.html?t=bad_token'); page.wait_for_timeout(800)
    check(page.is_visible('#errorView'), 'gp-checkin-view: unknown token -> "Not found"')
    ctx.close()

    # --- damage approval
    api = Api(); ctx = make_context(browser, api, sb=False)
    page, reqs, errs = new_page(ctx)
    page.goto('http://new.test/gp-damage.html?backend=cf&id=' + DMG_ID); page.wait_for_timeout(1000)
    check('DAMAGE CUSTOMER' in page.inner_text('body') and 'RM 120' in page.inner_text('body'), 'gp-damage: charges shown (get_damage_approval, no login)')
    draw(page); page.check('#agree'); page.click('text=Agree & sign'); page.wait_for_timeout(800)
    s = [x for x in api.calls if x['path'].endswith('/submit_damage_approval')]
    check(s and s[0]['path'] == '/gp/public/rpc/submit_damage_approval' and s[0]['body']['p_job_id'] == DMG_ID and str(s[0]['body']['p_signature']).startswith('data:image/png'), 'gp-damage: submit_damage_approval public with signature')
    check(page.is_visible('#doneView'), 'gp-damage: "Thank you" after signing')
    page.goto('http://new.test/gp-damage.html?id=' + DMG_ID); page.wait_for_timeout(800)
    check(page.is_visible('#agreedView'), 'gp-damage: second visit -> "Already agreed"')
    check(not any(SB_HOST in r for r in reqs) and not errs, 'gp-damage: no Supabase, no errors %s' % errs)
    ctx.close()

    # --- staff: invite (Staff Manager via supa.js, employee app), push send, gp-booking, Hub forgot password
    api = Api(); ctx = make_context(browser, api, sb=False)
    page, reqs, errs = new_page(ctx)
    page.goto('http://new.test/index.html?backend=cf'); page.wait_for_timeout(600)
    page.evaluate("() => localStorage.setItem('gp_ba_token','tok-admin')")
    page.goto('http://new.test/staff-manager.html'); page.wait_for_timeout(800)
    r = page.evaluate("""async () => { await SUPA.init(); return await SUPA.inviteStaff({ email:'b@x.com', username:'bob', name:'Bob', role:'Staff', company:'Grandpride', title:'Driver', can_drive:true, apps:['attendance'] }); }""")
    inv = [x for x in api.calls if x['path'] == '/gp/api/admin/invite']
    check(r.get('ok') and inv and inv[0]['auth'] == 'Bearer tok-admin' and inv[0]['body'] == {'email': 'b@x.com', 'username': 'bob', 'name': 'Bob', 'role': 'Staff', 'profile': {'company': 'Grandpride', 'title': 'Driver', 'can_drive': True, 'apps': ['attendance']}}, 'staff-manager: Invite -> POST /gp/api/admin/invite (profile fields nested)')
    page.goto('http://new.test/set-password.html'); page.wait_for_timeout(800)
    check('First time? / Forgot password?' in page.inner_text('body') and not page.is_visible('#form'), 'set-password: points to the Hub code flow on the new system')
    page.goto('http://new.test/gp-fleet.html'); page.wait_for_timeout(800)
    page.evaluate("() => sendPush('VAA 1 Alphard','Road tax due in 7 days')"); page.wait_for_timeout(400)
    ps = [x for x in api.calls if x['path'] == '/gp/api/push/send']
    check(ps and ps[-1]['auth'] == 'Bearer tok-admin' and ps[-1]['body'] == {'title': '🚗 VAA 1 Alphard', 'body': 'Road tax due in 7 days', 'target': 'all'}, 'gp-fleet: reminder push -> POST /gp/api/push/send')
    check(not any('/functions/v1/push-send' in r for r in reqs), 'gp-fleet: Supabase push-send not called')
    check(page.evaluate("() => GPCF_PAGE.checkinShareLink('ci_x1')") == 'http://new.test/gp-checkin-view.html?t=ci_x1', 'gp-jobs / gp-checklist: customer check-in link -> gp-checkin-view.html?t= (checkin-share not on the Worker yet)')
    page.goto('http://new.test/index.html'); page.wait_for_timeout(1500)
    page.evaluate("() => pushNotify('Hello','World','ali')"); page.wait_for_timeout(400)
    ps = [x for x in api.calls if x['path'] == '/gp/api/push/send']
    check(ps and ps[-1]['body'] == {'title': 'Hello', 'body': 'World', 'target': 'ali'}, 'Hub: pushNotify -> POST /gp/api/push/send')
    page.goto('http://new.test/gp-vehicle-use.html'); page.wait_for_timeout(800)
    page.evaluate("() => pushNotify('Car out','VAA 1','all')"); page.wait_for_timeout(400)
    ps = [x for x in api.calls if x['path'] == '/gp/api/push/send']
    check(ps and ps[-1]['body'] == {'title': 'Car out', 'body': 'VAA 1', 'target': 'all'}, 'gp-vehicle-use: push -> POST /gp/api/push/send')
    n0 = len(api.calls)
    page.goto('http://new.test/gp-booking.html'); page.wait_for_timeout(1200)
    db = [x['body'] for x in api.calls[n0:] if x['path'] == '/gp/api/db']
    check(any(b.get('table') == 'gp_fleet' for b in db) and any(b.get('table') == 'gp_staff' for b in db) and all(x['auth'] == 'Bearer tok-admin' for x in api.calls[n0:] if x['path'] == '/gp/api/db'), 'gp-booking: loads fleet + chauffeurs from /gp/api/db with the staff login')
    check(page.locator('#gpcf-note').count() == 0 and page.locator('#gpcf-pill').count() == 1, 'gp-booking: old note gone, NEW SYSTEM tag shown (device switched by hand)')
    page.evaluate("() => setChauffeurOutside('abu','VIP job')"); page.wait_for_timeout(500)
    db = [x['body'] for x in api.calls[n0:] if x['path'] == '/gp/api/db']
    check(any(b.get('table') == 'gp_staff' and b.get('op') == 'update' and b.get('values', {}).get('chauffeur_status') == 'outside' for b in db) and any(b.get('table') == 'gp_chauffeur_log' and b.get('op') == 'insert' for b in db), 'gp-booking: assign chauffeur -> gp_staff update + gp_chauffeur_log insert')
    check(not any(SB_HOST in r for r in reqs), 'staff pages: nothing sent to Supabase')
    page.close()
    # employee app: invite + push + approve / reject
    page, reqs, errs = new_page(ctx)
    page.goto('http://new.test/employee/index.html'); page.wait_for_timeout(1500)
    r = page.evaluate("async () => await callInvite({ email:'c@x.com', username:'cat', name:'Cat', role:'Staff', existing:false, profile:{ title:'Ops' } })")
    inv = [x for x in api.calls if x['path'] == '/gp/api/admin/invite']
    check(r.get('ok') and inv[-1]['body'] == {'email': 'c@x.com', 'username': 'cat', 'name': 'Cat', 'role': 'Staff', 'existing': False, 'profile': {'title': 'Ops'}}, 'employee: Invite -> POST /gp/api/admin/invite')
    page.evaluate("() => pushNotify('Hi','there','ali')"); page.wait_for_timeout(300)
    check([x for x in api.calls if x['path'] == '/gp/api/push/send'][-1]['body'] == {'title': 'Hi', 'body': 'there', 'target': 'ali'}, 'employee: pushNotify -> POST /gp/api/push/send')
    page.evaluate("""() => { ME = ME || {username:'ali', name:'Ali', role:'Admin'}; PENDING_SIGNUPS = [{id:'app-1', name:'New Guy', email:'new@x.com', phone:'012', company:'Grandpride', role_req:'staff'}];
      document.body.insertAdjacentHTML('beforeend', '<input id="sgU_app-1" value="newguy"><select id="sgT_app-1"><option selected>Chauffeur</option></select><select id="sgR_app-1"><option value="ali" selected>Ali</option></select><input id="sgJ_app-1" value="2026-11-23"><select id="sgL_app-1"><option selected>Staff</option></select>');
      window.openApprovals = async () => {}; }""")
    page.evaluate("() => approveSignup('app-1')"); page.wait_for_timeout(800)
    ap = [x for x in api.calls if x['path'] == '/gp/api/admin/signups/approve']
    check(ap and ap[0]['body'] == {'id': 'app-1', 'username': 'newguy', 'title': 'Chauffeur', 'level': 'Staff', 'reports_to': ['ali'], 'join': '2026-11-23', 'company': 'Grandpride'}, 'employee: Approve -> POST /gp/api/admin/signups/approve')
    page.evaluate("() => { PENDING_SIGNUPS=[{id:'app-2', name:'X'}]; window.prompt = () => 'not now'; return rejectSignup('app-2'); }"); page.wait_for_timeout(500)
    rj = [x for x in api.calls if x['path'] == '/gp/api/admin/signups/reject']
    check(rj and rj[0]['body'] == {'id': 'app-2', 'note': 'not now'}, 'employee: Reject -> POST /gp/api/admin/signups/reject')
    check(not any(SB_HOST in r for r in reqs) and not errs, 'employee (staff): no Supabase, no page errors %s' % errs[:2])
    ctx.close()

    # --- employee self sign-up (no login)
    api = Api(); ctx = make_context(browser, api, sb=False)
    page, reqs, errs = new_page(ctx)
    page.goto('http://new.test/employee/index.html?backend=cf'); page.wait_for_timeout(1500)
    api.rpc_staff = False
    orig_rpc = api.rpc
    api.rpc = lambda n, a: False if n == 'staff_email_exists' else orig_rpc(n, a)
    page.click('#goSignup'); page.fill('#suEmail', 'new@x.com'); page.click('#suSend'); page.wait_for_timeout(800)
    st = [x for x in api.calls if x['path'] == '/gp/public/signup/start']
    check(st and st[0]['body'] == {'email': 'new@x.com'} and st[0]['auth'] is None, 'sign-up: POST /gp/public/signup/start (no login)')
    page.fill('#suCode', '123456'); page.click('#suVerify'); page.wait_for_timeout(800)
    so = [x for x in api.calls if x['path'] == '/gp/auth/sign-in/email-otp']
    check(so and so[0]['body'] == {'email': 'new@x.com', 'otp': '123456'} and page.evaluate("() => localStorage.getItem('gp_ba_token')") == 'tok-email-otp', 'sign-up: code -> /gp/auth/sign-in/email-otp, login kept')
    page.fill('#suName', 'New Guy'); page.fill('#suPhone', '0123456789'); page.fill('#suPass', 'secret1'); page.fill('#suPass2', 'secret1')
    page.click('#suNext3'); page.wait_for_timeout(400)
    page.click('.role-card[data-role="chauffeur"]'); page.click('#suSubmit'); page.wait_for_timeout(1000)
    sm = [x for x in api.calls if x['path'] == '/gp/api/signup/submit']
    check(sm and sm[0]['auth'] == 'Bearer tok-email-otp' and sm[0]['body'].get('role_req') == 'chauffeur' and sm[0]['body'].get('password') == 'secret1' and sm[0]['body'].get('name') == 'New Guy', 'sign-up: POST /gp/api/signup/submit {name, phone, company, role_req, password}')
    check(page.evaluate("() => document.getElementById('sPending').classList.contains('active') && document.getElementById('pdTitle').textContent") == 'Waiting for approval', 'sign-up: "Waiting for approval" screen')
    check(not any('/gp/api/push/send' == x['path'] for x in api.calls), 'sign-up: page does not push itself (server tells the approver)')
    check(not any(SB_HOST in r for r in reqs) and not errs, 'sign-up: no Supabase, no page errors %s' % errs[:2])
    ctx.close()

    # --- forgot password: employee app and Hub
    api = Api(); ctx = make_context(browser, api, sb=False)
    page, reqs, errs = new_page(ctx)
    page.goto('http://new.test/employee/index.html?backend=cf'); page.wait_for_timeout(1500)
    page.click('#goForgot'); page.fill('#fgEmail', 'ali@x.com'); page.click('#fgSend'); page.wait_for_timeout(700)
    paths = [x['path'] for x in api.calls]
    check('/gp/public/rpc/staff_email_exists' in paths and '/gp/auth/email-otp/request-password-reset' in paths, 'employee forgot: staff check (public RPC) + reset code requested')
    page.fill('#fgCode', '654321'); page.click('#fgVerify'); page.wait_for_timeout(600)
    page.fill('#fgPass', 'newpass1'); page.fill('#fgPass2', 'newpass1'); page.click('#fgSave'); page.wait_for_timeout(1200)
    rp = [x for x in api.calls if x['path'] == '/gp/auth/email-otp/reset-password']
    check(rp and rp[0]['body'] == {'email': 'ali@x.com', 'otp': '654321', 'password': 'newpass1'} and page.evaluate("() => localStorage.getItem('gp_ba_token')") == 'tok-email', 'employee forgot: reset-password then signed in')
    page.close()
    page, reqs, errs = new_page(ctx)
    page.evaluate("() => 0")
    page.goto('http://new.test/index.html'); page.wait_for_timeout(300)
    page.evaluate("() => localStorage.removeItem('gp_ba_token')")
    page.goto('http://new.test/index.html'); page.wait_for_timeout(1500)
    n0 = len(api.calls)
    page.click('#firstTimeLink'); page.fill('#otpEmail', 'ali@x.com'); page.click('#btnSendOtp'); page.wait_for_timeout(700)
    page.fill('#otpCode', '111222'); page.click('#btnVerifyOtp'); page.wait_for_timeout(700)
    page.fill('#spPass', 'hubpass1'); page.fill('#spPass2', 'hubpass1'); page.click('#btnSetPw'); page.wait_for_timeout(1200)
    paths = [x['path'] for x in api.calls[n0:]]
    rp = [x for x in api.calls[n0:] if x['path'] == '/gp/auth/email-otp/reset-password']
    check('/gp/public/rpc/staff_email_exists' in paths and '/gp/auth/email-otp/request-password-reset' in paths and '/gp/auth/email-otp/check-verification-otp' in paths and rp and rp[0]['body'] == {'email': 'ali@x.com', 'otp': '111222', 'password': 'hubpass1'}, 'Hub "First time / Forgot password": code -> check -> reset-password')
    check('Password set' in page.inner_text('body'), 'Hub forgot: "Password set! Please sign in" shown')
    check(not any(SB_HOST in r for r in reqs) and not errs, 'forgot: no Supabase, no page errors %s' % errs[:2])
    ctx.close()


STAFF_PAGES = ['index.html', 'staff-manager.html', 'stock-report.html', 'employee/index.html', 'gp-agreement.html', 'gp-appointment.html',
               'gp-booking.html', 'gp-chauffeur-hod.html', 'gp-chauffeur.html', 'gp-checklist.html', 'gp-daily-update.html',
               'gp-deposit-return.html', 'gp-fleet.html', 'gp-jobs.html', 'gp-marketing.html', 'gp-minigames.html', 'gp-qc.html',
               'gp-record-summary.html', 'gp-vehicle-fleet.html', 'gp-vehicle-use.html']


def run_staff_smoke(browser):
    print('\n== 2b. switch ON, signed in: every staff page loads on the new backend only')
    api = Api(); ctx = make_context(browser, api, sb=False)
    page, reqs, errs = new_page(ctx)
    page.goto('http://new.test/index.html?backend=cf'); page.wait_for_timeout(300)
    page.evaluate("() => localStorage.setItem('gp_ba_token','tok-admin')")
    page.close()
    for pg in STAFF_PAGES:
        page, reqs, errs = new_page(ctx)
        cons = []
        page.on('console', lambda m: cons.append(m.text))
        n0 = len(api.calls)
        page.goto('http://new.test/' + pg); page.wait_for_timeout(2000)
        mine = api.calls[n0:]
        sbreq = [r for r in reqs if SB_HOST in r and '/functions/v1/' not in r]
        uns = [c for c in cons if 'not supported' in c]
        noauth = [x['path'] for x in mine if x['path'].startswith('/gp/api/') and x['auth'] != 'Bearer tok-admin']
        check(not sbreq and not uns and not errs and not noauth,
              '%s: %d API calls (%s), no Supabase, no "not supported", no errors %s' % (pg, len(mine), ','.join(sorted(set((x['body'] or {}).get('table') or x['path'].rsplit('/', 1)[1] for x in mine)))[:120], (sbreq + uns + errs + noauth)[:3]))
        page.close()
    ctx.close()


def run_default(browser):
    print('\n== 3. GP_BACKEND_DEFAULT = "cf" (no ?backend=cf anywhere)')
    api = Api(); ctx = make_context(browser, api, sb=True, golive_default='cf')
    page, reqs, errs = new_page(ctx)
    page.goto('http://golive.test/gp-fleet.html'); page.wait_for_timeout(1000)
    check(cf_requests(reqs) and page.evaluate("() => localStorage.getItem('gp_backend')") is None, 'gp-fleet: new backend by default, nothing stored on the device')
    check(page.locator('#gpcf-pill').count() == 0, 'gp-fleet: no NEW SYSTEM tag when everyone is on it')
    page.close()
    page, reqs, errs = new_page(ctx)
    page.goto('http://golive.test/gp-sign.html?id=cl_test1'); page.wait_for_timeout(1000)
    check('SIGN CUSTOMER' in page.inner_text('body') and any('/gp/public/rpc/gp_sign_load' in r for r in reqs) and not any(SB_HOST in r for r in reqs), 'gp-sign (customer phone, fresh): new public route by default')
    page.close()
    for path, probe in [('index.html', "() => SUPA.backend()"), ('employee/index.html', "() => gpUseCf() ? 'cf' : 'sb'"),
                        ('staff-manager.html', "() => SUPA.backend()")]:
        page, reqs, errs = new_page(ctx)
        page.goto('http://golive.test/' + path); page.wait_for_timeout(1200)
        check(page.evaluate(probe) == 'cf', '%s: new backend by default' % path)
        page.close()
    page, reqs, errs = new_page(ctx)
    page.goto('http://golive.test/gp-damage.html?id=' + DMG_ID); page.wait_for_timeout(900)
    check('DAMAGE CUSTOMER' in page.inner_text('body'), 'gp-damage: new public route by default')
    page.close()
    # emergency fallback on one device
    page, reqs, errs = new_page(ctx)
    page.goto('http://golive.test/gp-fleet.html?backend=sb'); page.wait_for_timeout(1000)
    check(not cf_requests(reqs) and page.evaluate("() => localStorage.getItem('gp_backend')") == 'sb', 'gp-fleet ?backend=sb: old system, choice remembered')
    page.close()
    for path, probe in [('index.html', "() => SUPA.backend()"), ('employee/index.html', "() => gpUseCf() ? 'cf' : 'sb'")]:
        page, reqs, errs = new_page(ctx)
        page.goto('http://golive.test/' + path); page.wait_for_timeout(1000)
        check(page.evaluate(probe) == 'sb', '%s after ?backend=sb: stays on the old system' % path)
        page.close()
    page, reqs, errs = new_page(ctx)
    page.goto('http://golive.test/gp-sign.html?id=cl_test1'); page.wait_for_timeout(900)
    check('SB CUSTOMER' in page.inner_text('body') and not cf_requests(reqs), 'gp-sign after ?backend=sb: old system (Supabase)')
    page.close()
    page, reqs, errs = new_page(ctx)
    page.goto('http://golive.test/gp-fleet.html?backend=auto'); page.wait_for_timeout(900)
    check(cf_requests(reqs) and page.evaluate("() => localStorage.getItem('gp_backend')") is None, '?backend=auto: back to the default (new backend)')
    page.close()
    ctx.close()


with sync_playwright() as p:
    browser = p.chromium.launch()
    only = os.environ.get('ONLY', '')
    if not only or '1' in only: run_off(browser)
    if not only or '2' in only: run_on(browser); run_staff_smoke(browser)
    if not only or '3' in only: run_default(browser)
    browser.close()

print('\n%d failure(s)' % len(FAILS))
for f in FAILS:
    print('  - ' + f)
sys.exit(1 if FAILS else 0)
