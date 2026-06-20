/**
 * =====================================================================
 * IBI Messenger  —  Google Apps Script Backend (Two-way chat)
 * =====================================================================
 * Two-way chat between owner and staff, all stored in a Google Sheet.
 * Image attachments are uploaded to a Drive folder and referenced by ID.
 *
 * ENDPOINTS
 * ---------
 *   POST  /exec                       → send a message (text + optional image)
 *   GET   /exec?action=fetch&since=…  → fetch messages newer than given ISO ts
 *   GET   /exec?action=fetch          → fetch most recent N messages
 *   GET   /exec                       → status page
 *
 * ---------------------------------------------------------------------
 * ONE-TIME SETUP
 * ---------------------------------------------------------------------
 * 1. Create a new Google Sheet (https://sheets.new). Name it
 *    "IBI Messenger Data".
 * 2. Copy its ID from the URL:
 *      https://docs.google.com/spreadsheets/d/{THIS_PART_IS_THE_ID}/edit
 *    Paste it into CONFIG.SHEET_ID below.
 * 3. (Optional) Create a Drive folder for image attachments. Paste its
 *    ID into CONFIG.ATTACHMENTS_FOLDER_ID. If you leave it blank, the
 *    script will auto-create one called "IBI Messenger Attachments".
 * 4. Open Apps Script editor (https://script.google.com), paste this
 *    file in.
 * 5. Deploy → Manage deployments → ✏️ existing deployment → New version
 *    → Deploy. (Or New deployment if you don't have one yet — Web app,
 *    Execute as: Me, Who has access: Anyone.)
 * 6. The /exec URL stays the same. No frontend redeploy needed unless
 *    you change the URL.
 * ---------------------------------------------------------------------
 */

const CONFIG = {
  // Google Sheet that stores all messages (REQUIRED).
  SHEET_ID: '1sFv6ZaEiKbMXHbMPq9yAWlcK6tW6b1Dt9AXv0unn3sM',

  // Tab/sheet name within the spreadsheet.
  SHEET_NAME: 'Messages',

  // Drive folder ID for image attachments. Leave blank to auto-create.
  ATTACHMENTS_FOLDER_ID: '',

  // Default folder name when auto-creating.
  ATTACHMENTS_FOLDER_NAME: 'IBI Messenger Attachments',

  TIMEZONE: 'Asia/Kolkata',
  MAX_LENGTH: 50000,
  FETCH_DEFAULT_LIMIT: 100,
  FETCH_MAX_LIMIT: 500,

  BRAND_COLOR: '#00c5ff'
};

const SHEET_HEADERS = [
  'messageId',   // unique ID generated client-side (for dedup)
  'timestamp',   // ISO 8601 server timestamp (when row was written)
  'sender',      // human-readable name (e.g. "Owner", "Aswin")
  'senderId',    // unique device/user ID (for "is this mine" check)
  'type',        // 'text' | 'image' | 'image+text'
  'text',        // message body
  'imageId',     // Drive file ID (empty if no image)
  'imageName',   // original filename
  'imageW',      // image width in px
  'imageH',      // image height in px
  'userAgent',   // for diagnostics
  'phone',       // sender's phone number (E.164, e.g. +919876543210) — for tap-to-call
  'deletedAt',   // ISO timestamp when message was deleted (empty if not deleted)
  'editedAt',    // ISO timestamp when message was last edited (empty if never edited)
  'replyTo',     // JSON string of quoted message: {messageId, sender, text, hasImage}
  'reactions',   // JSON string: { "👍": ["senderId1","senderId2"], "❤️": ["senderId3"] }
  'pinnedAt',    // ISO timestamp when message was pinned (empty if not pinned)
  'attachment'   // JSON string for non-image files: {kind,fileId,name,mime,size,duration}
];

