/* ============================================================================
   dmart.js — MODULE: dmart
   ------------------------------------------------------------------------
   Builds Dmart Portal deep links.

   Warehouse ID is now dynamic (provided by warehouse.js).
   The URL pattern itself is intentionally unchanged from the production
   version that was already confirmed working:

     https://portal.talabat.com/pv2/eg/p/inventory/w/{WAREHOUSE_ID}
       ?search={SKU}&is_active=0&is_available=0&is_sample=0&sort=0&page=1

   Only the WAREHOUSE_ID segment is substituted. SKU encoding and query
   parameters remain exactly as before.

   Shopper Orders URL still uses its own dedicated warehouse ID constant
   (historically the Smouha ID) because that endpoint is independent of
   the inventory warehouse selector.
   ============================================================================ */

import { getSelectedId, buildInventoryUrl as whBuildInventoryUrl, buildInventoryBrowseUrl as whBuildBrowseUrl } from './warehouse.js';

/** Fallback only if warehouse module has not finished initialising yet. */
const LEGACY_FALLBACK_ID = 'd24a9f96-f6bc-43b0-af78-b7067f0c901c';

const SHOPPER_WAREHOUSE_ID = 'd24a9f96-f6bc-43b0-af78-b7067f0c901c';

export function buildDmartInventoryUrl(sku) {
  const id = getSelectedId();
  if (id) return whBuildInventoryUrl(sku);
  return `https://portal.talabat.com/pv2/eg/p/inventory/w/${LEGACY_FALLBACK_ID}?search=${encodeURIComponent(sku)}&is_active=0&is_available=0&is_sample=0&sort=0&page=1`;
}

export function buildDmartInventoryBrowseUrl() {
  const id = getSelectedId();
  if (id) return whBuildBrowseUrl();
  return `https://portal.talabat.com/pv2/eg/p/inventory/w/${LEGACY_FALLBACK_ID}?search=&is_active=0&is_available=0&is_sample=0&sort=0&page=1`;
}

export function buildShopperOrdersUrl(startDate) {
  // Unchanged: shopper-orders endpoint is independent of the inventory
  // warehouse selector. Preserves the exact previously-hardcoded date.
  const date = startDate || '2026-05-27';
  return `https://portal.talabat.com/pv2/eg/p/shopper/orders/all?status=READY_FOR_PICKUP&warehouseId=${SHOPPER_WAREHOUSE_ID}&startDate=${date}`;
}
