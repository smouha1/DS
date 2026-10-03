# Smouha Pick — Full Project Specification (Rebuild From Scratch)

**Document purpose:** Enable any engineer or AI agent to understand and re-implement the entire system without prior conversation history.

**Product name:** Smouha Pick (Talabat Mart Smouha / multi-warehouse pick helper)  
**Primary deploy URL (example):** `https://ds60.vercel.app/`  
**Stable pin (at doc time):** site `1.9.11` · build `132`  
**Bridge extension (at doc time):** `Smouha Pick – DMart Bridge` · MV3 · ~`1.11.x`

---

## 1. What the system is

A **warehouse picking / stock lookup** tool for Talabat DMart (Egypt dark stores):

| Layer | Role |
|-------|------|
| **Web app** | Search products by SKU or last 6 barcode digits; show name, barcode (Code128/QR), image; live Available / Reserved / Price; optional stock ± adjust on desktop |
| **Chrome extension (“DMart Bridge”)** | Runs on a PC signed into `portal.talabat.com`; holds **session (Bearer + cookies)**; executes BFF API calls the browser page cannot do (CORS + auth) |
| **Supabase (optional relay)** | Lets **phones / remote browsers** request live stock when the PC+extension is online; extension polls pending rows and writes results |

**Non-goals:** Not a full WMS. Not public consumer app. Auth to Talabat stays on the portal/extension side.

---

## 2. High-level architecture

```
┌─────────────────┐     postMessage      ┌──────────────────────────┐
│  Smouha Pick    │◄────────────────────►│ content-smouha.js        │
│  Web App        │                      │ (injected on site tabs)  │
│  (Vercel/static)│                      └───────────┬──────────────┘
└────────┬────────┘                                  │ chrome.runtime
         │                                           ▼
         │ read-only                          ┌──────────────┐
         │ (anon)                             │ background.js│
         ▼                                    │ Service Worker│
┌─────────────────┐   poll pending + write    │ + offscreen  │
│ Supabase        │◄─────────────────────────│ keep-alive   │
│ dmart_live_*    │                           └──────┬───────┘
└─────────────────┘                                  │
                                                     │ Bearer+Cookie
                                                     ▼
                                          ┌──────────────────────┐
                                          │ DMart BFF            │
                                          │ im-bff-live-me.      │
                                          │ deliveryhero.io      │
                                          └──────────────────────┘
                                                     ▲
                                          session from
                                          portal.talabat.com
                                          (content-portal.js
                                           + webRequest)
```

### Live stock resolution order (site)

1. **In-page cache** (short TTL, ~30s) keyed by `sku + warehouseId`
2. **Bridge postMessage** (fast path when extension is on the same browser)
3. **Supabase relay** (mobile / other device): insert or poll `dmart_live_requests` / read mirror tables
4. Optional **direct BFF** with stored token (often blocked by CORS; advanced/dev only)

Search catalog is **local** (`products.json` → IndexedDB → in-memory maps). Live stock is **never** stored as source of truth in the catalog file.

---

## 3. Repository / folder layout (web app)

