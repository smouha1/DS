#!/usr/bin/env python3
"""Generate data/products-search.json from data/products.json (no image URLs).

Usage (from project root Smoha-Pick/):
  python3 tools/generate-search-catalog.py

Safe to run after every products.json update before deploy.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "products.json"
DST = ROOT / "data" / "products-search.json"


def main() -> int:
    if not SRC.is_file():
        print(f"ERROR: missing {SRC}", file=sys.stderr)
        return 1
    raw = json.loads(SRC.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        print("ERROR: products.json must be a JSON array", file=sys.stderr)
        return 1
    slim = []
    for row in raw:
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            continue
        name, sku, barcode = row[0], row[1], row[2]
        slim.append([name, sku, barcode])
    DST.write_text(
        json.dumps(slim, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    src_sz = SRC.stat().st_size
    dst_sz = DST.stat().st_size
    print(f"OK  products={len(slim)}")
    print(f"    {SRC.name}: {src_sz:,} bytes")
    print(f"    {DST.name}: {dst_sz:,} bytes ({100 * dst_sz / max(src_sz, 1):.1f}% of full)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
