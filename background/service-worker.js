// Brikko Shield — background service worker (MV3)
// Responsibilities:
//   - Hold the API key in chrome.storage.sync
//   - Proxy anonymize / restore calls to api.brikko.ru (content scripts cannot
//     hit api.brikko.ru directly without host_permissions, and we keep the
//     fetch out of page-context to avoid CSP collisions on claude.ai)

const API_BASE = 'https://api.brikko.ru/v1';
const FETCH_TIMEOUT_MS = 15_000;

// ---------- storage helpers ----------

async function getApiKey() {
  const { brikko_api_key } = await chrome.storage.sync.get('brikko_api_key');
  return brikko_api_key || null;
}

async function getEnabled() {
  const { brikko_enabled } = await chrome.storage.sync.get('brikko_enabled');
  // default ON
  return brikko_enabled !== false;
}

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

async function anonymize(text) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  const enabled = await getEnabled();
  if (!enabled) return { ok: false, error: 'disabled' };

  const r = await callApi('/anonymize', { text }, apiKey);
  if (!r.ok) return r;

  // Backend contract (per BRIKKO spec): { masked: string, mapping_id: string,
  // entities?: [...], categories?: [...] }
  const data = r.data || {};
  const masked = data.masked ?? data.text ?? null;
  const mappingId = data.mapping_id ?? data.mappingId ?? null;
  if (!masked || !mappingId) {
    return { ok: false, error: 'malformed_response' };
  }
  return {
    ok: true,
    masked,
    mappingId,
    entities: data.entities || [],
    categories: data.categories || [],
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'BRIKKO_PING') {
    (async () => {
      const apiKey = await getApiKey();
      const enabled = await getEnabled();
      sendResponse({
        ok: true,
        hasKey: !!apiKey,
        enabled,
      });
    })();
    return true; // async
  }

  if (msg.type === 'BRIKKO_ANONYMIZE') {
    (async () => {
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!text.trim()) {
        sendResponse({ ok: false, error: 'empty_text' });
        return;
      }
      const res = await anonymize(text);
      sendResponse(res);
    })();
    return true;
  }

  if (msg.type === 'BRIKKO_RESTORE') {
    (async () => {
      const text = typeof msg.text === 'string' ? msg.text : '';
      const mappingId =
        typeof msg.mappingId === 'string' ? msg.mappingId : null;
      const res = await restore(text, mappingId);
      sendResponse(res);
    })();
    return true;
  }

  return false;
});

// First-run defaults.
chrome.runtime.onInstalled.addListener(async () => {
  const { brikko_enabled } = await chrome.storage.sync.get('brikko_enabled');
  if (brikko_enabled === undefined) {
    await chrome.storage.sync.set({ brikko_enabled: true });
  }
});