```
Smoha-Pick/
├── index.html                 # Shell UI (header, search, result area, settings drawer)
├── manifest.json              # PWA manifest
├── sw.js                      # Service worker (shell cache; NEVER cache products.json/version.json as stale forever)
├── assets/
│   ├── css/
│   │   ├── main.css           # Layout, theme, header, toasts, PWA offline banner
│   │   ├── search.css         # Search box, suggestions, team rotator
│   │   ├── cards.css          # Product card, barcode, DMart live card, adjust modal
│   │   ├── buttons.css
│   │   ├── settings.css
│   │   └── warehouse.css
│   ├── js/
│   │   ├── app.js             # Boot, search UI, product render, settings trigger
│   │   ├── search.js          # Catalog index + query (SKU first, then last-6)
│   │   ├── search-worker.js   # Optional Worker to build indexes off main thread
│   │   ├── barcode.js         # Parse barcodes, Code128/QR, image URL from barcode
│   │   ├── image.js           # Image load, zoom, DMart image fallback
│   │   ├── updater.js         # Fetch products.json, IndexedDB import, version check
│   │   ├── indexeddb.js       # Local product DB
│   │   ├── warehouse.js       # Warehouse list UI + selected ID
│   │   ├── dmart.js           # Portal deep-link URL builders only
│   │   ├── dmartLive.js       # Live stock orchestration + bridge + Supabase
│   │   ├── dmartLiveParse.js  # Parse BFF payloads → Available/Reserved/Price
│   │   ├── dmartAdjust.js     # Stock ± confirm modal + bridge adjust requests
│   │   ├── smartScan.js       # Camera / ZXing scan mode
│   │   ├── settings.js        # Lazy-loaded settings panel
│   │   ├── appSettingsQuick.js# Sync settings reads for hot paths
│   │   ├── appStore.js        # Recent / favorites / theme in localStorage
│   │   ├── appCatalogUi.js    # Catalog status events / session banner
│   │   ├── pwa.js             # SW register, offline banner, update toast
│   │   ├── maintenance.js     # Lazy maintenance tools
│   │   ├── updater.js / utils.js / vendor/JsBarcode...
│   │   └── qrcode-generator.js
│   └── img/                   # PWA icons
├── data/
│   ├── products.json          # ONLY catalog file: [name, sku, barcodeRaw][]
│   ├── warehouses.json        # Warehouse IDs + names
│   └── version.json           # version, build, changelogByVersion
├── downloads/                 # Optional APK
└── docs/
    └── PROJECT_SPEC_FROM_SCRATCH.md  # this file
```

**Extension package (separate zip):**

```
d-mart-bridge/
├── manifest.json              # MV3
├── background.js              # Session, BFF fetch, Supabase poll, adjust, keep-alive
├── content-smouha.js          # Bridge site ↔ extension via postMessage
├── content-portal.js          # Portal helpers / lock branch navigation
├── offscreen.html / offscreen.js
├── popup.html / popup.js
├── warehouses.json
└── icons/
```

---

## 4. Data contracts

### 4.1 `data/products.json`

JSON **array of rows**. Each row is an array (tuple):

```json
[
  ["Product Name", "SKU", "BARCODE1,BARCODE2"],
  ...
]
```

| Index | Field | Notes |
|------:|-------|--------|
| 0 | name | Display name |
| 1 | sku | Primary search key |
| 2 | barcodeRaw | One or more barcodes, comma-separated |

**No image column.** Images are derived:

```text
https://talabat.dhmedia.io/image/darkstores-eg/EGY_{PRIMARY_BARCODE}.JPG
```

Implemented in `barcode.js` → `imageUrlFromBarcodes()`.

On DMart lookup miss, the bridge/BFF may return `image.url`; site prefers that when catalog has no usable image.

**Search priority (must preserve):**

1. Exact / prefix **SKU**
2. **Last 6 digits** of barcodes  
3. Optional: if not in catalog and bridge online → DMart product lookup (cache in memory/IndexedDB session)

### 4.2 `data/warehouses.json`

List of warehouses with at least:

- `id` — UUID used in portal URL and BFF path  
- Official / friendly display names  
- Smouha DS60 is the primary branch for stock adjust policy in UI copy

Portal inventory URL pattern:

```text
https://portal.talabat.com/pv2/eg/p/inventory/w/{WAREHOUSE_ID}?search={SKU}&is_active=0&is_available=0&is_sample=0&sort=0&page=1
```

### 4.3 `data/version.json`

```json
{
  "version": "1.9.11",
  "build": 132,
  "updated": "YYYY-MM-DD",
  "changelogByVersion": [
    { "version": "1.9.11", "build": 132, "date": "...", "items": ["..."] }
  ]
}
```

Site compares remote `version.json` to decide catalog refresh. Bump **build** on every deploy; bump **version** on meaningful releases.

### 4.4 In-memory product record (after normalize)

```js
{
  sku: string,
  name: string,
  barcodes: string[],
  image: string,       // derived URL
  last6: string[],
  fromDmart?: boolean  // true if injected from live lookup, not file
}
```

---

## 5. DMart BFF API (extension / authenticated)

