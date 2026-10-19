# Image URL scan tools (batch only — not live site pipeline)

## Quick start (Windows)

1. Double-click **`run-phase1.bat`** → builds `out/image-miss.json`
2. Chrome: DMart Bridge → **Export session for image-scan**
3. Double-click **`run-phase2.bat`** → builds `out/image-url-overrides.json`

Phase 2 **resumes** automatically if you stop mid-way or token expires.

## Phase 1 (EGY check)

```bash
pip install -r requirements.txt
python3 scan_egy.py --products ../../data/products.json --out-dir ./out
```

- Retries timeouts / 429 / 5xx twice (does not mark healthy URLs as miss)
- Primary barcode only (no secondary-barcode trials)

## Phase 2 (DMart for misses)

```bash
python3 fetch_dmart_miss.py
# or:
python3 fetch_dmart_miss.py --miss ./out/image-miss.json --session ./session-export.json
```

- Skips SKUs already present in `out/image-url-overrides.json`
- Saves every 100 SKUs + on Ctrl+C
- Stops after 5 consecutive 401/403 and asks for a fresh session export
- Auto-picks newest `~/Downloads/session-export*.json` if `--session` omitted

Website integration of overrides is a **later** step — these tools never change live product image loading.
