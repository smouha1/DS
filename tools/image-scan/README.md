# Image URL scan tools (batch — not part of live product UI)

These scripts **do not** change how the website loads product images at runtime.
They only help build optional override data offline.

## Phase 1 — EGY CDN check

```bash
cd tools/image-scan
pip install -r requirements.txt
python3 scan_egy.py --products ../../data/products.json --out-dir ./out
```

Outputs:

- `out/image-scan-summary.json` — counts
- `out/image-miss.json` — SKUs where `EGY_<barcode>.JPG` did not return OK

## Phase 2 — DMart images for misses only

1. In Chrome, open **DMart Bridge** popup while logged into portal.talabat.com.
2. Click **Export session for image-scan** → save `session-export.json` next to the scripts.
3. Run:

```bash
python3 fetch_dmart_miss.py \
  --miss ./out/image-miss.json \
  --session ./session-export.json \
  --out-dir ./out
```

Outputs:

- `out/image-url-overrides.json` — `{ "urls": { "SKU": "https://..." } }`
- `out/dmart-miss-report.json` — per-SKU detail

Website integration of `image-url-overrides.json` is a **later** step (not done by these tools).
