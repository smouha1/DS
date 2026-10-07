/**
 * Shared Hub error normalization + user-facing messages.
 */
export const HUB_ERROR_MESSAGES = {
  MASTER_OFFLINE: 'Master PC offline — open the site on the branch PC',
  EXTENSION_OFFLINE: 'Extension offline — open DMart portal on the PC',
  NOT_APPROVED: 'Waiting for Master approval',
  KICKED: 'Device was removed by Master — Save & Test again',
  VIEWER: 'Viewer cannot adjust stock',
  TIMEOUT: 'Timed out — check extension on Master PC',
  DEVICE_LIMIT: 'Device limit reached — ask Master to approve or free a slot',
  SHIFT_LOCKED: 'Shift is locked — ask Master to unlock',
  SKU_LOCKED: 'SKU locked by another device — wait a few seconds',
  NO_HUB: 'Hub URL not set',
  HUB: 'Hub connection error',
  HUB_MALFORMED: 'Hub answered unexpectedly — try again',
  ADJUST_FAILED: 'Adjust failed — check extension on Master PC',
  BAD_REQUEST: 'Invalid request',
  FORBIDDEN: 'Not allowed',
  NOT_FOUND: 'Not found',
  SERVER: 'Hub server error',
};

/**
 * Normalize any Hub JSON / HTTP failure into { ok:false, reason, message, code }.
 */
export function normalizeHubError(j, r) {
  const errRaw = j && j.error;
  let code = 'HUB';
  let message = '';
  if (typeof errRaw === 'string') {
    code = errRaw;
    message = (j && j.message) || errRaw;
  } else if (errRaw && typeof errRaw === 'object') {
    code = errRaw.code || 'HUB';
    message = errRaw.message || (j && j.message) || code;
  } else if (j && j.reason) {
    code = typeof j.reason === 'string' ? j.reason : 'HUB';
    message = (j && j.message) || code;
  } else if (r && !r.ok) {
    code = 'HTTP_' + r.status;
    message = (j && j.message) || r.statusText || code;
  }
  const friendly = HUB_ERROR_MESSAGES[code] || message || code;
  return {
    ok: false,
    success: false,
    reason: String(code),
    code: String(code),
    message: String(friendly),
    error: { code: String(code), message: String(friendly) },
    via: 'hub',
  };
}

export function friendlyHubMessage(code, fallback) {
  return HUB_ERROR_MESSAGES[code] || fallback || code || 'Error';
}