**Base:** `https://im-bff-live-me.deliveryhero.io/v2/entity`  
**Entity:** `HF_EG`

| Purpose | Method | Path (pattern) |
|---------|--------|----------------|
| Search products in warehouse | GET | `/HF_EG/warehouse/{warehouseId}/products?query={sku}&page=1&per_page=50&sort=PRODUCT_NAME_ASC` |
| Product detail | GET | `/HF_EG/warehouse/{warehouseId}/product/{productId}` |
| Stock adjustment | POST/PUT (as captured in HAR) | `/HF_EG/warehouse/{warehouseId}/product/{productId}/stock-adjustment` |
| Soft session ping | GET | `/HF_EG/warehouses?per_page=1&page=1` |

**Authoritative live fields** (parse flexibly; field names vary):

| UI label | Preferred API concepts |
|---------|-------------------------|
| Available | `on_hand_quantity` / similar |
| Reserved | `reserved_quantity` / similar |
| Price | selling price EGP |

**Race protection on site:** each live request has monotonic token + `sku` + `warehouseId`; stale responses discarded.

**Stock adjust (important rules learned in production):**

- Requires **location** and/or **expiry** from product stock lines when API demands them — pick **first available location / first expiry** from the product payload when user does not choose.
- Quantity limits in UI (e.g. max 5 default; optional boost via keyboard shortcut for a short window).
- Prefer executing adjust **only on the PC with the extension** (not pure mobile relay) for safety; Smouha DS60 exclusivity messaging in confirm UI.
- After success: refresh live card; failure: shake / error feedback without breaking search.

Session capture:

- Extension uses `webRequest` / portal traffic to capture **Authorization: Bearer …** and cookies.
- Opening inventory URL for the locked warehouse renews session.
- Soft JWT expiry handling + logs in extension.

---

## 6. Bridge message protocol (page ↔ extension)

Content script `content-smouha.js` listens to `window.postMessage` on the **site origin** and forwards to the service worker.

### Site → Extension (examples)

| `type` | Purpose |
|--------|---------|
| `SMOUHA_PICK_DMART_LOOKUP` | Resolve live stock / product by SKU + warehouseId |
| `SMOUHA_PICK_DMART_REQUEST` | Generic authenticated request / adjust payload |

### Extension → Site

| `type` | Purpose |
|--------|---------|
| `SMOUHA_PICK_DMART_BRIDGE_STATUS` / `READY` / offline signals | Bridge presence + session usability |
| `SMOUHA_PICK_DMART_LOOKUP_RESPONSE` | Live fields or error code |
| `SMOUHA_PICK_DMART_RESPONSE` | Generic response |

**Error codes** (site maps to user-safe strings): `no-token`, `no-bridge`, `cors`, `bridge-timeout`, session-auth-required, etc.

**Security:** Never put `service_role` Supabase key in the website. Anon key only for client read/write of relay rows as designed. Service role stays in extension if used.

---

## 7. Supabase relay (mobile live stock)

**Project (example):** `https://kryrvfyzmrydbqkmfubt.supabase.co`

Typical tables:

### `dmart_live_requests` (queue)

| Column | Role |
|--------|------|
| `id` | UUID |
| `status` | `pending` → `done` / `error` |
| `sku`, `warehouse_id` | Request |
| `result` / payload | JSON live fields |
| `created_at` | Ordering + TTL |

**Flow:**

1. Mobile site inserts or upserts a **pending** request (or reads a mirror cache row).
2. Extension SW polls `status=eq.pending`, runs BFF with real session, writes result, sets `done`.
3. Site reads result (poll or realtime if configured).

Ignore rows older than a TTL (site uses ~15 minutes for mirror age).

**Keep-alive (extension)** so polling does not die under MV3:

1. `chrome.alarms` (~1 min)
2. Long-lived ports (content scripts + offscreen)
3. Offscreen document ping ~20s
4. In-memory interval while ports connected  

Still: keep portal or site tab open on the PC for best uptime.

---

## 8. Web app features (behavioral spec)

### 8.1 Search & suggestions