/* =====================================================================
   ROUTING
   ===================================================================== */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return _json({ ok: false, error: 'No request body received.' });
    }
    let payload;
    try { payload = JSON.parse(e.postData.contents); }
    catch (err) { return _json({ ok: false, error: 'Invalid JSON body.' }); }

    const action = (payload.action || 'send').toLowerCase();
    if (action === 'delete')    return _handleDelete(payload);
    if (action === 'edit')      return _handleEdit(payload);
    if (action === 'editimage') return _handleEditImage(payload);
    if (action === 'markseen')  return _handleMarkSeen(payload);
    if (action === 'react')     return _handleReact(payload);
    if (action === 'pin')       return _handlePin(payload);
    if (action === 'updatelocation') return _handleUpdateLocation(payload);
    return _handleSend(payload);
  } catch (err) {
    return _json({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
}

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = (params.action || 'status').toLowerCase();
    if (action === 'fetch')    return _handleFetch(params);
    if (action === 'receipts') return _handleGetReceipts(params);
    if (action === 'media')    return _handleMedia(params);
    return _statusPage();
  } catch (err) {
    return _json({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
}

/* =====================================================================
   SEND  —  appends a message row to the Sheet
   ===================================================================== */
function _handleSend(payload) {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    return _json({ ok: false, error: 'Server not configured: SHEET_ID is not set.' });
  }

  const messageId = _str(payload.messageId, 100);
  const sender    = _str(payload.sender, 200).trim();
  const senderId  = _str(payload.senderId, 100);
  const text      = _str(payload.text || payload.message, CONFIG.MAX_LENGTH).trim();
  const userAgent = _str(payload.userAgent, 500);
  const phone     = _normalizePhone(_str(payload.phone, 30));
  const image     = payload.image || null;
  const fileAttach = payload.attachment || null; // {kind,base64,mime,name,size,duration}

  if (!messageId) return _json({ ok: false, error: 'Missing messageId.' });
  if (!sender)    return _json({ ok: false, error: 'Missing sender name.' });
  if (!text && !image && !fileAttach) return _json({ ok: false, error: 'Empty message.' });

  // --- Upload image if present ---
  let imageId = '', imageName = '', imageW = '', imageH = '';
  if (image && image.base64) {
    try {
      const upload = _uploadImageToDrive(image, sender);
      imageId   = upload.fileId;
      imageName = (image.name || 'attachment.jpg').toString().substring(0, 200);
      imageW    = image.width  || '';
      imageH    = image.height || '';
    } catch (imgErr) {
      return _json({ ok: false, error: 'Image upload failed: ' + imgErr.message });
    }
  }

  // --- Generic attachment: location (no upload) or file (Drive upload) ---
  let attachmentJson = '';
  if (fileAttach && fileAttach.kind === 'location') {
    // Location pin — just coordinates, no Drive upload
    attachmentJson = JSON.stringify({
      kind: 'location',
      lat: Number(fileAttach.lat) || 0,
      lng: Number(fileAttach.lng) || 0,
      accuracy: Number(fileAttach.accuracy) || 0,
      live: !!fileAttach.live,
      liveUntil: _str(fileAttach.liveUntil, 40),
      updatedAt: new Date().toISOString(),
      label: _str(fileAttach.label, 120)
    });
  } else if (fileAttach && fileAttach.kind === 'call') {
    // Call invite — just a room reference, no Drive upload
    attachmentJson = JSON.stringify({
      kind: 'call',
      room: _str(fileAttach.room, 120),
      mode: (fileAttach.mode === 'video') ? 'video' : 'audio',
      by: _str(fileAttach.by, 120),
      startedAt: new Date().toISOString()
    });
  } else if (fileAttach && fileAttach.kind === 'product') {
    // Product card — catalog item shared into the chat, no Drive upload
    attachmentJson = JSON.stringify({
      kind: 'product',
      name: _str(fileAttach.name, 160),
      price: _str(fileAttach.price, 40),
      category: _str(fileAttach.category, 60),
      desc: _str(fileAttach.desc, 400),
      by: _str(fileAttach.by, 120)
    });
  } else if (fileAttach && fileAttach.base64) {
    try {
      const up = _uploadFileToDrive(fileAttach, sender);
      attachmentJson = JSON.stringify({
        kind: _str(fileAttach.kind, 20) || 'document',
        fileId: up.fileId,
        name: (fileAttach.name || 'file').toString().substring(0, 200),
        mime: (fileAttach.mime || 'application/octet-stream').toString().substring(0, 100),
        size: fileAttach.size || 0,
        duration: fileAttach.duration || 0
      });
    } catch (fErr) {
      return _json({ ok: false, error: 'File upload failed: ' + fErr.message });
    }
  }

  // --- Append row ---
  const sheet = _getSheet();
  const timestampDate = new Date();          // Date object — Sheet displays it via column format
  const timestamp = timestampDate.toISOString(); // ISO string for the API response
  let type = imageId ? (text ? 'image+text' : 'image') : 'text';
  if (attachmentJson) type = text ? 'file+text' : 'file';

  const replyToRaw = _str(payload.replyTo, 2000).trim();

  sheet.appendRow([
    messageId, timestampDate, sender, senderId,
    type, text,
    imageId, imageName, imageW, imageH,
    userAgent, phone, '', '', replyToRaw, '', '', attachmentJson
  ]);
  SpreadsheetApp.flush();

  return _json({
    ok: true,
    messageId: messageId,
    timestamp: timestamp,
    imageId: imageId,
    attachment: attachmentJson,
    sender: sender,
    phone: phone
  });
}

/* =====================================================================
   DELETE  —  marks a message row as deleted (other clients pick this up
   on their next poll and remove the bubble from local view).
   The row stays in the sheet as a tombstone (text/image cleared, deletedAt
   set). The image file in Drive is moved to trash.
   ===================================================================== */
function _handleDelete(payload) {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    return _json({ ok: false, error: 'Server not configured: SHEET_ID is not set.' });
  }
  const messageId = _str(payload.messageId, 100);
  if (!messageId) return _json({ ok: false, error: 'Missing messageId.' });

  const sheet = _getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return _json({ ok: false, error: 'Message not found.' });

  // Find the row by messageId (column 1)
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let rowIdx = -1;
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === messageId) { rowIdx = i + 2; break; }
  }
  if (rowIdx === -1) return _json({ ok: false, error: 'Message not found.' });

  // Read the row to check for image + see if already deleted
  const rowVals = sheet.getRange(rowIdx, 1, 1, SHEET_HEADERS.length).getValues()[0];
  const m = _rowToMessage(rowVals);
  if (m.deletedAt) {
    return _json({ ok: true, alreadyDeleted: true, messageId: messageId, deletedAt: m.deletedAt });
  }

  // Trash the Drive image (if any)
  if (m.imageId) {
    try {
      const file = DriveApp.getFileById(m.imageId);
      file.setTrashed(true);
    } catch (e) {
      Logger.log('Could not trash image ' + m.imageId + ': ' + e.message);
    }
  }

  // Clear sensitive fields and set deletedAt
  const deletedAtDate = new Date();
  const deletedAt = deletedAtDate.toISOString();
  const colText      = SHEET_HEADERS.indexOf('text') + 1;
  const colImageId   = SHEET_HEADERS.indexOf('imageId') + 1;
  const colImageName = SHEET_HEADERS.indexOf('imageName') + 1;
  const colImageW    = SHEET_HEADERS.indexOf('imageW') + 1;
  const colImageH    = SHEET_HEADERS.indexOf('imageH') + 1;
  const colDeletedAt = SHEET_HEADERS.indexOf('deletedAt') + 1;

  sheet.getRange(rowIdx, colText).setValue('');
  sheet.getRange(rowIdx, colImageId).setValue('');
  sheet.getRange(rowIdx, colImageName).setValue('');
  sheet.getRange(rowIdx, colImageW).setValue('');
  sheet.getRange(rowIdx, colImageH).setValue('');
  sheet.getRange(rowIdx, colDeletedAt).setValue(deletedAtDate);
  SpreadsheetApp.flush();

  return _json({ ok: true, messageId: messageId, deletedAt: deletedAt });
}

