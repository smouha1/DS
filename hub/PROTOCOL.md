# Smouha LAN Hub Protocol

## Roles
- **Master**: one browser tab on the PC with extension Online. Opens SSE `/api/events?role=master`.
- **Phone**: HTTP client only (no SSE). Stock, lookup, adjust, recent via POST.

## Error shape (all endpoints)
```json
{ "ok": false, "success": false, "error": { "code": "MASTER_OFFLINE", "message": "..." } }
```
Success stock: `{ "ok": true, "onHand", "reserved", "price", "image?" }`  
Success adjust: `{ "success": true, "data": { ... } }`

## Codes
MASTER_OFFLINE, EXTENSION_OFFLINE, NOT_APPROVED, KICKED, VIEWER, TIMEOUT, DEVICE_LIMIT, SHIFT_LOCKED, SKU_LOCKED

## Image flow
1. Master replies stock ASAP (may omit image).
2. Master POST `/api/image` when lookup completes → Hub caches `lastImage[sku]`.
3. Phone polls GET `/api/image?sku=` (retries 0.8s / 2s / 4s).

## Auth
- Master replies should send `X-Master-Token` from SSE hello frame.
- Kick frees `approved` slot; kicked devices cannot auto-rejoin without Master approve/unkick.
