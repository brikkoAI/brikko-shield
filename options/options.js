// Brikko Shield — options page logic.
//
// Persists everything to chrome.storage.sync. Uses BRIKKO_PING to validate
// API key without burning a real anonymize call (cheap GET-style health check
// the background SW already supports).

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    apiKey: $('api-key'),
    showKey: $('show-key'),
    saveBtn: $('save-btn'),
    saveFeedback: $('save-feedback'),
    apiStatus: $('api-status'),
    enabled: $('enabled-toggle'),
    autoIntercept: $('auto-intercept-toggle'),
    siteClaude: $('site-claude'),
    siteChatgpt: $('site-chatgpt'),
    statToday: $('stat-today'),
  };

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const v = chrome.i18n.getMessage(key);
      if (v) el.textContent = v;
    });
  }

  function setApiStatus(kind, text) {
    els.apiStatus.classList.remove('api-status--ok', 'api-status--err');
    if (kind === 'ok') els.apiStatus.classList.add('api-status--ok');
    if (kind === 'err') els.apiStatus.classList.add('api-status--err');
    els.apiStatus.textContent = text;
  }

  function showFeedback(msg, isError = false) {
    els.saveFeedback.textContent = msg;
    els.saveFeedback.classList.toggle('feedback--err', isError);
    if (!isError) {
      setTimeout(() => {
        els.saveFeedback.textContent = '';
      }, 2200);
    }
  }

  async function load() {
    const data = await chrome.storage.sync.get([
      'brikko_api_key',
      'brikko_enabled',
      'auto_intercept',
      'site_enabled',
      'brikko_stats',
    ]);

    if (data.brikko_api_key) els.apiKey.value = data.brikko_api_key;
    els.enabled.checked = data.brikko_enabled !== false;
    els.autoIntercept.checked = !!data.auto_intercept;

    const sites = data.site_enabled || {};
    els.siteClaude.checked = sites['claude.ai'] !== false;
    els.siteChatgpt.checked = sites['chatgpt.com'] !== false;

    const stats = data.brikko_stats || {};
    const today = new Date().toISOString().slice(0, 10);
    const count = stats.protected_today_date === today ? stats.protected_today || 0 : 0;
    els.statToday.textContent = String(count);

    refreshApiStatus();
  }

  async function refreshApiStatus() {
    const key = (els.apiKey.value || '').trim();
    if (!key) {
      setApiStatus('', chrome.i18n.getMessage('status_inactive') || 'Не настроена');
      return;
    }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'BRIKKO_PING' });
      if (r && r.ok && r.hasKey) {
        setApiStatus('ok', chrome.i18n.getMessage('status_active') || 'Защита активна');
      } else {
        setApiStatus('err', chrome.i18n.getMessage('status_inactive') || 'Не настроена');
      }
    } catch {
      setApiStatus('err', 'Service worker не отвечает');
    }
  }

  // ---- handlers ------------------------------------------------------------

  els.showKey.addEventListener('click', () => {
    els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
    els.apiKey.focus();
  });

  els.saveBtn.addEventListener('click', async () => {
    const v = (els.apiKey.value || '').trim();
    if (!v) {
      showFeedback('Введите ключ', true);
      return;
    }
    await chrome.storage.sync.set({ brikko_api_key: v });
    showFeedback(chrome.i18n.getMessage('saved_label') || 'Сохранено');
    refreshApiStatus();
  });

  els.apiKey.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      els.saveBtn.click();
    }
  });

  els.enabled.addEventListener('change', async () => {
    await chrome.storage.sync.set({ brikko_enabled: els.enabled.checked });
  });

  els.autoIntercept.addEventListener('change', async () => {
    await chrome.storage.sync.set({ auto_intercept: els.autoIntercept.checked });
  });

  async function saveSiteToggles() {
    const map = {
      'claude.ai': els.siteClaude.checked,
      'chatgpt.com': els.siteChatgpt.checked,
    };
    await chrome.storage.sync.set({ site_enabled: map });
  }
  els.siteClaude.addEventListener('change', saveSiteToggles);
  els.siteChatgpt.addEventListener('change', saveSiteToggles);

  document.addEventListener('DOMContentLoaded', () => {
    applyI18n();
    load();
  });
})();