/* =====================================================================
   EDIT  —  updates the text of an existing message row and sets editedAt.
   ===================================================================== */
function _handleEdit(payload) {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    return _json({ ok: false, error: 'Server not configured: SHEET_ID is not set.' });
  }
  const messageId = _str(payload.messageId, 100);
  const newText   = _str(payload.newText || payload.text, CONFIG.MAX_LENGTH).trim();
  if (!messageId) return _json({ ok: false, error: 'Missing messageId.' });
  if (!newText)   return _json({ ok: false, error: 'Edited text cannot be empty.' });

  const sheet = _getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return _json({ ok: false, error: 'Message not found.' });

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let rowIdx = -1;
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === messageId) { rowIdx = i + 2; break; }
  }
  if (rowIdx === -1) return _json({ ok: false, error: 'Message not found.' });

  const editedAtDate = new Date();
  const colText     = SHEET_HEADERS.indexOf('text') + 1;
  const colEditedAt = SHEET_HEADERS.indexOf('editedAt') + 1;
  sheet.getRange(rowIdx, colText).setValue(newText);
  sheet.getRange(rowIdx, colEditedAt).setValue(editedAtDate);
  SpreadsheetApp.flush();
  return _json({ ok: true, messageId: messageId, editedAt: editedAtDate.toISOString() });
}

/* =====================================================================
   EDIT IMAGE  —  replaces the image of an existing message (e.g. after a crop).
   Uploads the new image to Drive, swaps the row's imageId/dimensions,
   trashes the old Drive file, and sets editedAt so other devices refresh.
   ===================================================================== */
