# IBI Messenger

A clean, mobile-friendly web app for sending long-form messages directly into a Google Doc archive — every entry timestamped in IST.

Built on the standard IBI stack: **GitHub Pages (frontend) + Google Apps Script (backend) + Google Doc (data store)**.

---

## Features

- 🖥️  Big composer screen for paragraphs / long-form input
- 🌓  Dark / Light mode toggle (remembers preference)
- ⏱️  Live IST clock + word & character counter
- 📄  Each message appended to a single Google Doc with a cyan-styled timestamp heading
- 🎨  IBI brand: `#00c5ff` cyan headings on black, Roboto throughout, dot-grid logo
- 📱  Fully responsive, mobile-first
- ⌨️  `Ctrl/⌘ + Enter` to send

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-file frontend — deploy to GitHub Pages |
| `Code.gs` | Google Apps Script backend — deploy as Web App |
| `logo.jpg` | IBI brand logo (full lockup, 1500×500) — used in header |
| `README.md` | This file |

---

## Setup (5 minutes)

### Step 1 — Create the archive Google Doc
1. Go to https://docs.google.com → **Blank**.
2. Name it something like *"IBI Messenger Archive"*.
3. Copy the document ID from the URL:
   ```
   https://docs.google.com/document/d/⟨THIS_PART_IS_THE_ID⟩/edit
   ```

### Step 2 — Deploy the Apps Script backend
1. Go to https://script.google.com → **New project**.
2. Name it *"IBI Messenger Backend"*.
3. Delete `myFunction()` and paste the contents of `Code.gs`.
4. In `CONFIG.DOC_ID`, paste the Doc ID from Step 1.
5. Click **Deploy → New deployment**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click **Deploy** and authorize when prompted.
7. Copy the **Web app URL** (ends in `/exec`).

> ✅ Tip: open the `/exec` URL in your browser — you should see a black status page confirming the backend is online.

### Step 3 — Wire the frontend
1. Open `index.html`.
2. Find this line near the top of the `<script>` block:
   ```js
   const GAS_WEB_APP_URL = 'PASTE_YOUR_DEPLOYED_GAS_WEB_APP_URL_HERE';
   ```
3. Replace with your Web app URL.

### Step 4 — Publish to GitHub Pages
1. Push `index.html` to a GitHub repo.
2. Repo → **Settings → Pages → Source: main / root** → **Save**.
3. Visit `https://<your-username>.github.io/<repo>/`.

---

## How entries appear in the Doc

```
🕒 07-May-2026  03:42:18 PM IST          ← cyan #00c5ff, Roboto, bold
Source: IBI Messenger Web                 ← small grey italic

Your message body here, with line breaks
preserved as you typed them.
─────────────────────────────────────
```

Every new submission appends below the previous one — newest at the bottom, full audit trail.

---

## Updating the script later

Apps Script web apps need redeployment after edits:
**Deploy → Manage deployments → ✏️ edit existing → Version: New version → Deploy**.
The `/exec` URL stays the same, so no frontend change required.

---

## Replacing the logo

The header uses `logo.jpg` (your full company logo, 1500×500). To swap it for a different file (e.g. an updated brand asset, an SVG version, or a transparent PNG):

1. Replace `logo.jpg` in the repo root with the new file.
2. If the filename or extension changes, update the `<img src="logo.jpg" …>` reference in `index.html`.

That's it — the banner auto-scales to a 640 px max width on desktop and full container width on mobile.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"Backend URL not configured"* toast | You haven't pasted the `/exec` URL into `index.html`. |
| *"Server not configured: DOC_ID is not set"* | Paste the Doc ID into `Code.gs → CONFIG.DOC_ID` and redeploy. |
| Send button silently fails | Open DevTools → Network → check the POST response. Most often the deployment is still set to "Only myself" — change to **Anyone**. |
| Authorization loop on first deploy | Click *Advanced → Go to project (unsafe)* — this is normal for personal Apps Script projects. |

---

## Brand spec

| Token | Value |
|---|---|
| Accent (headings) | `#00c5ff` |
| Header / heading background | `#000000` |
| Font | Roboto, 16 px base |
| Favicon | "IBI" text, cyan on black, Roboto |

© India Business International · iINTELLIGENCEi · Kanyakumari, Tamil Nadu
