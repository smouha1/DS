"""Shared EGY URL builder — must match assets/js/barcode.js imageUrlFromBarcodes."""
from __future__ import annotations

import re
from typing import List

DELIMS = re.compile(r"[,;|/+\s]+")
BASE = "https://talabat.dhmedia.io/image/darkstores-eg/EGY_"


def parse_barcodes(raw) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        parts = [str(x).strip() for x in raw if x is not None]
    else:
        parts = [p.strip() for p in DELIMS.split(str(raw)) if p.strip()]
    out = []
    for p in parts:
        if re.fullmatch(r"[0-9A-Za-z]{4,32}", p):
            out.append(p)
    return out


def egy_url_from_barcodes(barcodes_or_raw) -> str:
    lst = barcodes_or_raw if isinstance(barcodes_or_raw, list) else parse_barcodes(barcodes_or_raw)
    if not lst:
        return ""
    primary = str(lst[0]).strip()
    if len(primary) == 14 and primary[0] == "0" and primary.isdigit():
        primary = primary[1:]
    return f"{BASE}{primary}.JPG"


def row_fields(row):
    """products.json row: [name, sku, barcode] or dict."""
    if isinstance(row, (list, tuple)):
        name = row[0] if len(row) > 0 else ""
        sku = row[1] if len(row) > 1 else ""
        barcode_raw = row[2] if len(row) > 2 else ""
    elif isinstance(row, dict):
        name = row.get("name") or ""
        sku = row.get("sku") or ""
        barcode_raw = row.get("barcode") or row.get("barcodes") or ""
    else:
        return "", "", [], ""
    bcs = parse_barcodes(barcode_raw)
    url = egy_url_from_barcodes(bcs)
    return str(name or ""), str(sku or ""), bcs, url