function _handleEditImage(payload) {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    return _json({ ok: false, error: 'Server not configured: SHEET_ID is not set.' });
  }
  const messageId = _str(payload.messageId, 100);
  const image     = payload.image || null;
  if (!messageId) return _json({ ok: false, error: 'Missing messageId.' });
  if (!image || !image.base64) return _json({ ok: false, error: 'Missing image data.' });

  const sheet = _getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return _json({ ok: false, error: 'Message not found.' });

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let rowIdx = -1;
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === messageId) { rowIdx = i + 2; break; }
  }
  if (rowIdx === -1) return _json({ ok: false, error: 'Message not found.' });

  const colImageId   = SHEET_HEADERS.indexOf('imageId') + 1;
  const colImageName = SHEET_HEADERS.indexOf('imageName') + 1;
  const colImageW    = SHEET_HEADERS.indexOf('imageW') + 1;
  const colImageH    = SHEET_HEADERS.indexOf('imageH') + 1;
  const colType      = SHEET_HEADERS.indexOf('type') + 1;
  const colEditedAt  = SHEET_HEADERS.indexOf('editedAt') + 1;
  const colSender    = SHEET_HEADERS.indexOf('sender') + 1;
  const colTextCell  = SHEET_HEADERS.indexOf('text') + 1;

  const sender = String(sheet.getRange(rowIdx, colSender).getValue() || 'Unknown');

  // Upload the new (cropped) image
  let upload;
  try {
    upload = _uploadImageToDrive(image, sender);
  } catch (imgErr) {
    return _json({ ok: false, error: 'Image upload failed: ' + imgErr.message });
  }

  // Trash the old Drive file
  const oldImageId = String(sheet.getRange(rowIdx, colImageId).getValue() || '');
  if (oldImageId) {
    try { DriveApp.getFileById(oldImageId).setTrashed(true); } catch (_) {}
  }

  // Swap in the new image
  const editedAtDate = new Date();
  const existingText = String(sheet.getRange(rowIdx, colTextCell).getValue() || '');
  sheet.getRange(rowIdx, colImageId).setValue(upload.fileId);
  sheet.getRange(rowIdx, colImageName).setValue((image.name || 'cropped.jpg').toString().substring(0, 200));
  sheet.getRange(rowIdx, colImageW).setValue(image.width || '');
  sheet.getRange(rowIdx, colImageH).setValue(image.height || '');
  sheet.getRange(rowIdx, colType).setValue(existingText ? 'image+text' : 'image');
  sheet.getRange(rowIdx, colEditedAt).setValue(editedAtDate);
  SpreadsheetApp.flush();

  return _json({
    ok: true,
    messageId: messageId,
    imageId: upload.fileId,
    imageW: image.width || '',
    imageH: image.height || '',
    editedAt: editedAtDate.toISOString()
  });
}

/* =====================================================================
   REACT  —  toggles an emoji reaction on a message for one viewer.
   reactions column stores JSON: { "👍": ["senderIdA"], "❤️": ["senderIdB"] }
   Sets editedAt so the change propagates to other devices via polling.
   ===================================================================== */
function _handleReact(payload) {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    return _json({ ok: false, error: 'Server not configured.' });
  }
  const messageId = _str(payload.messageId, 100);
  const emoji     = _str(payload.emoji, 16);
  const viewerId  = _str(payload.viewerId, 100);
  if (!messageId || !emoji || !viewerId) return _json({ ok: false, error: 'Missing field.' });

  const sheet = _getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return _json({ ok: false, error: 'Message not found.' });
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let rowIdx = -1;
  for (let i = 0; i < ids.length; i++) { if (String(ids[i][0]) === messageId) { rowIdx = i + 2; break; } }
  if (rowIdx === -1) return _json({ ok: false, error: 'Message not found.' });

  const colReactions = SHEET_HEADERS.indexOf('reactions') + 1;
  const colEditedAt  = SHEET_HEADERS.indexOf('editedAt') + 1;
  const raw = String(sheet.getRange(rowIdx, colReactions).getValue() || '');
  let reactions = {};
  if (raw) { try { reactions = JSON.parse(raw); } catch (_) { reactions = {}; } }

  // Toggle this viewer's reaction with this emoji
  const arr = reactions[emoji] || [];
  const pos = arr.indexOf(viewerId);
  if (pos === -1) {
    // Remove this viewer from any OTHER emoji first (one reaction per person, WhatsApp-style)
    Object.keys(reactions).forEach(function(k) {
      reactions[k] = reactions[k].filter(function(v) { return v !== viewerId; });
      if (!reactions[k].length) delete reactions[k];
    });
    if (!reactions[emoji]) reactions[emoji] = [];
    reactions[emoji].push(viewerId);
  } else {
    arr.splice(pos, 1);
    if (arr.length) reactions[emoji] = arr; else delete reactions[emoji];
  }

  const editedAtDate = new Date();
  sheet.getRange(rowIdx, colReactions).setValue(JSON.stringify(reactions));
  sheet.getRange(rowIdx, colEditedAt).setValue(editedAtDate);
  SpreadsheetApp.flush();
  return _json({ ok: true, messageId: messageId, reactions: reactions, editedAt: editedAtDate.toISOString() });
}

/* =====================================================================
   PIN  —  sets or clears pinnedAt on a message.
   payload.pin = true to pin, false to unpin.
   ===================================================================== */
function _handlePin(payload) {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    return _json({ ok: false, error: 'Server not configured.' });
  }
  const messageId = _str(payload.messageId, 100);
  const doPin = payload.pin === true || payload.pin === 'true';
  if (!messageId) return _json({ ok: false, error: 'Missing messageId.' });

  const sheet = _getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return _json({ ok: false, error: 'Message not found.' });
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let rowIdx = -1;
  for (let i = 0; i < ids.length; i++) { if (String(ids[i][0]) === messageId) { rowIdx = i + 2; break; } }
  if (rowIdx === -1) return _json({ ok: false, error: 'Message not found.' });

  const colPinnedAt = SHEET_HEADERS.indexOf('pinnedAt') + 1;
  const colEditedAt = SHEET_HEADERS.indexOf('editedAt') + 1;
  const pinnedAtDate = new Date();
  sheet.getRange(rowIdx, colPinnedAt).setValue(doPin ? pinnedAtDate : '');
  sheet.getRange(rowIdx, colEditedAt).setValue(pinnedAtDate); // bump so others refresh
  SpreadsheetApp.flush();
  return _json({ ok: true, messageId: messageId, pinnedAt: doPin ? pinnedAtDate.toISOString() : '', editedAt: pinnedAtDate.toISOString() });
}

