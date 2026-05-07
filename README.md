# IBI Messenger

A WhatsApp-style chat interface for sending text and images directly into a Google Doc archive — every entry timestamped in IST.

Built on the standard IBI stack: **GitHub Pages (frontend) + Google Apps Script (backend) + Google Doc (archive)**.

---

## Features

- 💬  Compact, mobile-first chat layout — message bubbles, date dividers, sticky input bar
- 📷  Image attachments — auto-compressed client-side (max 1280 px, ~85% JPEG) before upload
- 🌓  Dark / light mode toggle (remembers preference)
- 🔍  Tap any image to view full-size in a lightbox
- 🕐  Each message stamped with IST date & time in the Google Doc
- 💾  Local chat history (last 200 messages, kept in `localStorage`) for visual context
- 📄  "Open Google Doc" shortcut from the menu
- 🧹  "Clear local history" option (doesn't touch the Doc)
- 🛡️  Resilient send — falls back to `no-cors` mode automatically if CORS blocks the regular fetch
- ⌨️  `Ctrl/⌘ + Enter` to send

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-file frontend — deploy to GitHub Pages |
| `Code.gs` | Google Apps Script backend — handles text + image uploads |
| `logo.jpg` | IBI brand logo (full lockup, 1500×500). **Optional asset** — shipped for reference but not used by the compact chat header (the header uses an inline SVG dot-grid avatar that matches the brand mark in this image) |
| `README.md` | This file |

---

## Setup recap

The current build is already wired to:

- **Doc ID:** `1Zr65LApW5RtWbtiFzhAYSeQOVC-vDk8BHsrKxTAN7pw`
- **Web App URL:** `https://script.google.com/macros/s/AKfycbyq.../exec`

If you redeploy the GAS or move the Doc, edit those two constants:

- `index.html` → top of the `<script>` block: `GAS_WEB_APP_URL` and `GOOGLE_DOC_URL`
- `Code.gs` → top of the file: `CONFIG.DOC_ID`

After editing `Code.gs`, **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The `/exec` URL stays the same.

> ⚠️ **Important after this update**: re-deploy `Code.gs` to pick up image-handling support. If you skip this step, image uploads will land in the Doc without the actual image embedded.

---

## How entries appear in the Doc

**The newest entry always appears at the top** — older entries are pushed below. Each entry looks like this:

```
🕒 07-May-2026  03:42:18 PM IST          ← cyan #00c5ff, Roboto, bold
Source: IBI Messenger Web · Attachment: photo.jpg (1280×960)
[ inline image — auto-sized to ~480 px wide ]
Optional caption text from the user…
─────────────────────────────────────
(blank line)
🕒 (previous, older entry)
…
```

- Text-only entries skip the attachment line.
- Image-only entries (no caption) just show heading + image + separator.
- Open the Doc and the most recent message is right at the top — no scrolling required.

---

## Image handling notes

- Max input dimension: 1280 px on the longest side. Larger images are downscaled.
- Output: JPEG at 85% quality (transparent PNGs get a white background).
- Typical compressed size: 100–500 KB.
- GAS payload hard limit is ~50 MB, but realistically keep sends under ~5 MB.
- To change compression: edit `IMAGE_MAX_DIMENSION` and `IMAGE_QUALITY` near the top of the script block in `index.html`.

---

## Local chat history

The chat bubbles you see in the UI are stored in your browser's `localStorage` only — they are not synced across devices. The **canonical archive** is always the Google Doc.

- Menu (⋮) → **Clear local history** wipes the local view (Doc untouched).
- If `localStorage` runs out of room (~5 MB), older image data URLs auto-drop and become `[Image — dropped from local cache]` placeholders. The original images remain in the Doc.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Toast: *"Could not reach the backend"* | GAS deployment access not set to "Anyone" | Deploy → Manage deployments → ✏️ → **Who has access: Anyone** → New version → Deploy |
| Image looks rotated | Source image has EXIF orientation that gets stripped during canvas re-encode | Rotate the image before uploading |
| Bubble shows ⚠ failed icon | Network blocked the request entirely | Check connection, try again |
| Old version shows after deploy | Browser cache | Ctrl/⌘ + Shift + R to hard-refresh |

---

## Brand spec

| Token | Value |
|---|---|
| Accent (headings, sent bubbles) | `#00c5ff` |
| Header background | `#000000` |
| Font | Roboto, 16 px base |
| Favicon | "IBI" text, cyan on black, Roboto |

© India Business International · iINTELLIGENCEi · Kanyakumari, Tamil Nadu