- Debounced input; suggestions dropdown.
- On mobile: **team rotator must not steal taps** while suggestions open (`display:none` / `pointer-events:none` on rotator; capture-phase click on items).
- Selecting a product renders card and triggers live fetch.
- Re-selecting same product should **force fresh live** (do not trust long-lived reserved/available blindly).

### 8.2 Product card

- Image (catalog URL → DMart URL fallback); zoom on click/hover (desktop hover preview).
- Primary barcode: **QR default** (setting can switch to Code128); floating format switch optional.
- Secondary lines: `Br : 1`, `Br : 2`, … aligned under symbol.
- SKU / Barcode / Favorite row; **download** button for barcode PNG next to barcode field.
- Recent list optional beside barcode (desktop setting; default off on mobile).

### 8.3 DMart Live card

- Shows Available, Reserved, Price.
- Status text like “Connecting…” / fetch progress — **do not** show permanent “Bridge Online/Offline” chrome in header (removed by product decision).
- Desktop + bridge online: stock adjust panel (±).
- Mobile: compact metrics; hide “Check in Dmart” button in card (deep link may still exist elsewhere).

### 8.4 Settings (lazy `settings.js`)

Examples of toggles (names may vary slightly in code):

- QR vs Code128 default  
- Large barcode  
- Performance mode  
- Recent beside barcode  
- Dark mode  
- Auto copy SKU / barcode  
- Play scan sound  
- Intensive autofocus (default off)  
- Warehouse display: friendly vs official names  
- Hover preview (desktop)  
- DMart confirm popup  
- Clear recent / favorites with confirm  

Persist under one `localStorage` key; hot paths use `appSettingsQuick.js`.

### 8.5 Team rotator & footer

- Rotating names (Smouha Team); Ashraf Amin special timing/animation as supervisor.
- Footer credit block; team list source should stay single so rotator and list stay in sync.

### 8.6 PWA / APK

- `manifest.json` + `sw.js` for offline **shell** and cached barcodes tooling.
- Offline: search + barcodes from cache; live stock needs network/bridge.
- Optional Android **WebView APK** loading the deployed URL; camera permission only when Scan Mode starts.

### 8.7 Custom barcode / scan mode

- Custom barcode generator (value typed ≠ catalog product).
- Scan mode: ZXing from CDN when needed; rear camera preferred; sound/haptic optional.

---

## 9. Critical implementation rules (do not break)

1. **Catalog file has no images** — always derive or take from DMart.  
2. **Search order:** SKU then last-6 (then optional DMart lookup).  
3. **Single catalog file:** `products.json` only (do not resurrect dual `products-search.json` unless truly slim and different).  
4. **Live stock never blocks search UI** — failures show “—” / soft status.  
5. **Reserved/Available:** prefer detail endpoint / stable read; force refresh on re-open same SKU; avoid showing stale reserved after adjust.  
6. **Stock adjust:** location/expiry from API data; quantity caps; confirm UI; desktop+extension executor preferred.  
7. **No service_role in frontend.**  
8. **CSS:** mobile product order = image | barcode | live below; desktop = live + image + barcodes row. After any CSS merge, **media queries must win on mobile** (append mobile block last if needed).  
9. **Suggestions vs rotator:** rotator cannot receive pointer events while dropdown open.  
10. **Settings drawer z-index** above sticky search (e.g. ≥ 12000).

---

## 10. Rebuild steps (green field)

### A. Web app

1. Create static site with structure in §3.  
2. Implement `products.json` loader → IndexedDB → `search.js` indexes.  
3. Implement product card + barcode.js (JsBarcode local + qrcode-generator).  
4. Implement `warehouse.js` + portal link helper (`dmart.js`).  
5. Implement `dmartLiveParse.js` then `dmartLive.js` with bridge postMessage.  
6. Add settings, recent/favorites, team rotator.  
7. Add `sw.js` + manifest; exclude product data from aggressive stale shell cache.  
8. Deploy static host (Vercel/Netlify).  
9. Point APK WebView at production URL if needed.

### B. Extension