/* =====================================================================
   UPDATE LOCATION  —  updates an existing live-location message's
   coordinates (and live/stop state). Bumps editedAt so other devices
   refresh the pin on their next poll.
   ===================================================================== */
function _handleUpdateLocation(payload) {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    return _json({ ok: false, error: 'Server not configured.' });
  }
  const messageId = _str(payload.messageId, 100);
  if (!messageId) return _json({ ok: false, error: 'Missing messageId.' });

  const sheet = _getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return _json({ ok: false, error: 'Message not found.' });
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let rowIdx = -1;
  for (let i = 0; i < ids.length; i++) { if (String(ids[i][0]) === messageId) { rowIdx = i + 2; break; } }
  if (rowIdx === -1) return _json({ ok: false, error: 'Message not found.' });

  const colAttach  = SHEET_HEADERS.indexOf('attachment') + 1;
  const colEditedAt = SHEET_HEADERS.indexOf('editedAt') + 1;
  const raw = String(sheet.getRange(rowIdx, colAttach).getValue() || '');
  let att = {};
  if (raw) { try { att = JSON.parse(raw); } catch (_) { att = {}; } }
  if (att.kind !== 'location') return _json({ ok: false, error: 'Not a location message.' });

  if (payload.lat !== undefined) att.lat = Number(payload.lat) || att.lat;
  if (payload.lng !== undefined) att.lng = Number(payload.lng) || att.lng;
  if (payload.accuracy !== undefined) att.accuracy = Number(payload.accuracy) || 0;
  if (payload.stop === true || payload.stop === 'true') { att.live = false; att.liveUntil = new Date().toISOString(); }
  att.updatedAt = new Date().toISOString();

  const editedAtDate = new Date();
  sheet.getRange(rowIdx, colAttach).setValue(JSON.stringify(att));
  sheet.getRange(rowIdx, colEditedAt).setValue(editedAtDate);
  SpreadsheetApp.flush();
  return _json({ ok: true, messageId: messageId, attachment: JSON.stringify(att), editedAt: editedAtDate.toISOString() });
}

/* =====================================================================
   MEDIA  —  proxies a small Drive file (voice clip) back as base64 so the
   client can build a blob URL and play it inline. Capped to keep responses
   small; large videos use the Drive preview iframe instead.
   ===================================================================== */
function _handleMedia(params) {
  const id = _str(params.id, 100);
  if (!id) return _json({ ok: false, error: 'Missing id.' });
  try {
    const file = DriveApp.getFileById(id);
    const blob = file.getBlob();
    const bytes = blob.getBytes();
    if (bytes.length > 8 * 1024 * 1024) {
      return _json({ ok: false, error: 'File too large to stream.', tooLarge: true });
    }
    return _json({ ok: true, base64: Utilities.base64Encode(bytes), mime: blob.getContentType() });
  } catch (e) {
    return _json({ ok: false, error: e.message });
  }
}

/* =====================================================================
   FETCH  —  returns messages newer than `since`, or the most recent N
   ===================================================================== */
