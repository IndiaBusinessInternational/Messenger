# IBI Messenger — Two-Way Chat

A WhatsApp-style two-way chat between owner and staff, with all messages archived in a Google Sheet and image attachments stored in Google Drive.

Built on the standard IBI stack: **GitHub Pages (frontend) + Google Apps Script (backend) + Google Sheet + Google Drive folder**.

---

## How it works

1. Each person opens the messenger URL on their phone.
2. The first time, it asks **"Who's using this device?"** They enter their name (Owner / Aswin / Vinod / etc.).
3. They type messages or attach images.
4. Every message goes into a shared Google Sheet (one row per message), with images uploaded to a Drive folder.
5. The app polls every 5 seconds for new messages from other people, and shows them as left-aligned grey bubbles with the sender's name above. Your own messages stay right-aligned in cyan.

The Sheet is the canonical archive — you can open it any time to see the full history. The chat UI is just a friendly view of that data.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-file frontend — deploy to GitHub Pages |
| `Code.gs` | Apps Script backend — handles send + fetch + image upload |
| `logo.jpg` | IBI brand logo (optional asset, not used by the chat header) |
| `README.md` | This file |

---

## One-time setup

### 1. Create a Google Sheet
- Go to [sheets.new](https://sheets.new), name it *"IBI Messenger Data"*.
- Copy the Sheet ID from the URL: `https://docs.google.com/spreadsheets/d/⟨THIS_PART⟩/edit`

### 2. (Optional) Create a Drive folder for images
- Create a folder in Drive named *"IBI Messenger Attachments"* — or skip; the script will auto-create one.
- If you want a specific folder, copy its ID from `https://drive.google.com/drive/folders/⟨THIS_PART⟩`.

### 3. Deploy the Apps Script
- Open [script.google.com](https://script.google.com) → your existing IBI Messenger project (or **New project**).
- Replace its contents with the new `Code.gs`.
- Edit the top of the file:
  - `CONFIG.SHEET_ID` ← paste your Sheet ID
  - `CONFIG.ATTACHMENTS_FOLDER_ID` ← paste folder ID (or leave blank)
- Run `testConnection()` once from the editor to confirm Sheet + folder access (and authorize on first run).
- **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.**
  - Type: Web app · Execute as: Me · Who has access: **Anyone**
- The `/exec` URL stays the same — no frontend change needed.

### 4. Wire the frontend
- Edit `index.html`:
  - `GAS_WEB_APP_URL` ← (already set to your existing `/exec`)
  - `GOOGLE_SHEET_URL` ← paste the Sheet's URL so the menu's "Open Google Sheet" works
- Push to GitHub. Hard-refresh the live page (Ctrl/⌘ + Shift + R).

### 5. Each person enters their name
- Owner opens the URL → enters "Owner" → continues.
- Each staff member opens the URL → enters their name → continues.
- From now on, all messages are tagged with sender names.

---

## How identity works

- Each device generates its own `senderId` on first launch (a random ID stored in `localStorage`).
- The display name (e.g. "Aswin") is what others see on each bubble.
- "Is this my message?" is determined by matching `senderId` — so even if two people pick the same name by accident, the chat doesn't get confused on each individual device.
- To change your displayed name later: ⋮ menu → **Change my name**.
- Multi-device note: if the same person uses the chat from phone + laptop, each device has its own `senderId`. Messages sent from the phone will appear as left-side received bubbles on the laptop. (Workable, just be aware.)

---

## Sheet schema

Each row is one message:

| Column | Description |
|---|---|
| `messageId` | Client-generated unique ID (used for dedup) |
| `timestamp` | Server time when row was written (ISO 8601) |
| `sender` | Display name |
| `senderId` | Per-device unique ID |
| `type` | `text` / `image` / `image+text` |
| `text` | Message body (empty for image-only) |
| `imageId` | Drive file ID (empty if no image) |
| `imageName` | Original filename |
| `imageW`, `imageH` | Image dimensions in pixels |
| `userAgent` | Sender's browser, for diagnostics |

You can sort, filter, and search the Sheet like any other archive.

---

## Image handling

- Frontend compresses images to max 1280 px on the longest side, JPEG ~85% quality.
- Backend uploads to the Drive folder, sets the file to "anyone with the link can view".
- The Sheet stores the file ID; the frontend renders images using `https://lh3.googleusercontent.com/d/⟨id⟩=w800`.
- Tap any image bubble for full-size lightbox view.

---

## Polling behaviour

- Every 5 seconds, when the tab is visible, the app fetches new messages since the last seen timestamp.
- When you switch back to the tab, an immediate fetch happens (no waiting for the next 5s tick).
- Network failures are silent (the connection dot turns grey); polling resumes automatically when the network returns.
- The ⋮ menu has a manual **Refresh** action if you ever want to force a poll.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Toast: *"Could not reach the backend"* | Deployment access not "Anyone" | Deploy → Manage deployments → ✏️ → **Who has access: Anyone** → New version → Deploy |
| Sent message stays as ⏱ "sending" forever | Backend rejected the request silently (e.g. Sheet ID misconfigured) | Run `testConnection()` in the Apps Script editor; check Executions tab for errors |
| Other people's images show "Image unavailable" | Drive sharing was blocked | Open the Drive folder, set it to "Anyone with the link can view" manually |
| Identity prompt keeps reappearing | Browser is in private/incognito mode (no `localStorage`) | Use a normal browser window |
| New version doesn't load | Browser cache | Ctrl/⌘ + Shift + R |

---

## Brand spec

| Token | Value |
|---|---|
| Sent bubble background | `#00c5ff` |
| Header background | `#000000` |
| Sender name color | `#00aee0` |
| Font | Roboto, 16 px base |
| Favicon | "IBI" text, cyan on black, Roboto |

© India Business International · iINTELLIGENCEi · Kanyakumari, Tamil Nadu
