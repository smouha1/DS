/* ============================================================================
   cycleCountParse.js — Pure Data Normalization & Walk-Path Sorting for Cycle Count
   ----------------------------------------------------------------------------
   Parses DMart BFF payloads:
     - GET /v1/entity/HF_EG/warehouse/{wh}/cycle-count/kpi
     - GET /v3/entity/HF_EG/warehouse/{wh}/cycle-count/list?page=&per_page=
   Handles:
     - Single & Multi-Location items (`location_expiry_mapping[]`)
     - Multi-expiry quantities within the same shelf location
     - Portal recorded counts (`counts[]`: count, recount, im_recount)
     - Natural warehouse aisle sorting (A01-01-001 -> A03-09-004 -> Z99)
     - Realistic DS60 sample batch fallback for offline preview/training
   ============================================================================ */

import * as barcodeLib from './barcode.js';

/** Formats ISO date string (`2026-05-14T00:00:00Z`) to `2026-05-14`. */
export function formatExpiryDate(isoStr) {
  if (!isoStr) return '';
  const s = String(isoStr).trim();
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  try {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  } catch (e) {}
  return s.slice(0, 10);
}

/** Formats ISO timestamp to readable short date/time (`24 Oct · 14:30`). */
export function formatShortTimestamp(isoStr) {
  if (!isoStr) return '—';
  const s = String(isoStr).trim();
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s.slice(0, 16);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(d.getDate()).padStart(2, '0');
    const mon = months[d.getMonth()] || '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${mon} · ${hh}:${mm}`;
  } catch (e) {
    return s.slice(0, 16);
  }
}

