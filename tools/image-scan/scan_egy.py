#!/usr/bin/env python3
"""
Phase 1 — Scan all catalog products against EGY_<barcode>.JPG on DHMedia.

Does NOT touch the website image pipeline. Offline / batch tool only.

Usage (from tools/image-scan):
  python3 scan_egy.py --products ../../data/products.json --out-dir ./out

Outputs:
  out/image-scan-summary.json
  out/image-miss.json          # products whose EGY URL did not return 2xx
  out/image-ok-count only in summary (OK rows not fully listed by default)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

try:
    import aiohttp
except ImportError:
    print("Install deps: pip install -r requirements.txt", file=sys.stderr)
    raise

from egy_url import row_fields

# Concurrent HEAD requests — polite to CDN
DEFAULT_CONCURRENCY = 40
TIMEOUT_S = 12


async def head_ok(session: aiohttp.ClientSession, url: str, sem: asyncio.Semaphore) -> tuple[str, int | None, str]:
    if not url:
        return "no-url", None, "empty barcode / no url"
    async with sem:
        try:
            async with session.head(url, allow_redirects=True) as resp:
                code = resp.status
                if code == 405 or code == 403:
                    # some CDNs block HEAD — fall back to GET range
                    async with session.get(
                        url,
                        headers={"Range": "bytes=0-0"},
                        allow_redirects=True,
                    ) as resp2:
                        code = resp2.status
                if 200 <= code < 300 or code == 206:
                    return "ok", code, ""
                return "miss", code, f"HTTP {code}"
        except asyncio.TimeoutError:
            return "error", None, "timeout"
        except Exception as e:
            return "error", None, str(e)[:120]


async def run_scan(products_path: Path, out_dir: Path, concurrency: int) -> dict:
    raw = json.loads(products_path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise SystemExit("products.json must be a JSON array")

    items = []
    for row in raw:
        name, sku, bcs, url = row_fields(row)
        if not sku:
            continue
        items.append({"sku": sku, "name": name, "barcodes": bcs, "egyUrl": url})

    sem = asyncio.Semaphore(concurrency)
    timeout = aiohttp.ClientTimeout(total=TIMEOUT_S)
    headers = {
        "User-Agent": "SmouhaPick-ImageScan/1.0 (catalog batch; contact store IT)",
        "Accept": "*/*",
    }

    results_miss = []
    results_error = []
    ok_count = 0
    no_url_count = 0
    t0 = time.time()

    connector = aiohttp.TCPConnector(limit=concurrency, ttl_dns_cache=300)
    async with aiohttp.ClientSession(timeout=timeout, headers=headers, connector=connector) as session:
        # chunk progress
        total = len(items)
        done = 0

        async def one(item):
            nonlocal ok_count, no_url_count, done
            status, code, err = await head_ok(session, item["egyUrl"], sem)
            done += 1
            if done % 2000 == 0 or done == total:
                print(f"  … {done}/{total}", flush=True)
            if status == "ok":
                ok_count += 1
            elif status == "no-url":
                no_url_count += 1
                results_miss.append({**item, "status": "no-url", "http": code, "error": err})
            elif status == "miss":
                results_miss.append({**item, "status": "miss", "http": code, "error": err})
            else:
                results_error.append({**item, "status": "error", "http": code, "error": err})

        await asyncio.gather(*(one(it) for it in items))

    elapsed = round(time.time() - t0, 1)
    out_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "version": 1,
        "phase": "egy-scan",
        "productsFile": str(products_path),
        "totalRows": len(raw),
        "scanned": len(items),
        "ok": ok_count,
        "miss": len([x for x in results_miss if x.get("status") == "miss"]),
        "noUrl": no_url_count,
        "errors": len(results_error),
        "concurrency": concurrency,
        "elapsedSec": elapsed,
        "note": "OK products use standard EGY_<barcode>.JPG — no override file needed for them.",
    }

    miss_payload = {
        "version": 1,
        "phase": "egy-miss",
        "count": len(results_miss) + len(results_error),
        "items": results_miss + results_error,
    }

    (out_dir / "image-scan-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (out_dir / "image-miss.json").write_text(
        json.dumps(miss_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(json.dumps(summary, indent=2))
    print(f"Wrote {out_dir / 'image-scan-summary.json'}")
    print(f"Wrote {out_dir / 'image-miss.json'} ({miss_payload['count']} items)")
    return summary


def main():
    ap = argparse.ArgumentParser(description="Phase 1: EGY image URL scan for Smouha Pick catalog")
    ap.add_argument(
        "--products",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "data" / "products.json",
        help="Path to products.json",
    )
    ap.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "out",
        help="Output directory",
    )
    ap.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    args = ap.parse_args()
    if not args.products.is_file():
        raise SystemExit(f"products not found: {args.products}")
    asyncio.run(run_scan(args.products, args.out_dir, args.concurrency))


if __name__ == "__main__":
    main()