function _handleFetch(params) {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    return _json({ ok: false, error: 'Server not configured: SHEET_ID is not set.' });
  }

  const since = _str(params.since, 60).trim();
  let limit = parseInt(params.limit, 10);
  if (isNaN(limit) || limit < 1) limit = CONFIG.FETCH_DEFAULT_LIMIT;
  if (limit > CONFIG.FETCH_MAX_LIMIT) limit = CONFIG.FETCH_MAX_LIMIT;

  const sheet = _getSheet();
  const lastRow = sheet.getLastRow();
  const now = new Date().toISOString();

  if (lastRow < 2) {
    return _json({ ok: true, messages: [], now: now, count: 0 });
  }

  const numRows = lastRow - 1; // exclude header
  const data = sheet.getRange(2, 1, numRows, SHEET_HEADERS.length).getValues();

  let messages = [];
  for (let i = 0; i < data.length; i++) {
    messages.push(_rowToMessage(data[i]));
  }

  // Filter by `since` — include both new messages AND newly-deleted ones,
  // so other devices learn about deletions on their next poll.
  if (since) {
    messages = messages.filter(function(m) {
      const eventTs = [m.timestamp, m.deletedAt, m.editedAt]
        .filter(Boolean)
        .reduce(function(max, ts) { return ts > max ? ts : max; }, '');
      return eventTs > since;
    });
  } else {
    messages = messages.filter(function(m) { return !m.deletedAt; });
  }

  messages.sort(function(a, b) {
    const ta = [a.timestamp, a.deletedAt, a.editedAt].filter(Boolean).reduce(function(max, ts) { return ts > max ? ts : max; }, '');
    const tb = [b.timestamp, b.deletedAt, b.editedAt].filter(Boolean).reduce(function(max, ts) { return ts > max ? ts : max; }, '');
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  // Apply limit: when no `since`, take most recent N; otherwise take first N
  if (!since && messages.length > limit) {
    messages = messages.slice(messages.length - limit);
  } else if (messages.length > limit) {
    messages = messages.slice(0, limit);
  }

  return _json({
    ok: true,
    messages: messages,
    now: now,
    count: messages.length
  });
}

/* =====================================================================
   MARK SEEN  —  records read receipts when a device fetches messages.
   Called by each client after polling; fire-and-forget on the client side.
   Stores rows in a separate "ReadReceipts" sheet for clean separation.
   ===================================================================== */
function _handleMarkSeen(payload) {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    return _json({ ok: true, skipped: true }); // silently skip if unconfigured
  }
  const viewerId   = _str(payload.viewerId, 100).trim();
  const viewerName = _str(payload.viewerName, 120).trim();
  const rawIds     = payload.messageIds;
  const messageIds = Array.isArray(rawIds) ? rawIds.map(function(id) { return _str(id, 100); }).filter(Boolean) : [];

  if (!viewerId || !viewerName || messageIds.length === 0) {
    return _json({ ok: true, count: 0 });
  }

  const rSheet = _getReceiptsSheet();
  const lastRow = rSheet.getLastRow();

  // Build set of (messageId|viewerId) pairs already recorded — avoid duplicates
  const existing = new Set();
  if (lastRow >= 2) {
    const pairs = rSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    pairs.forEach(function(row) { existing.add(String(row[0] || '')); });
  }

  const now   = new Date();
  const toAdd = [];
  messageIds.forEach(function(msgId) {
    const key = msgId + '|' + viewerId;
    if (!existing.has(key)) {
      toAdd.push([key, msgId, viewerId, viewerName, now]);
    }
  });

  if (toAdd.length === 0) return _json({ ok: true, count: 0 });

  const startRow = (lastRow < 2 ? 2 : lastRow + 1);
  rSheet.getRange(startRow, 1, toAdd.length, 5).setValues(toAdd);
  rSheet.getRange(startRow, 5, toAdd.length, 1)
        .setNumberFormat('dd mmm yyyy, ddd, hh:mm:ss am/pm');
  SpreadsheetApp.flush();

  return _json({ ok: true, count: toAdd.length });
}

/* =====================================================================
   GET RECEIPTS  —  returns who has read a specific message.
   Called only by the owner when they open "Message Info" on a sent message.
   ===================================================================== */
function _handleGetReceipts(params) {
  const messageId = _str(params.messageId, 100).trim();
  if (!messageId) return _json({ ok: false, error: 'Missing messageId.' });
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    return _json({ ok: true, messageId: messageId, receipts: [] });
  }

  const rSheet  = _getReceiptsSheet();
  const lastRow = rSheet.getLastRow();
  const receipts = [];

  if (lastRow >= 2) {
    const data = rSheet.getRange(2, 1, lastRow - 1, 5).getValues();
    data.forEach(function(row) {
      var rMsgId   = String(row[1] || '');
      var rVwId    = String(row[2] || '');
      var rVwName  = String(row[3] || '');
      var rReadAt  = row[4];
      if (rMsgId === messageId) {
        receipts.push({
          viewerId:   rVwId,
          viewerName: rVwName,
          readAt: rReadAt instanceof Date ? rReadAt.toISOString() : String(rReadAt || '')
        });
      }
    });
  }

  return _json({ ok: true, messageId: messageId, receipts: receipts });
}

/* =====================================================================
   ReadReceipts Sheet helper
   Schema: receiptKey | messageId | viewerId | viewerName | readAt
   ===================================================================== */
function _getReceiptsSheet() {
  const ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet  = ss.getSheetByName('ReadReceipts');
  if (!sheet) {
    sheet = ss.insertSheet('ReadReceipts');
    var headers = ['receiptKey', 'messageId', 'viewerId', 'viewerName', 'readAt'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
         .setFontWeight('bold')
         .setBackground('#000000')
         .setFontColor(CONFIG.BRAND_COLOR);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 240); // receiptKey
    sheet.setColumnWidth(2, 220); // messageId
    sheet.setColumnWidth(3, 180); // viewerId
    sheet.setColumnWidth(4, 140); // viewerName
    sheet.setColumnWidth(5, 230); // readAt
  }
  return sheet;
}

/* =====================================================================
   Helpers
   ===================================================================== */
