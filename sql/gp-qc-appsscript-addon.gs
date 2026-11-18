/* ============================================================
   GP QC — add-on for the GP Checklist Apps Script
   ------------------------------------------------------------
   PASTE THIS AT THE BOTTOM of your existing script, then change
   ONE line (see step 2 at the end). Nothing else is touched, so
   any edits you have made since September are safe.

   What it does
   ------------
   The QC app uploads photos and video to the Supabase checkins
   bucket, so the phone has already done the heavy lifting. This
   makes Apps Script pull those files down from their public URLs
   and drop them in the job's Drive folder, instead of the driver
   uploading everything a second time over mobile data.

   Result, in the folder you already use:

     Car Leasing / NOV 2026 / AHMAD_URUS_VNS31_20261119 /
         DELIVERED_AHMAD_URUS_VNS31_20261119_LEASING.pdf
         Photos - DELIVERED .../  rim_1.jpg, side_2.jpg, walkaround.webm …
   ============================================================ */


/* Pull the QC photos and video out of Supabase storage and into the
   job folder. d.photo_urls is [{label, url}, ...] sent by gp-qc.html.
   Returns the folder URL, or '' when there is nothing to save. */
function savePhotosFromUrls_(d, name, destFolder) {
  var list = d.photo_urls || [];
  if (!list.length) return '';

  // Keep them beside the PDF, in a clearly named subfolder.
  var parent = destFolder || DriveApp.getFolderById(PHOTOS_FOLDER_ID);
  var sub = childFolder_(parent, 'Photos - ' + name);

  var saved = 0, failed = 0;
  for (var i = 0; i < list.length; i++) {
    var item = list[i] || {};
    var url = item.url || '';
    if (!url) continue;
    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) { failed++; continue; }

      var blob = resp.getBlob();
      // Name it after what it is, not the random storage key.
      var ext = (url.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
      if (ext.length > 5) ext = 'jpg';
      var label = String(item.label || ('photo_' + (i + 1)))
                    .replace(/[^\w\- ]+/g, '_').trim();
      blob.setName(label + '_' + (i + 1) + '.' + ext);

      sub.createFile(blob);
      saved++;
    } catch (e) {
      failed++;   // one bad file must not lose the rest
    }
  }

  if (saved === 0) { try { sub.setTrashed(true); } catch (e) {} return ''; }
  try { sub.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  if (failed) Logger.log('savePhotosFromUrls_: ' + failed + ' of ' + list.length + ' could not be fetched');
  return sub.getUrl();
}


/* Photos arrive one of two ways now:
     - QC app      -> d.photo_urls  (already in Supabase storage)
     - old app     -> d.photos      (base64 straight from the phone)
   This picks whichever is present, so both keep working. */
function savePhotosAny_(d, name, destFolder) {
  if (d.photo_urls && d.photo_urls.length) {
    return savePhotosFromUrls_(d, name, destFolder);
  }
  return savePhotos(d, name);
}


/* ============================================================
   STEP 2 — the one line to change
   ------------------------------------------------------------
   In generateChecklistPdf (around line 262) find:

       var photosUrl = savePhotos(d, name);

   and change it to:

       var photosUrl = savePhotosAny_(d, name, destFolder);

   That is the whole change. The old checklist app sends d.photos
   and still goes down the original path; the QC app sends
   d.photo_urls and goes down the new one.

   Then: Deploy -> Manage deployments -> pencil -> New version.
   NOT a new deployment, or the /exec URL changes and both the QC
   app and the agreement edge function stop working.
   ============================================================ */
