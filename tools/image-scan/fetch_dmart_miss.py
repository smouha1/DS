#!/usr/bin/env python3
"""
Phase 2 — For EGY-miss SKUs only, fetch real image URL from DMart BFF.

Features:
  - Auto-resume from existing image-url-overrides.json
  - Checkpoint save every 100 SKUs + on Ctrl+C
  - Early abort after 5 consecutive AUTH_REQUIRED (401/403)
  - Auto-detect session-export.json from cwd or ~/Downloads
  - SKU match + image pick parity with extension background.js

Does NOT touch the website live image pipeline.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from urllib.parse import quote

try:
    import aiohttp
except ImportError:
    print("Install deps: pip install -r requirements.txt", file=sys.stderr)
    raise

BFF_BASE = "https://im-bff-live-me.deliveryhero.io/v2/entity"
ENTITY = "HF_EG"
DEFAULT_WH = "d24a9f96-f6bc-43b0-af78-b7067f0c901c"  # Smouha DS60
CHECKPOINT_EVERY = 100
AUTH_ABORT_STREAK = 5


def build_search_url(sku: str, warehouse_id: str, page: int = 1) -> str:
    q = quote(str(sku), safe="")
    wh = quote(str(warehouse_id), safe="")
    return (
        f"{BFF_BASE}/{ENTITY}/warehouse/{wh}/products"
        f"?per_page=50&page={page}&sort=PRODUCT_NAME_ASC&query={q}"
    )


def build_detail_url(product_id: str, warehouse_id: str) -> str:
    pid = quote(str(product_id), safe="")
    wh = quote(str(warehouse_id), safe="")
    return f"{BFF_BASE}/{ENTITY}/warehouse/{wh}/product/{pid}"


def normalize_url(u: str) -> str:
    u = (u or "").strip()
    if not u:
        return ""
    if u.startswith("//"):
        return "https:" + u
    if u.startswith("http://") or u.startswith("https://"):
        return u
    return ""


def pick_image(node) -> str:
    if not node or not isinstance(node, dict):
        return ""

    def from_val(v) -> str:
        if isinstance(v, dict):
            for k in ("url", "src", "href", "link"):
                n = normalize_url(str(v.get(k) or ""))
                if n:
                    return n
            return ""
        if isinstance(v, str):
            return normalize_url(v)
        return ""

    # top-level image object / string
    img = from_val(node.get("image"))
    if img:
        return img

    for k in (
        "image_url",
        "imageUrl",
        "thumbnail_url",
        "thumbnailUrl",
        "thumbnail",
        "primary_image",
        "primaryImage",
        "primary_image_url",
        "primaryImageUrl",
        "photo",
        "picture",
        "media_url",
        "mediaUrl",
    ):
        img = from_val(node.get(k))
        if img:
            return img

    for list_key in ("images", "media", "gallery", "photos"):
        arr = node.get(list_key)
        if not isinstance(arr, list):
            continue
        for item in arr:
            img = from_val(item)
            if img:
                return img

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
    keys = (
        "sku",
        "SKU",
        "product_sku",
        "productSku",
        "sku_code",
        "skuCode",
        "external_id",
        "externalId",
        "merchant_sku",
        "merchantSku",
        "item_code",
        "itemCode",
        "itemcode",
    )
    for k in keys:
        if str(row.get(k) or "").strip() == s:
            return True
    return False


def find_session_file(explicit: Path | None) -> Path:
    if explicit is not None:
        if not explicit.is_file():
            raise SystemExit(f"session file not found: {explicit}")
        return explicit

    cwd_candidate = Path.cwd() / "session-export.json"
    if cwd_candidate.is_file():
        return cwd_candidate

    tool_dir = Path(__file__).resolve().parent
    local = tool_dir / "session-export.json"
    if local.is_file():
        return local

    downloads = Path.home() / "Downloads"
    if downloads.is_dir():
        matches = sorted(
            downloads.glob("session-export*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if matches:
            print(f"Using session from Downloads: {matches[0]}")
            return matches[0]

    raise SystemExit(
        "No session file found. Export from DMart Bridge popup "
        "(Export session for image-scan) or pass --session path."
    )


def load_existing_overrides(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        urls = data.get("urls") if isinstance(data, dict) else None
        if isinstance(urls, dict):
            return {str(k): str(v) for k, v in urls.items() if v}
    except Exception as e:
        print(f"Warning: could not load existing overrides: {e}")
    return {}


def write_overrides(path: Path, overrides: dict, warehouse_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "version": 2,
        "source": "dmart-miss-only",
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "warehouseId": warehouse_id,
        "count": len(overrides),
        "urls": dict(sorted(overrides.items())),
    }
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_report(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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
            data = await fetch_json(
                session, build_search_url(sku, warehouse_id, page), headers
            )
            last_http = data.get("_http") if isinstance(data, dict) else None
            if data.get("_auth"):
                return {
                    "sku": sku,
                    "ok": False,
                    "error": "AUTH_REQUIRED",
                    "http": last_http,
                }
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
            detail = await fetch_json(
                session, build_detail_url(str(product_id), warehouse_id), headers
            )
            if detail.get("_auth"):
                return {
                    "sku": sku,
                    "ok": False,
                    "error": "AUTH_REQUIRED",
                    "http": detail.get("_http"),
                }
            node = detail
            if isinstance(detail, dict) and isinstance(detail.get("data"), dict):
                node = detail["data"]
            image = pick_image(node) or image
            if not name and isinstance(node, dict):
                name = node.get("name") or ""
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


async def run(
    miss_path: Path,
    session_path: Path,
    out_dir: Path,
    concurrency: int,
):
    miss = json.loads(miss_path.read_text(encoding="utf-8"))
    items = miss.get("items") if isinstance(miss, dict) else miss
    if not isinstance(items, list):
        raise SystemExit("image-miss.json must contain items[]")

    sess = json.loads(session_path.read_text(encoding="utf-8"))
    auth = sess.get("authHeader") or sess.get("authorization") or ""
    if auth and not str(auth).lower().startswith("bearer "):
        auth = "Bearer " + auth
    cookies = sess.get("cookieHeader") or sess.get("cookie") or ""
    warehouse_id = sess.get("warehouseId") or DEFAULT_WH

    if not auth:
        raise SystemExit("session file missing authHeader")

    overrides_path = out_dir / "image-url-overrides.json"
    report_path = out_dir / "dmart-miss-report.json"
    overrides = load_existing_overrides(overrides_path)
    if overrides:
        print(f"Resume: loaded {len(overrides)} existing URLs from {overrides_path.name}")

    skus = []
    seen = set()
    for it in items:
        sku = str(it.get("sku") or "").strip()
        if not sku or sku in seen:
            continue
        seen.add(sku)
        if sku in overrides and overrides[sku]:
            continue  # already done
        skus.append(sku)

    print(f"Pending SKUs this run: {len(skus)} (skipped {len(seen) - len(skus)} already done)")
    if not skus:
        print("Nothing left to fetch.")
        write_overrides(overrides_path, overrides, warehouse_id)
        return

    headers = {
        "Accept": "application/json",
        "Authorization": auth,
        "User-Agent": "SmouhaPick-ImageScan/1.1",
    }
    if cookies:
        headers["Cookie"] = cookies

    sem = asyncio.Semaphore(concurrency)
    timeout = aiohttp.ClientTimeout(total=25)
    t0 = time.time()
    results = []
    auth_streak = 0
    abort_auth = False
    completed = 0
    lock = asyncio.Lock()

    connector = aiohttp.TCPConnector(limit=concurrency)

    async def checkpoint():
        write_overrides(overrides_path, overrides, warehouse_id)

    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        total = len(skus)

        async def one(sku: str):
            nonlocal completed, auth_streak, abort_auth
            if abort_auth:
                return
            try:
                r = await lookup_one(session, sku, warehouse_id, headers, sem)
            except Exception as e:
                r = {"sku": sku, "ok": False, "error": str(e)[:120]}

            async with lock:
                if abort_auth:
                    return
                results.append(r)
                if r.get("error") == "AUTH_REQUIRED":
                    auth_streak += 1
                    if auth_streak >= AUTH_ABORT_STREAK:
                        abort_auth = True
                        print(
                            "\n*** AUTH expired (5 consecutive 401/403). "
                            "Saving progress and stopping. ***\n"
                            "Re-export session-export.json from the extension, "
                            "then re-run Phase 2 to resume.\n",
                            flush=True,
                        )
                else:
                    auth_streak = 0

                if r.get("ok") and r.get("image"):
                    overrides[sku] = r["image"]

                completed += 1
                if completed % CHECKPOINT_EVERY == 0 or completed == total:
                    await checkpoint()
                    print(
                        f"  … {completed}/{total}  overrides={len(overrides)}",
                        flush=True,
                    )

        try:
            await asyncio.gather(*(one(s) for s in skus))
        except KeyboardInterrupt:
            print("\nInterrupted — saving checkpoint…", flush=True)
            await checkpoint()
            raise

    elapsed = round(time.time() - t0, 1)
    await checkpoint() if False else write_overrides(overrides_path, overrides, warehouse_id)

    report = {
        "version": 2,
        "phase": "dmart-miss-fetch",
        "requestedThisRun": len(skus),
        "completedThisRun": completed,
        "withImageTotal": len(overrides),
        "failedThisRun": len([r for r in results if not r.get("ok")]),
        "authAborted": abort_auth,
        "elapsedSec": elapsed,
        "results": results,
    }
    write_report(report_path, report)

    print(
        json.dumps(
            {
                "requestedThisRun": len(skus),
                "withImageTotal": len(overrides),
                "failedThisRun": report["failedThisRun"],
                "authAborted": abort_auth,
                "elapsedSec": elapsed,
            },
            indent=2,
        )
    )
    print(f"Wrote {overrides_path}")
    print(f"Wrote {report_path}")
    if abort_auth:
        sys.exit(2)


def main():
    ap = argparse.ArgumentParser(
        description="Phase 2: DMart image fetch for EGY-miss SKUs (resume-safe)"
    )
    ap.add_argument(
        "--miss",
        type=Path,
        default=Path(__file__).resolve().parent / "out" / "image-miss.json",
        help="image-miss.json from phase 1 (default: ./out/image-miss.json)",
    )
    ap.add_argument(
        "--session",
        type=Path,
        default=None,
        help="session-export.json (optional; auto from cwd or ~/Downloads)",
    )
    ap.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "out",
    )
    ap.add_argument(
        "--concurrency",
        type=int,
        default=8,
        help="Keep low to protect BFF (default 8)",
    )
    args = ap.parse_args()
    if not args.miss.is_file():
        raise SystemExit(f"miss file not found: {args.miss}")
    session_path = find_session_file(args.session)
    print(f"Session: {session_path}")
    try:
        asyncio.run(run(args.miss, session_path, args.out_dir, args.concurrency))
    except KeyboardInterrupt:
        print("Stopped by user. Progress saved to image-url-overrides.json")
        sys.exit(130)


if __name__ == "__main__":
    main()