function _rowToMessage(row) {
  const m = {};
  for (let i = 0; i < SHEET_HEADERS.length; i++) {
    m[SHEET_HEADERS[i]] = row[i];
  }
  // Normalize timestamp to ISO string
  if (m.timestamp instanceof Date) {
    m.timestamp = m.timestamp.toISOString();
  } else {
    m.timestamp = String(m.timestamp);
  }
  // Coerce numeric fields
  if (m.imageW !== '' && m.imageW !== null) m.imageW = Number(m.imageW) || '';
  if (m.imageH !== '' && m.imageH !== null) m.imageH = Number(m.imageH) || '';
  // Stringify any remaining values for safety
  m.messageId = String(m.messageId || '');
  m.sender    = String(m.sender || '');
  m.senderId  = String(m.senderId || '');
  m.type      = String(m.type || 'text');
  m.text      = String(m.text || '');
  m.imageId   = String(m.imageId || '');
  m.imageName = String(m.imageName || '');
  m.phone     = String(m.phone || '');
  // Normalize date fields
  if (m.deletedAt instanceof Date) m.deletedAt = m.deletedAt.toISOString();
  else m.deletedAt = m.deletedAt ? String(m.deletedAt) : '';
  if (m.editedAt instanceof Date) m.editedAt = m.editedAt.toISOString();
  else m.editedAt = m.editedAt ? String(m.editedAt) : '';
  m.replyTo = String(m.replyTo || '');
  m.reactions = String(m.reactions || '');
  m.attachment = String(m.attachment || '');
  if (m.pinnedAt instanceof Date) m.pinnedAt = m.pinnedAt.toISOString();
  else m.pinnedAt = m.pinnedAt ? String(m.pinnedAt) : '';
  return m;
}

function _getSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // Make sure the spreadsheet's timezone is IST so Date cells display correctly
  try {
    if (ss.getSpreadsheetTimeZone() !== CONFIG.TIMEZONE) {
      ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
    }
  } catch (_) {}

  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);

  // Ensure header row exists
  const lastCol = sheet.getLastColumn();
  let needsHeaders = false;
  if (lastCol < SHEET_HEADERS.length) {
    needsHeaders = true;
  } else {
    const existing = sheet.getRange(1, 1, 1, SHEET_HEADERS.length).getValues()[0];
    if (existing[0] !== 'messageId') needsHeaders = true;
  }
  if (needsHeaders) {
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length)
         .setFontWeight('bold')
         .setBackground('#000000')
         .setFontColor(CONFIG.BRAND_COLOR);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 220);  // messageId
    sheet.setColumnWidth(2, 230);  // timestamp (wider to fit "07 May 2026, Wed, 06:49:36 PM")
    sheet.setColumnWidth(3, 110);  // sender
    sheet.setColumnWidth(4, 180);  // senderId
    sheet.setColumnWidth(5, 90);   // type
    sheet.setColumnWidth(6, 360);  // text
    sheet.setColumnWidth(7, 220);  // imageId
    sheet.setColumnWidth(8, 160);  // imageName
    sheet.setColumnWidth(9, 70);   // imageW
    sheet.setColumnWidth(10, 70);  // imageH
    sheet.setColumnWidth(11, 200); // userAgent
    sheet.setColumnWidth(12, 150); // phone
    sheet.setColumnWidth(13, 230); // deletedAt
  }

  _ensureDateFormatting(sheet);
  return sheet;
}

/**
 * Apply the human-readable date format to the timestamp and deletedAt
 * columns, and migrate any legacy ISO-string values to real Date objects.
 * Idempotent — safe to call on every request. Only does writes when needed.
 */
function _ensureDateFormatting(sheet) {
  const fmt = 'dd mmm yyyy, ddd, hh:mm:ss am/pm';
  const lastRow = sheet.getLastRow();

  const dateCols = [
    SHEET_HEADERS.indexOf('timestamp') + 1,
    SHEET_HEADERS.indexOf('deletedAt') + 1
  ];

  for (let i = 0; i < dateCols.length; i++) {
    const col = dateCols[i];
    if (col < 1) continue;

    // Apply column-wide format (cheap, idempotent)
    sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat(fmt);

    // Migrate legacy ISO-string values (only present from older deploys)
    if (lastRow >= 2) {
      const range = sheet.getRange(2, col, lastRow - 1, 1);
      const values = range.getValues();
      let changed = false;
      for (let r = 0; r < values.length; r++) {
        const v = values[r][0];
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
          const d = new Date(v);
          if (!isNaN(d.getTime())) {
            values[r][0] = d;
            changed = true;
          }
        }
      }
      if (changed) range.setValues(values);
    }
  }
}

