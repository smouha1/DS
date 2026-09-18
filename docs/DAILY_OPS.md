# Smouha Pick — Daily ops (short)

## Start of shift
1. On the **PC**: open Talabat DMart inventory for **Smouha** and keep the tab open.
2. Confirm **DMart Bridge** extension is enabled (icons/lamps healthy).
3. Open the site → Settings → **Deploy Checklist** (optional) or **Smoke Test**.
4. Confirm header badge is not stuck on “Catalog may be outdated”.

## During shift
- If Live shows Offline / auth banner: refresh the DMart inventory tab on the PC.
- Prefer searching by full SKU; last-6 is fallback.
- After product list updates: run `python3 tools/generate-search-catalog.py` (or rely on GitHub Action), deploy both JSON files.

## End of week
- Review extension logs once (timeouts, AUTH_REQUIRED, bridge silent gaps).
- Export Settings & Recent if moving to another device.

## Deploy checklist (must)
- [ ] `data/products.json` updated
- [ ] `data/products-search.json` regenerated
- [ ] `data/version.json` build bumped
- [ ] Settings → **Deploy Checklist** all PASS/CHECK reviewed
- [ ] Settings → **Smoke Test** (Live probe if bridge online)
- [ ] Hard refresh / new SW on one phone + one PC
