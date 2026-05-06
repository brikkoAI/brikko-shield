// Brikko Shield — popup logic

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const apiKeyInput = $('api-key');
  const showKeyBtn = $('show-key');
  const saveBtn = $('save-btn');
  const feedback = $('save-feedback');
  const enabledToggle = $('enabled-toggle');
  const statusDot = $('status-dot');
  const statusText = $('status-text');

  // ---- i18n -----------------------------------------------------------------
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const v = chrome.i18n.getMessage(key);
      if (v) el.textContent = v;
    });
    apiKeyInput.placeholder =
      chrome.i18n.getMessage('api_key_placeholder') || apiKeyInput.placeholder;
  }

  // ---- state ----------------------------------------------------------------
  function setStatus(kind) {
    statusDot.classList.remove('status__dot--on', 'status__dot--off', 'status__dot--paused');
    if (kind === 'on') {
      statusDot.classList.add('status__dot--on');
      statusText.textContent = chrome.i18n.getMessage('status_active') || 'Защита активна';
    } else if (kind === 'paused') {
      statusDot.classList.add('status__dot--paused');
      statusText.textContent = chrome.i18n.getMessage('status_paused') || 'Приостановлена';
    } else {
      statusDot.classList.add('status__dot--off');
      statusText.textContent = chrome.i18n.getMessage('status_inactive') || 'Не настроена';
    }
  }

  function recomputeStatus() {
    const hasKey = !!(apiKeyInput.value || '').trim();
    const enabled = enabledToggle.checked;
    if (!hasKey) setStatus('off');
    else if (!enabled) setStatus('paused');
    else setStatus('on');
  }

  function showFeedback(msg, isError = false) {
    feedback.textContent = msg;
    feedback.classList.toggle('feedback--err', isError);
    if (!isError) {
      setTimeout(() => {
        feedback.textContent = '';
      }, 2200);
    }
  }

  // ---- load ----------------------------------------------------------------
  async function load() {
    const { brikko_api_key, brikko_enabled } = await chrome.storage.sync.get([
      'brikko_api_key',
      'brikko_enabled',
    ]);
    if (brikko_api_key) apiKeyInput.value = brikko_api_key;
    enabledToggle.checked = brikko_enabled !== false;
    recomputeStatus();
  }

  // ---- handlers ------------------------------------------------------------
  showKeyBtn.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    apiKeyInput.focus();
  });

  saveBtn.addEventListener('click', async () => {
    const v = (apiKeyInput.value || '').trim();
    if (!v) {
      showFeedback('Введите ключ', true);
      return;
    }
    await chrome.storage.sync.set({ brikko_api_key: v });
    showFeedback(chrome.i18n.getMessage('saved_label') || 'Сохранено');
    recomputeStatus();
  });

  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });

  apiKeyInput.addEventListener('input', recomputeStatus);

  enabledToggle.addEventListener('change', async () => {
    await chrome.storage.sync.set({ brikko_enabled: enabledToggle.checked });
    recomputeStatus();
  });

  // ---- init -----------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    applyI18n();
    load();
  });
})();
