#!/usr/bin/env python3
"""
Phase 2 — For EGY-miss SKUs only, fetch real image URL from DMart BFF.

Requires a session file exported from the Chrome extension popup:
  Export session for image-scan → session-export.json

Usage:
  python3 fetch_dmart_miss.py \\
    --miss ./out/image-miss.json \\
    --session ./session-export.json \\
    --out-dir ./out

Outputs:
  out/image-url-overrides.json   # sku → absolute image URL (miss-only)
  out/dmart-miss-report.json     # per-sku ok/fail detail
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

BFF_BASE = "https://im-bff-live-me.deliveryhero.io/v2/entity"
ENTITY = "HF_EG"
DEFAULT_WH = "d24a9f96-f6bc-43b0-af78-b7067f0c901c"  # Smouha DS60


def build_search_url(sku: str, warehouse_id: str, page: int = 1) -> str:
    return (
        f"{BFF_BASE}/{ENTITY}/warehouse/{warehouse_id}/products"
        f"?per_page=50&page={page}&sort=PRODUCT_NAME_ASC&query={sku}"
    )


def build_detail_url(product_id: str, warehouse_id: str) -> str:
    return f"{BFF_BASE}/{ENTITY}/warehouse/{warehouse_id}/product/{product_id}"


def pick_image(node) -> str:
    if not node or not isinstance(node, dict):
        return ""
    img = node.get("image")
    if isinstance(img, dict) and img.get("url"):
        return str(img["url"]).strip()
    if isinstance(img, str) and img.startswith("http"):
        return img.strip()
    for k in ("image_url", "imageUrl", "thumbnail_url", "thumbnailUrl", "thumbnail"):
        v = node.get(k)
        if isinstance(v, str) and v.startswith("http"):
            return v.strip()
    return ""


def as_list(payload):
    if payload is None:
        return []
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in ("data", "products", "items", "results"):
            if isinstance(payload.get(k), list):
                return payload[k]
        if isinstance(payload.get("data"), dict):
            d = payload["data"]
            for k in ("products", "items", "results"):
                if isinstance(d.get(k), list):
                    return d[k]
    return []


def row_matches(row, sku: str) -> bool:
    if not row or not isinstance(row, dict):
        return False
    s = str(sku).strip()
    for k in ("sku", "SKU", "product_sku", "productSku"):
        if str(row.get(k) or "").strip() == s:
            return True
    return False


async def fetch_json(session, url, headers):
    async with session.get(url, headers=headers) as resp:
        if resp.status in (401, 403):
            return {"_http": resp.status, "_auth": True}
        if resp.status != 200:
            return {"_http": resp.status}
        try:
            return await resp.json(content_type=None)
        except Exception:
            return {"_http": resp.status, "_parse": True}


async def lookup_one(session, sku, warehouse_id, headers, sem):
    async with sem:
        image = ""
        product_id = None
        name = ""
        last_http = None
        for page in range(1, 4):
            data = await fetch_json(session, build_search_url(sku, warehouse_id, page), headers)
            last_http = data.get("_http") if isinstance(data, dict) else None
            if data.get("_auth"):
                return {"sku": sku, "ok": False, "error": "AUTH_REQUIRED", "http": last_http}
            rows = as_list(data)
            match = next((r for r in rows if row_matches(r, sku)), None)
            if not match and rows and page == 1 and len(rows) == 1:
                match = rows[0]
            if match:
                product_id = (
                    match.get("id")
                    or match.get("product_id")
                    or match.get("productId")
                    or match.get("uuid")
                )
                name = match.get("name") or match.get("product_name") or ""
                image = pick_image(match)
                break
            if not rows:
                break
        if product_id and not image:
            detail = await fetch_json(session, build_detail_url(str(product_id), warehouse_id), headers)
            if detail.get("_auth"):
                return {"sku": sku, "ok": False, "error": "AUTH_REQUIRED", "http": detail.get("_http")}
            # detail may be the product object or wrapped
            node = detail
            if isinstance(detail, dict) and "data" in detail and isinstance(detail["data"], dict):
                node = detail["data"]
            image = pick_image(node) or image
            if not name:
                name = (node or {}).get("name") or ""
        if image:
            return {
                "sku": sku,
                "ok": True,
                "image": image,
                "name": name,
                "productId": str(product_id) if product_id else None,
            }
        return {
            "sku": sku,
            "ok": False,
            "error": "NOT_FOUND_OR_NO_IMAGE",
            "http": last_http,
            "productId": str(product_id) if product_id else None,
        }


async def run(miss_path: Path, session_path: Path, out_dir: Path, concurrency: int):
    miss = json.loads(miss_path.read_text(encoding="utf-8"))
    items = miss.get("items") if isinstance(miss, dict) else miss
    if not isinstance(items, list):
        raise SystemExit("image-miss.json must contain items[]")

    sess = json.loads(session_path.read_text(encoding="utf-8"))
    auth = sess.get("authHeader") or sess.get("authorization") or ""
    if auth and not auth.lower().startswith("bearer "):
        auth = "Bearer " + auth
    cookies = sess.get("cookieHeader") or sess.get("cookie") or ""
    warehouse_id = sess.get("warehouseId") or DEFAULT_WH

    if not auth:
        raise SystemExit("session file missing authHeader")

    skus = []
    seen = set()
    for it in items:
        sku = str(it.get("sku") or "").strip()
        if sku and sku not in seen:
            seen.add(sku)
            skus.append(sku)

    headers = {
        "Accept": "application/json",
        "Authorization": auth,
        "User-Agent": "SmouhaPick-ImageScan/1.0",
    }
    if cookies:
        headers["Cookie"] = cookies

    sem = asyncio.Semaphore(concurrency)
    timeout = aiohttp.ClientTimeout(total=25)
    t0 = time.time()
    results = []
    overrides = {}

    connector = aiohttp.TCPConnector(limit=concurrency)
    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        total = len(skus)
        done = 0

        async def one(sku):
            nonlocal done
            try:
                r = await lookup_one(session, sku, warehouse_id, headers, sem)
            except Exception as e:
                r = {"sku": sku, "ok": False, "error": str(e)[:120]}
            done += 1
            if done % 100 == 0 or done == total:
                print(f"  … {done}/{total}", flush=True)
            results.append(r)
            if r.get("ok") and r.get("image"):
                overrides[sku] = r["image"]

        await asyncio.gather(*(one(s) for s in skus))

    elapsed = round(time.time() - t0, 1)
    out_dir.mkdir(parents=True, exist_ok=True)

    overrides_doc = {
        "version": 1,
        "source": "dmart-miss-only",
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "warehouseId": warehouse_id,
        "count": len(overrides),
        "urls": overrides,
    }
    report = {
        "version": 1,
        "phase": "dmart-miss-fetch",
        "requested": len(skus),
        "withImage": len(overrides),
        "failed": len(skus) - len(overrides),
        "elapsedSec": elapsed,
        "results": results,
    }

    (out_dir / "image-url-overrides.json").write_text(
        json.dumps(overrides_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (out_dir / "dmart-miss-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "requested": len(skus),
                "withImage": len(overrides),
                "failed": len(skus) - len(overrides),
                "elapsedSec": elapsed,
            },
            indent=2,
        )
    )
    print(f"Wrote {out_dir / 'image-url-overrides.json'}")
    print(f"Wrote {out_dir / 'dmart-miss-report.json'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--miss", type=Path, required=True, help="image-miss.json from phase 1")
    ap.add_argument("--session", type=Path, required=True, help="session-export.json from extension")
    ap.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parent / "out")
    ap.add_argument("--concurrency", type=int, default=8, help="Keep low to protect BFF")
    args = ap.parse_args()
    if not args.miss.is_file():
        raise SystemExit(f"miss file not found: {args.miss}")
    if not args.session.is_file():
        raise SystemExit(f"session file not found: {args.session}")
    asyncio.run(run(args.miss, args.session, args.out_dir, args.concurrency))


if __name__ == "__main__":
    main()