/** Normalizes KPI payload from `/v1/entity/HF_EG/warehouse/{wh}/cycle-count/kpi`. */
export function normalizeCycleKpi(raw) {
  const src = (raw && raw.kpi && typeof raw.kpi === 'object') ? raw.kpi : (raw || {});
  const num = (v, def = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  return {
    completedCycles: num(src.number_cycle_count_completed),
    countedSkus: num(src.total_distinct_counted_sku),
    assortmentPct: num(src.share_of_assortment_pct),
    skuDefectPct: num(src.sku_level_defect_rate_pct),
    unitDefectPct: num(src.unit_level_defect_rate_pct),
  };
}

/** Extracts clean barcode list from product node; guarantees at least 1 scannable code (SKU fallback). */
function extractProductBarcodes(prod, skuStr) {
  const seen = new Set();
  const out = [];
  const pushCode = (val) => {
    if (val == null) return;
    const parsed = barcodeLib.parse(String(val));
    if (parsed.length) {
      for (const c of parsed) {
        if (!seen.has(c)) {
          seen.add(c);
          out.push(c);
        }
      }
    } else {
      const s = String(val).trim();
      if (s && /^[0-9A-Za-z_-]{4,36}$/.test(s) && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  };

  if (Array.isArray(prod.barcodes)) prod.barcodes.forEach(pushCode);
  if (Array.isArray(prod.barcode_list)) prod.barcode_list.forEach(pushCode);
  if (prod.barcode) pushCode(prod.barcode);
  if (prod.product_barcode) pushCode(prod.product_barcode);
  if (!out.length && skuStr) pushCode(skuStr);
  return out;
}

/** Resolves best product image URL from cycle payload or EGY_<barcode>.JPG fallback. */
function resolveCycleProductImage(prod, barcodes) {
  if (!prod) return '';
  if (typeof prod.image_url === 'string' && /^https?:\/\//i.test(prod.image_url.trim())) {
    return prod.image_url.trim();
  }
  if (prod.image && typeof prod.image === 'object' && typeof prod.image.url === 'string') {
    const u = prod.image.url.trim();
    if (/^https?:\/\//i.test(u)) return u;
  }
  if (typeof prod.image === 'string' && /^https?:\/\//i.test(prod.image.trim())) {
    return prod.image.trim();
  }
  return barcodeLib.imageUrlFromBarcodes(barcodes) || '';
}

/**
 * Normalizes `location_expiry_mapping[]` and merges portal `counts[]` per location.
 */
export function normalizeProductLocations(prod, onHandQty) {
  const rawLocs = Array.isArray(prod && prod.location_expiry_mapping)
    ? prod.location_expiry_mapping
    : [];
  const rawCounts = Array.isArray(prod && prod.counts) ? prod.counts : [];

  // Map counts by location_name (case-insensitive)
  const countsByLoc = new Map();
  for (const c of rawCounts) {
    if (!c || typeof c !== 'object') continue;
    const k = String(c.location_name || c.location || 'UNSPECIFIED-LOCATION').trim().toUpperCase();
    countsByLoc.set(k, c);
  }

  const locations = [];
  const seenLocKeys = new Set();

  for (const locRow of rawLocs) {
    if (!locRow || typeof locRow !== 'object') continue;
    const locName = String(locRow.location_name || locRow.location || 'UNSPECIFIED-LOCATION').trim() || 'UNSPECIFIED-LOCATION';
    const locKey = locName.toUpperCase();
    seenLocKeys.add(locKey);

    const locType = String(locRow.location_type || locRow.type || 'NORMAL').trim().toUpperCase();
    const isUnspecified = locKey === 'UNSPECIFIED-LOCATION' || locKey === 'NONE' || locKey === 'UNKNOWN';

    const rawQtys = Array.isArray(locRow.quantities) ? locRow.quantities : [];
    const quantities = [];
    let locSystemQty = 0;

    for (const qItem of rawQtys) {
      if (!qItem || typeof qItem !== 'object') continue;
      const qVal = Number(qItem.quantity ?? qItem.qty ?? 0);
      const cleanQty = Number.isFinite(qVal) ? qVal : 0;
      locSystemQty += cleanQty;
      const expRaw = qItem.expiry_date || qItem.expiry || '';
      const expFmt = formatExpiryDate(expRaw);
      quantities.push({
        expiryRaw: expRaw ? String(expRaw) : null,
        expiryFormatted: expFmt || null,
        quantity: cleanQty,
      });
    }

    // If quantities[] was empty on a single-location item, fall back to onHandQty
    if (!rawQtys.length && rawLocs.length === 1 && Number.isFinite(onHandQty)) {
      locSystemQty = onHandQty;
    }

    const cRow = countsByLoc.get(locKey) || null;
    const portalCount = cRow && cRow.count != null && Number.isFinite(Number(cRow.count)) ? Number(cRow.count) : null;
    const portalRecount = cRow && cRow.recount != null && Number.isFinite(Number(cRow.recount)) ? Number(cRow.recount) : null;
    const portalImRecount = cRow && cRow.im_recount != null && Number.isFinite(Number(cRow.im_recount)) ? Number(cRow.im_recount) : null;

    const effectivePortalCount =
      portalImRecount != null
        ? portalImRecount
        : portalRecount != null
          ? portalRecount
          : portalCount;

    const portalDiscrepancy =
      effectivePortalCount != null ? Number((effectivePortalCount - locSystemQty).toFixed(3)) : null;

    locations.push({
      locationName: locName,
      locationType: locType,
      isUnspecified,
      systemQty: Number(locSystemQty.toFixed(3)),
      quantities,
      hasExpiry: quantities.some((q) => !!q.expiryFormatted),
      portalCount,
      portalRecount,
      portalImRecount,
      effectivePortalCount,
      portalDiscrepancy,
      scanTimestamp: cRow ? (cRow.scan_timestamp || null) : null,
      setQtyTimestamp: cRow ? (cRow.set_qty_timestamp || null) : null,
    });
  }

  // Include any orphan counts[] whose location wasn't in location_expiry_mapping
  for (const c of rawCounts) {
    if (!c || typeof c !== 'object') continue;
    const locName = String(c.location_name || c.location || 'UNSPECIFIED-LOCATION').trim() || 'UNSPECIFIED-LOCATION';
    const locKey = locName.toUpperCase();
    if (seenLocKeys.has(locKey)) continue;
    seenLocKeys.add(locKey);

    const portalCount = c.count != null && Number.isFinite(Number(c.count)) ? Number(c.count) : null;
    const portalRecount = c.recount != null && Number.isFinite(Number(c.recount)) ? Number(c.recount) : null;
    const portalImRecount = c.im_recount != null && Number.isFinite(Number(c.im_recount)) ? Number(c.im_recount) : null;
    const effectivePortalCount = portalImRecount ?? portalRecount ?? portalCount;
    const sysQ = !rawLocs.length && Number.isFinite(onHandQty) ? onHandQty : 0;

    locations.push({
      locationName: locName,
      locationType: 'NORMAL',
      isUnspecified: locKey === 'UNSPECIFIED-LOCATION',
      systemQty: sysQ,
      quantities: [],
      hasExpiry: false,
      portalCount,
      portalRecount,
      portalImRecount,
      effectivePortalCount,
      portalDiscrepancy: effectivePortalCount != null ? Number((effectivePortalCount - sysQ).toFixed(3)) : null,
      scanTimestamp: c.scan_timestamp || null,
      setQtyTimestamp: c.set_qty_timestamp || null,
    });
  }

  // Fallback if both location_expiry_mapping and counts were empty
  if (!locations.length) {
    locations.push({
      locationName: 'UNSPECIFIED-LOCATION',
      locationType: 'NONE',
      isUnspecified: true,
      systemQty: Number.isFinite(onHandQty) ? onHandQty : 0,
      quantities: [],
      hasExpiry: false,
      portalCount: null,
      portalRecount: null,
      portalImRecount: null,
      effectivePortalCount: null,
      portalDiscrepancy: null,
      scanTimestamp: null,
      setQtyTimestamp: null,
    });
  }

  // Sort locations within an item: physical shelf codes (A01..Z99) first in natural order, UNSPECIFIED last
  locations.sort((a, b) => {
    if (a.isUnspecified !== b.isUnspecified) return a.isUnspecified ? 1 : -1;
    return a.locationName.localeCompare(b.locationName, undefined, { numeric: true, sensitivity: 'base' });
  });

  return locations;
}

/**
 * Normalizes a full `/v3/entity/HF_EG/warehouse/{wh}/cycle-count/list` response.
 */
export function normalizeCycleListPayload(rawPayload) {
  const root = (rawPayload && rawPayload.raw && typeof rawPayload.raw === 'object')
    ? rawPayload.raw
    : (rawPayload || {});

  let rawItems = [];
  if (Array.isArray(root.items)) rawItems = root.items;
  else if (Array.isArray(root.results)) rawItems = root.results;
  else if (Array.isArray(root.data)) rawItems = root.data;
  else if (Array.isArray(root)) rawItems = root;

  const cycles = [];
  const flatBatches = [];

  for (const cyc of rawItems) {
    if (!cyc || typeof cyc !== 'object') continue;
    const cycleId = String(cyc.id || cyc.uuid || '');
    const cycleRef = cyc.reference != null ? String(cyc.reference) : (cycleId.slice(0, 8) || '—');
    const strategy = String(cyc.strategy || 'MANUAL').toUpperCase();
    const isDeletable = !!cyc.is_deletable;
    const createdAt = cyc.created_at || cyc.createdAt || null;
    const updatedAt = cyc.updated_at || cyc.updatedAt || null;

    const rawBatches = Array.isArray(cyc.batches) ? cyc.batches : [];
    const normalizedBatches = [];

    for (const b of rawBatches) {
      if (!b || typeof b !== 'object') continue;
      const batchId = String(b.id || b.uuid || `${cycleId}_${b.reference || 0}`);
      const batchRef = b.reference != null ? String(b.reference) : (batchId.slice(0, 8) || '—');
      const status = String(b.status || 'UNASSIGNED').toUpperCase();
      const pickedBy = b.picked_by || b.pickedBy || b.picker_name || null;
      const batchUpdatedAt = b.updated_at || b.updatedAt || updatedAt || null;
      const batchCompletedAt = b.completed_at || b.completedAt || null;

      const rawProducts = Array.isArray(b.products) ? b.products : [];
      const products = [];
      let totalLocationsCount = 0;
      let multiLocationSkusCount = 0;
      let totalExpectedUnits = 0;
      let portalCountedLocations = 0;
      let portalDiscrepancyCount = 0;

      for (let idx = 0; idx < rawProducts.length; idx++) {
        const p = rawProducts[idx];
        if (!p || typeof p !== 'object') continue;
        const sku = String(p.sku || p.SKU || p.product_sku || '').trim();
        const productId = String(p.id || p.product_id || sku || idx);
        const name = String(p.name || p.product_name || sku || 'Unnamed Product').trim();
        const onHandRaw = Number(p.on_hand_quantity ?? p.onHandQuantity ?? 0);
        const onHandQty = Number.isFinite(onHandRaw) ? Number(onHandRaw.toFixed(3)) : 0;
        const isWeighted = !!p.is_weighted;
        const weightBuffer = Number(p.weight_buffer || 0);

        const barcodes = extractProductBarcodes(p, sku);
        const imageUrl = resolveCycleProductImage(p, barcodes);
        const locations = normalizeProductLocations(p, onHandQty);

        totalLocationsCount += locations.length;
        if (locations.length > 1) multiLocationSkusCount += 1;
        totalExpectedUnits += onHandQty;

        let itemHasPortalDiscrepancy = false;
        for (const loc of locations) {
          if (loc.effectivePortalCount != null) {
            portalCountedLocations += 1;
            if (loc.portalDiscrepancy !== 0) {
              itemHasPortalDiscrepancy = true;
            }
          }
        }
        if (itemHasPortalDiscrepancy) portalDiscrepancyCount += 1;

        const firstShelfLoc = locations.find((l) => !l.isUnspecified) || locations[0];
        const primaryAisleSortKey = firstShelfLoc && !firstShelfLoc.isUnspecified
          ? firstShelfLoc.locationName
          : 'ZZZZ-UNSPECIFIED-' + sku;

        products.push({
          portalIndex: idx + 1,
          id: productId,
          sku,
          name,
          barcodes,
          primaryBarcode: barcodes[0] || sku,
          imageUrl,
          onHandQty,
          isWeighted,
          weightBuffer,
          locations,
          locationCount: locations.length,
          isMultiLocation: locations.length > 1,
          itemHasPortalDiscrepancy,
          primaryAisleSortKey,
        });
      }

      const batchObj = {
        id: batchId,
        reference: batchRef,
        cycleId,
        cycleReference: cycleRef,
        strategy,
        isDeletable,
        status,
        isCompleted: status === 'COMPLETED' || status === 'CLOSED' || status === 'DONE',
        pickedBy: pickedBy ? String(pickedBy) : null,
        updatedAt: batchUpdatedAt,
        completedAt: batchCompletedAt,
        products,
        skuCount: products.length,
        totalLocationsCount,
        multiLocationSkusCount,
        totalExpectedUnits: Number(totalExpectedUnits.toFixed(2)),
        portalCountedLocations,
        portalDiscrepancyCount,
      };

      normalizedBatches.push(batchObj);
      flatBatches.push(batchObj);
    }

    cycles.push({
      id: cycleId,
      reference: cycleRef,
      strategy,
      isDeletable,
      createdAt,
      updatedAt,
      batches: normalizedBatches,
    });
  }

  return {
    cycles,
    batches: flatBatches,
    totalCycles: Number(root.total || root.total_count || cycles.length),
  };
}

/**
 * Checks if a Cycle Count product matches a user search or barcode scan query.
 * Supports:
 *   1) Exact or substring match on SKU
 *   2) Exact or substring match on any barcode in `barcodes[]`
 *   3) Last-6 digits suffix match on SKU or any barcode
 *   4) Location code match (e.g. `A03-09` or `E01-06-003`)
 *   5) Product name substring match
 */
export function productMatchesCycleQuery(product, queryRaw) {
  if (!product || !queryRaw) return true;
  const q = String(queryRaw).trim().toLowerCase();
  if (!q) return true;

  const skuLower = String(product.sku || '').toLowerCase();
  if (skuLower === q || skuLower.includes(q)) return true;

  for (const bc of product.barcodes || []) {
    const bcl = String(bc).toLowerCase();
    if (bcl === q || bcl.includes(q)) return true;
    if (q.length >= 5 && bcl.endsWith(q)) return true;
  }

  for (const loc of product.locations || []) {
    if (String(loc.locationName || '').toLowerCase().includes(q)) return true;
  }

  if (String(product.name || '').toLowerCase().includes(q)) return true;
  return false;
}

/**
 * Exact scan resolver within a batch (for Zebra / Pelican scanner jump):
 * Prioritizes exact barcode -> exact SKU -> last-6 barcode/SKU suffix.
 */
export function findProductByScanCode(products, codeRaw) {
  if (!Array.isArray(products) || !codeRaw) return null;
  const code = String(codeRaw).trim();
  if (!code) return null;

  // 1) Exact barcode match
  let hit = products.find((p) => (p.barcodes || []).some((bc) => String(bc) === code));
  if (hit) return hit;

  // 2) Exact SKU match
  hit = products.find((p) => String(p.sku) === code);
  if (hit) return hit;

  // 3) Last-6 suffix match on barcode or SKU
  if (code.length >= 6) {
    const suffix6 = code.slice(-6);
    hit = products.find(
      (p) =>
        (p.barcodes || []).some((bc) => String(bc).endsWith(suffix6)) ||
        String(p.sku).endsWith(suffix6)
    );
    if (hit) return hit;
  }

  return null;
}

/**
 * Realistic DS60 Sample Payload modeled on the verified `cycle.har` records
 * (Cycle #792013 / Batch #3358930 Unassigned + Completed Batch with SKU 927332,
 * multi-location SKU 904842 across A03-09-004 & A03-11-004, multi-barcode items, etc.)
 */
export function getSampleCycleData() {
  return {
    kpi: {
      number_cycle_count_completed: 4,
      total_distinct_counted_sku: 1505,
      share_of_assortment_pct: 8.334256,
      sku_level_defect_rate_pct: 3.8538206,
      unit_level_defect_rate_pct: 0,
    },
    list: {
      total: 2,
      items: [
        {
          id: 'c792013-ds60-sample-open',
          reference: 792013,
          strategy: 'MANUAL',
          is_deletable: true,
          updated_at: '2026-10-23T18:40:00Z',
          batches: [
            {
              id: 'b3358930-ds60-open',
              reference: 3358930,
              status: 'UNASSIGNED',
              picked_by: null,
              updated_at: '2026-10-23T18:40:00Z',
              products: [
                {
                  id: 'prod-904842',
                  sku: '904842',
                  name: 'Crystal Sunflower Oil 1.6L (زيت عباد الشمس كريستال 1.6 لتر)',
                  barcodes: ['6221007004218', '6221007004225'],
                  image_url: 'https://talabat.dhmedia.io/image/darkstores-eg/EGY_6221007004218.JPG',
                  on_hand_quantity: 47,
                  is_weighted: false,
                  location_expiry_mapping: [
                    {
                      location_name: 'A03-09-004',
                      location_type: 'NORMAL',
                      quantities: [
                        { expiry_date: '2026-12-15T00:00:00Z', quantity: 3 }
                      ]
                    },
                    {
                      location_name: 'A03-11-004',
                      location_type: 'NORMAL',
                      quantities: [
                        { expiry_date: '2027-04-10T00:00:00Z', quantity: 44 }
                      ]
                    }
                  ],
                  counts: null
                },
                {
                  id: 'prod-300800',
                  sku: '300800',
                  name: 'Juhayna Full Cream Milk 1L (لبن كامل الدسم جهينة 1 لتر)',
                  barcodes: ['6221014010011', '6221014010028'],
                  image_url: 'https://talabat.dhmedia.io/image/darkstores-eg/EGY_6221014010011.JPG',
                  on_hand_quantity: 28,
                  is_weighted: false,
                  location_expiry_mapping: [
                    {
                      location_name: 'C01-03-008',
                      location_type: 'NORMAL',
                      quantities: [
                        { expiry_date: '2026-05-14T00:00:00Z', quantity: 18 },
                        { expiry_date: '2026-06-20T00:00:00Z', quantity: 10 }
                      ]
                    }
                  ],
                  counts: null
                },
                {
                  id: 'prod-300709',
                  sku: '300709',
                  name: 'Almarai Fresh Milk Full Fat 1L (حليب المراعي كامل الدسم)',
                  barcodes: ['6281007041126'],
                  image_url: 'https://talabat.dhmedia.io/image/darkstores-eg/EGY_6281007041126.JPG',
                  on_hand_quantity: 19,
                  is_weighted: false,
                  location_expiry_mapping: [
                    {
                      location_name: 'B02-04-002',
                      location_type: 'NORMAL',
                      quantities: [
                        { expiry_date: '2026-11-05T00:00:00Z', quantity: 7 }
                      ]
                    },
                    {
                      location_name: 'D04-02-001',
                      location_type: 'NORMAL',
                      quantities: [
                        { expiry_date: '2026-11-18T00:00:00Z', quantity: 12 }
                      ]
                    }
                  ],
                  counts: null
                },
                {
                  id: 'prod-690014',
                  sku: '690014',
                  name: 'Domty Plus White Feta Cheese 500g (جبنة فيتا دومتي بلس)',
                  barcodes: ['6223001362507'],
                  image_url: 'https://talabat.dhmedia.io/image/darkstores-eg/EGY_6223001362507.JPG',
                  on_hand_quantity: 15,
                  is_weighted: false,
                  location_expiry_mapping: [
                    {
                      location_name: 'C02-01-005',
                      location_type: 'NORMAL',
                      quantities: [
                        { expiry_date: '2026-11-30T00:00:00Z', quantity: 15 }
                      ]
                    }
                  ],
                  counts: null
                }
              ]
            }
          ]
        },
        {
          id: 'c791890-ds60-sample-done',
          reference: 791890,
          strategy: 'MANUAL',
          is_deletable: false,
          updated_at: '2026-10-22T15:20:00Z',
          batches: [
            {
              id: 'b3354112-ds60-done',
              reference: 3354112,
              status: 'COMPLETED',
              picked_by: 'Smouha DS60 Team',
              updated_at: '2026-10-22T15:20:00Z',
              completed_at: '2026-10-22T15:20:00Z',
              products: [
                {
                  id: 'prod-927332',
                  sku: '927332',
                  name: 'Nescafe Classic Instant Coffee Jar 200g',
                  barcodes: ['6221034001242'],
                  image_url: 'https://talabat.dhmedia.io/image/darkstores-eg/EGY_6221034001242.JPG',
                  on_hand_quantity: 12,
                  is_weighted: false,
                  location_expiry_mapping: [
                    {
                      location_name: 'E01-06-003',
                      location_type: 'NORMAL',
                      quantities: [
                        { expiry_date: '2027-08-01T00:00:00Z', quantity: 12 }
                      ]
                    }
                  ],
                  counts: [
                    {
                      location_name: 'E01-06-003',
                      count: 12,
                      recount: null,
                      im_recount: null,
                      scan_timestamp: '2026-10-22T15:12:10Z',
                      set_qty_timestamp: '2026-10-22T15:12:18Z'
                    }
                  ]
                },
                {
                  id: 'prod-500424',
                  sku: '500424',
                  name: 'Chipsy Family Pack Salt & Vinegar',
                  barcodes: ['6223000500424'],
                  image_url: 'https://talabat.dhmedia.io/image/darkstores-eg/EGY_6223000500424.JPG',
                  on_hand_quantity: 22,
                  is_weighted: false,
                  location_expiry_mapping: [
                    {
                      location_name: 'A01-02-003',
                      location_type: 'NORMAL',
                      quantities: [
                        { expiry_date: '2026-12-10T00:00:00Z', quantity: 10 }
                      ]
                    },
                    {
                      location_name: 'A01-04-001',
                      location_type: 'NORMAL',
                      quantities: [
                        { expiry_date: '2027-01-15T00:00:00Z', quantity: 12 }
                      ]
                    }
                  ],
                  counts: [
                    {
                      location_name: 'A01-02-003',
                      count: 10,
                      recount: null,
                      im_recount: null
                    },
                    {
                      location_name: 'A01-04-001',
                      count: 11,
                      recount: 11,
                      im_recount: null
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  };
}