function _uploadImageToDrive(image, sender) {
  const folder = _getOrCreateFolder();
  const mime = image.mimeType || 'image/jpeg';
  const bytes = Utilities.base64Decode(image.base64);
  // Filename includes sender + timestamp for traceability
  const stamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd_HHmmss');
  const safeSender = (sender || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_').substring(0, 30);
  const baseName = (image.name || 'attachment').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_').substring(0, 60);
  const ext = mime === 'image/png' ? '.png' : '.jpg';
  const filename = stamp + '_' + safeSender + '_' + baseName + ext;
  const blob = Utilities.newBlob(bytes, mime, filename);
  const file = folder.createFile(blob);

  // Make publicly viewable so the frontend can hot-link via lh3.googleusercontent.com
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // If domain policy blocks ANYONE_WITH_LINK, the image will still be there
    // but won't render on receivers' devices. Owner can adjust manually.
  }
  return { fileId: file.getId() };
}

// Upload any file type (document, audio, video) to Drive, public-view.
function _uploadFileToDrive(att, sender) {
  const folder = _getOrCreateFolder();
  const mime = att.mime || 'application/octet-stream';
  const bytes = Utilities.base64Decode(att.base64);
  const stamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd_HHmmss');
  const safeSender = (sender || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_').substring(0, 30);
  const rawName = (att.name || 'file').toString();
  // Preserve the original extension
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, '_').substring(0, 90);
  const filename = stamp + '_' + safeSender + '_' + safeName;
  const blob = Utilities.newBlob(bytes, mime, filename);
  const file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) { /* domain policy may block; owner can adjust */ }
  return { fileId: file.getId() };
}

function _getOrCreateFolder() {
  if (CONFIG.ATTACHMENTS_FOLDER_ID && CONFIG.ATTACHMENTS_FOLDER_ID.indexOf('PASTE') === -1) {
    try { return DriveApp.getFolderById(CONFIG.ATTACHMENTS_FOLDER_ID); }
    catch (e) { /* fall through */ }
  }
  const folders = DriveApp.getFoldersByName(CONFIG.ATTACHMENTS_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(CONFIG.ATTACHMENTS_FOLDER_NAME);
}

function _str(v, max) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (max && s.length > max) s = s.substring(0, max);
  return s;
}

/**
 * Normalize a phone number to E.164 format (e.g. "+919876543210").
 * Defaults to India (+91) if no country code is supplied.
 */
function _normalizePhone(raw) {
  if (!raw) return '';
  // Strip everything except digits and a leading +
  let p = String(raw).trim().replace(/[^\d+]/g, '');
  // Move + to start if it appears mid-string
  if (p.indexOf('+') > 0) p = p.replace(/\+/g, '');
  if (!p) return '';
  if (p.charAt(0) === '+') return p;                      // already E.164
  if (p.indexOf('00') === 0) return '+' + p.substring(2); // 00 prefix
  if (p.length === 10) return '+91' + p;                  // bare Indian mobile
  if (p.length === 11 && p.charAt(0) === '0') return '+91' + p.substring(1);
  if (p.length === 12 && p.indexOf('91') === 0) return '+' + p;
  if (p.length >= 10) return '+' + p;
  return p; // probably invalid — keep raw so user can fix
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _statusPage() {
  const sheetOk = !!(CONFIG.SHEET_ID && CONFIG.SHEET_ID.indexOf('PASTE') === -1);
  let folderInfo = 'auto-create';
  if (CONFIG.ATTACHMENTS_FOLDER_ID && CONFIG.ATTACHMENTS_FOLDER_ID.indexOf('PASTE') === -1) {
    folderInfo = 'configured';
  }
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>IBI Messenger Backend</title>' +
    '<style>body{font-family:Roboto,Arial,sans-serif;background:#000;color:#00c5ff;' +
    'display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:20px;}' +
    'h1{margin:0 0 8px;font-size:22px;}p{color:#9bd9ee;font-size:14px;margin:6px 0;}' +
    'code{background:#111;padding:3px 8px;border-radius:4px;color:#00c5ff;}</style></head>' +
    '<body><div><h1>IBI Messenger Backend · Online</h1>' +
    '<p>Two-way chat · v2</p>' +
    '<p>Sheet ID configured: <code>' + (sheetOk ? 'YES' : 'NOT SET') + '</code></p>' +
    '<p>Attachments folder: <code>' + folderInfo + '</code></p>' +
    '<p>Timezone: <code>' + CONFIG.TIMEZONE + '</code></p>' +
    '<p>Endpoints: <code>POST /exec</code> · <code>GET /exec?action=fetch</code></p>' +
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html);
}

/* =====================================================================
   One-time test: run from the editor to verify Sheet + Folder access
   ===================================================================== */
function testConnection() {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE') !== -1) {
    Logger.log('❌ SHEET_ID not configured.');
    return;
  }
  try {
    const sheet = _getSheet();
    Logger.log('✅ Sheet connected: ' + sheet.getParent().getName() + ' (rows: ' + sheet.getLastRow() + ')');
    const folder = _getOrCreateFolder();
    Logger.log('✅ Attachments folder: ' + folder.getName() + ' (id: ' + folder.getId() + ')');
  } catch (err) {
    Logger.log('❌ Error: ' + err.message);
  }
}
