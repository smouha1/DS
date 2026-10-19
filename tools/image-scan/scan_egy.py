#!/usr/bin/env python3
"""
Phase 1 — Scan catalog products against EGY_<barcode>.JPG on DHMedia.

Does NOT touch the website live image pipeline.
Retries transient CDN failures so brief network blips don't pollute miss list.
Secondary-barcode fallback is intentionally NOT used (primary barcode only).
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

DEFAULT_CONCURRENCY = 40
TIMEOUT_S = 12
MAX_RETRIES = 2
RETRY_BACKOFF_S = 0.6
TRANSIENT_HTTP = {429, 500, 502, 503, 504}


async def head_ok(
    session: aiohttp.ClientSession, url: str, sem: asyncio.Semaphore
) -> tuple[str, int | None, str]:
    """Return (status, http_code, error_msg). status in ok|miss|error|no-url."""
    if not url:
        return "no-url", None, "empty barcode / no url"

    last_code: int | None = None
    last_err = ""

    for attempt in range(MAX_RETRIES + 1):
        async with sem:
            try:
                async with session.head(url, allow_redirects=True) as resp:
                    code = resp.status
                    if code in (403, 405):
                        async with session.get(
                            url,
                            headers={"Range": "bytes=0-0"},
                            allow_redirects=True,
                        ) as resp2:
                            code = resp2.status
                    last_code = code
                    if 200 <= code < 300 or code == 206:
                        return "ok", code, ""
                    if code in TRANSIENT_HTTP and attempt < MAX_RETRIES:
                        last_err = f"HTTP {code}"
                        # release sem before sleep via exiting async with
                    else:
                        return "miss", code, f"HTTP {code}"
            except asyncio.TimeoutError:
                last_err = "timeout"
                last_code = None
                if attempt >= MAX_RETRIES:
                    return "error", None, "timeout"
            except aiohttp.ClientError as e:
                last_err = str(e)[:120]
                last_code = None
                if attempt >= MAX_RETRIES:
                    return "error", None, last_err
            except Exception as e:
                return "error", None, str(e)[:120]

        if attempt < MAX_RETRIES:
            await asyncio.sleep(RETRY_BACKOFF_S * (attempt + 1))

    return "miss" if last_code is not None else "error", last_code, last_err or "unknown"


async def run_scan(products_path: Path, out_dir: Path, concurrency: int) -> dict:
    raw = json.loads(products_path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise SystemExit("products.json must be a JSON array")

    items = []
    for row in raw:
        name, sku, bcs, url = row_fields(row)
        if not sku:
            continue
        # Primary barcode URL only (no secondary-barcode trials)
        items.append({"sku": sku, "name": name, "barcodes": bcs, "egyUrl": url})

    sem = asyncio.Semaphore(concurrency)
    timeout = aiohttp.ClientTimeout(total=TIMEOUT_S)
    headers = {
        "User-Agent": "SmouhaPick-ImageScan/1.1 (catalog batch)",
        "Accept": "*/*",
    }

    results_miss = []
    results_error = []
    ok_count = 0
    no_url_count = 0
    t0 = time.time()

    connector = aiohttp.TCPConnector(limit=concurrency, ttl_dns_cache=300)
    async with aiohttp.ClientSession(
        timeout=timeout, headers=headers, connector=connector
    ) as session:
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
        "version": 2,
        "phase": "egy-scan",
        "productsFile": str(products_path),
        "totalRows": len(raw),
        "scanned": len(items),
        "ok": ok_count,
        "miss": len([x for x in results_miss if x.get("status") == "miss"]),
        "noUrl": no_url_count,
        "errors": len(results_error),
        "concurrency": concurrency,
        "retries": MAX_RETRIES,
        "elapsedSec": elapsed,
        "note": "Primary barcode EGY URL only. OK products need no override file.",
    }

    miss_payload = {
        "version": 2,
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
    ap = argparse.ArgumentParser(
        description="Phase 1: EGY image URL scan for Smouha Pick catalog"
    )
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
