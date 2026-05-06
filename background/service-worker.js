// Brikko Shield — background service worker (MV3, V2).
//
// V2 additions:
//   - Per-tab state map: when a tab navigates off a supported host we drop its
//     last-known mapping_id so a stale id can never be used to "restore" data
//     on an unrelated page (defensive — would have been harmless anyway).
//   - Idempotent BRIKKO_ANONYMIZE: identical text in the same tab returns the
//     cached mapping_id rather than burning a backend call. This protects
//     against the auto-intercept retry path firing twice.

const API_BASE = 'https://api.brikko.ru/v1';
const FETCH_TIMEOUT_MS = 15_000;
const SUPPORTED_HOSTS = ['claude.ai', 'chat.openai.com', 'chatgpt.com'];

// ---------- storage helpers ----------

async function getApiKey() {
  const { brikko_api_key } = await chrome.storage.sync.get('brikko_api_key');
  return brikko_api_key || null;
}

async function getEnabled() {
  const { brikko_enabled } = await chrome.storage.sync.get('brikko_enabled');
  return brikko_enabled !== false; // default ON
}

// ---------- per-tab state ----------
// In-memory only — service worker may be torn down at any time, which is fine:
// a fresh anonymize call simply re-establishes the mapping.

/** @type {Map<number, { lastText: string, masked: string, mappingId: string, host: string | null }>} */
const tabState = new Map();

function isSupportedHost(host) {
  if (!host) return false;
  return SUPPORTED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && !tab?.url) return;
  const url = info.url || tab.url || '';
  try {
    const host = new URL(url).hostname;
    if (!isSupportedHost(host)) tabState.delete(tabId);
  } catch {
    tabState.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

// ---------- API helpers ----------

async function callApi(path, body, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // server returned non-JSON
    }

    if (!res.ok) {
      const message =
        (data && (data.error || data.message)) ||
        `HTTP ${res.status} ${res.statusText}`.trim();
      return { ok: false, status: res.status, error: message };
    }

    return { ok: true, status: res.status, data };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, status: 0, error: 'timeout' };
    }
    return {
      ok: false,
      status: 0,
      error: (err && err.message) || 'network_error',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function anonymize(text, tabId, host) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  const enabled = await getEnabled();
  if (!enabled) return { ok: false, error: 'disabled' };

  // Idempotency: if we just masked this exact text in this tab, reuse.
  if (typeof tabId === 'number') {
    const prev = tabState.get(tabId);
    if (prev && prev.lastText === text && prev.host === host) {
      return {
        ok: true,
        masked: prev.masked,
        mappingId: prev.mappingId,
        entities: [],
        categories: [],
        cached: true,
      };
    }
  }

  const r = await callApi('/anonymize', { text }, apiKey);
  if (!r.ok) return r;

  const data = r.data || {};
  const masked = data.masked ?? data.text ?? null;
  const mappingId = data.mapping_id ?? data.mappingId ?? null;
  if (!masked || !mappingId) {
    return { ok: false, error: 'malformed_response' };
  }

  if (typeof tabId === 'number') {
    tabState.set(tabId, { lastText: text, masked, mappingId, host: host || null });
  }

  return {
    ok: true,
    masked,
    mappingId,
    entities: data.entities || [],
    categories: data.categories || [],
    count: (data.entities && data.entities.length) || 0,
  };
}

async function restore(text, mappingId) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  if (!mappingId) return { ok: false, error: 'no_mapping_id' };

  const r = await callApi('/restore', { text, mapping_id: mappingId }, apiKey);
  if (!r.ok) return r;

  const data = r.data || {};
  const restored = data.restored ?? data.text ?? null;
  if (restored == null) return { ok: false, error: 'malformed_response' };
  return { ok: true, restored };
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  const tabId = sender?.tab?.id;
  let host = null;
  try {
    if (sender?.tab?.url) host = new URL(sender.tab.url).hostname;
  } catch {
    host = null;
  }

  if (msg.type === 'BRIKKO_PING') {
    (async () => {
      const apiKey = await getApiKey();
      const enabled = await getEnabled();
      sendResponse({ ok: true, hasKey: !!apiKey, enabled });
    })();
    return true;
  }

  if (msg.type === 'BRIKKO_ANONYMIZE') {
    (async () => {
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!text.trim()) {
        sendResponse({ ok: false, error: 'empty_text' });
        return;
      }
      const res = await anonymize(text, tabId, host);
      sendResponse(res);
    })();
    return true;
  }

  if (msg.type === 'BRIKKO_RESTORE') {
    (async () => {
      const text = typeof msg.text === 'string' ? msg.text : '';
      const mappingId = typeof msg.mappingId === 'string' ? msg.mappingId : null;
      const res = await restore(text, mappingId);
      sendResponse(res);
    })();
    return true;
  }

  return false;
});

// First-run defaults.
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get([
    'brikko_enabled',
    'auto_intercept',
    'site_enabled',
  ]);
  const patch = {};
  if (cur.brikko_enabled === undefined) patch.brikko_enabled = true;
  if (cur.auto_intercept === undefined) patch.auto_intercept = false;
  if (cur.site_enabled === undefined) {
    patch.site_enabled = { 'claude.ai': true, 'chatgpt.com': true };
  }
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
});