1. MV3 extension with permissions: `alarms`, `cookies`, `offscreen`, `storage`, `tabs`, `webRequest`, host permissions for portal + BFF + Supabase.  
2. Capture Bearer + cookies from portal.  
3. Implement lookup + stock-adjustment against BFF.  
4. `content-smouha.js` message bridge.  
5. Optional Supabase poll loop + upsert results.  
6. Offscreen keep-alive stack.  
7. Popup: warehouse lock, status, logs.  
8. Load unpacked / package for store-offline install.

### C. Supabase

1. Create project; tables for live request queue (+ optional mirror of last stock by sku/warehouse).  
2. RLS: anon can insert pending + read own/recent results as designed; no DMart secrets in DB.  
3. Put URL + anon in site; service role only in extension if required.

### D. Verification checklist

- [ ] Search SKU and last-6  
- [ ] Barcode QR/128 + download PNG  
- [ ] Image from barcode URL / DMart  
- [ ] Live stock with extension on same PC  
- [ ] Live stock on phone via relay while PC extension online  
- [ ] Adjust stock success/fail UX  
- [ ] Mobile layout image|barcode|live  
- [ ] Suggestions tappable (rotator not intercepting)  
- [ ] Settings opens  
- [ ] Offline shell still searches cached catalog  

---

## 11. Known pitfalls (historical)

| Pitfall | Symptom | Mitigation |
|---------|---------|------------|
| CSS “flatten” puts desktop rules after mobile | Mobile layout inverted | Final `@media (max-width:720px)` block last |
| Dual identical product JSON files | Double download | Single `products.json` |
| Showing Reserved from shallow search hit | Fake reserved until refresh | Detail fetch / force re-poll |
| Adjust without location/expiry | API error | Auto-pick first location/expiry from payload |
| MV3 SW sleep | Relay slow/offline | Offscreen + alarms + open tab |
| Team rotator over suggestions | Wrong panel opens on tap | Hide rotator while suggestions open |
| PWA install UI + APK confusion | Clutter | APK link only if needed; slim pwa.js |
| Header “Bridge Online/Offline” | User rejection | Remove chip; keep internal `isBridgeOnline()` |

---

## 12. Tech stack summary

| Area | Choice |
|------|--------|
| Site | Vanilla ES modules, no React/Vue required |
| Barcodes | JsBarcode (Code128), qrcode-generator (QR) |
| Scan | ZXing (CDN on demand) |
| Storage | localStorage settings; IndexedDB products |
| Extension | Chrome MV3, service worker, offscreen |
| Backend relay | Supabase REST |
| Hosting | Static (Vercel) |
| Optional | Android WebView APK |

---

## 13. Minimal “hello live stock” sequence

1. User selects warehouse W and types SKU S.  
2. `search.js` finds product → `app.js` renders card.  
3. `dmartLive.liveCardHtml(S)` mounts; `fetchLive(S,W)` runs.  
4. Page `postMessage` LOOKUP → content-smouha → background.  
5. Background BFF GET products/detail with Bearer.  
6. Response posted back → parse → fill Available/Reserved/Price.  
7. If no bridge: enqueue Supabase pending; extension on PC completes later; page polls.

---

## 14. File ownership cheat sheet

| Concern | Primary files |
|---------|----------------|
| Boot & product UI | `app.js`, `index.html` |
| Catalog search | `search.js`, `updater.js`, `indexeddb.js` |
| Barcode/QR/image URL | `barcode.js`, `image.js` |
| Live stock | `dmartLive.js`, `dmartLiveParse.js` |
| Adjust UI | `dmartAdjust.js` |
| Warehouses | `warehouse.js`, `data/warehouses.json` |
| Bridge SW | `background.js` |
| Bridge page pipe | `content-smouha.js` |
| Session/portal | `content-portal.js`, webRequest in SW |

---

## 15. License / ops notes

- Internal Talabat Mart Smouha tooling; depends on employee portal session.  
- Do not commit real `service_role` keys to public repos.  
- Rotate anon key if exposed widely; restrict RLS.  
- When updating catalog: replace `data/products.json`, bump `version.json` build, deploy; clients fetch new catalog on version change.

---

*End of specification. An implementer should be able to recreate site + bridge + relay from this document plus live HAR samples of BFF stock-adjustment if payload shapes drift.*
