// Brikko Shield — shared content-script runtime (V2).
//
// This module is loaded BEFORE every site-specific content script. It exposes
// a single global `BrikkoShield` with two entry points:
//
//   BrikkoShield.mount(adapter) → wires up badge, manual button, auto-intercept
//   BrikkoShield.utils          → low-level helpers (alignment, storage, i18n)
//
// Why a shared layer (and not just two parallel files)?
//   ~80% of claude.ai logic is identical to chatgpt.com — badge UX, anonymize
//   call, post-stream restore, alignment math. Duplicating it means two places
//   to keep in sync every time Anthropic / OpenAI ships a DOM change.
//
// The adapter is a small per-site contract (selectors + send-trigger), nothing
// more. Site files stay short and easy to audit.

(() => {
  'use strict';
  if (window.__brikkoShieldShared) return;
  window.__brikkoShieldShared = true;

  // ---- i18n -----------------------------------------------------------------

  function i18n(key) {
    try {
      const v = chrome.i18n.getMessage(key);
      return v || key;
    } catch {
      return key;
    }
  }

  // ---- storage / settings ---------------------------------------------------
  // Cached snapshot, kept in-sync via chrome.storage.onChanged so we don't hit
  // storage on every keystroke when auto-intercept is enabled.

  const SETTINGS_DEFAULTS = {
    brikko_enabled: true,
    auto_intercept: false,
    site_enabled: { 'claude.ai': true, 'chatgpt.com': true },
    brikko_stats: { protected_today: 0, protected_today_date: null },
  };

  /** @type {typeof SETTINGS_DEFAULTS} */
  let settings = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  let settingsReady = false;
  /** @type {(() => void)[]} */
  const settingsWaiters = [];

  async function loadSettings() {
    const all = await chrome.storage.sync.get(Object.keys(SETTINGS_DEFAULTS));
    for (const k of Object.keys(SETTINGS_DEFAULTS)) {
      if (all[k] !== undefined) settings[k] = all[k];
    }
    settingsReady = true;
    while (settingsWaiters.length) settingsWaiters.shift()();
  }

  function whenSettingsReady() {
    if (settingsReady) return Promise.resolve();
    return new Promise((res) => settingsWaiters.push(res));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k of Object.keys(changes)) {
      if (k in settings) settings[k] = changes[k].newValue ?? SETTINGS_DEFAULTS[k];
    }
  });

  function siteEnabled(host) {
    if (!settings.brikko_enabled) return false;
    const map = settings.site_enabled || {};
    return map[host] !== false; // default ON for known hosts
  }

  function autoInterceptEnabled() {
    return !!settings.auto_intercept;
  }

  async function bumpProtectedCount() {
    const today = new Date().toISOString().slice(0, 10);
    const stats = settings.brikko_stats || { protected_today: 0, protected_today_date: null };
    const next =
      stats.protected_today_date === today
        ? { protected_today: stats.protected_today + 1, protected_today_date: today }
        : { protected_today: 1, protected_today_date: today };
    settings.brikko_stats = next;
    try {
      await chrome.storage.sync.set({ brikko_stats: next });
    } catch {
      // best-effort, never block UX on storage failure
    }
  }

  // ---- badge ----------------------------------------------------------------

  /** @type {HTMLElement | null} */
  let badgeEl = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let badgeHideTimer = null;

  function ensureBadge() {
    if (badgeEl && document.body.contains(badgeEl)) return;
    const el = document.createElement('div');
    el.className = 'brikko-badge brikko-badge--idle';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.display = 'none';
    el.textContent = i18n('badge_protected');
    document.body.appendChild(el);
    badgeEl = el;
  }

  function showBadge(kind) {
    ensureBadge();
    if (!badgeEl) return;
    const map = {
      idle: { text: i18n('badge_protected'), cls: 'brikko-badge--idle' },
      working: { text: i18n('badge_protecting'), cls: 'brikko-badge--working' },
      protected: { text: '✓ ' + i18n('badge_protected'), cls: 'brikko-badge--ok' },
      error: { text: '✗ ' + i18n('badge_error'), cls: 'brikko-badge--err' },
    };
    const m = map[kind] || map.idle;
    badgeEl.className = 'brikko-badge ' + m.cls;
    badgeEl.textContent = m.text;
    badgeEl.style.display = 'flex';
    badgeEl.classList.remove('brikko-badge--fade');
    if (badgeHideTimer) clearTimeout(badgeHideTimer);
    if (kind === 'protected') {
      badgeHideTimer = setTimeout(() => {
        if (badgeEl) badgeEl.classList.add('brikko-badge--fade');
      }, 4000);
    } else if (kind === 'error') {
      badgeHideTimer = setTimeout(() => {
        if (badgeEl) badgeEl.classList.add('brikko-badge--fade');
      }, 6000);
    }
  }

  function hideBadge() {
    if (badgeEl) badgeEl.style.display = 'none';
  }

  // ---- input read/write -----------------------------------------------------

  function readInputText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function writeInputText(el, text) {
    if (!el) return;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // contenteditable / ProseMirror — replace contents with a single <p>.
    el.focus();
    while (el.firstChild) el.removeChild(el.firstChild);
    const p = document.createElement('p');
    p.textContent = text;
    el.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }

  // ---- placeholder alignment (used for restore) -----------------------------

  function buildPlaceholderMap(masked, restored) {
    const map = new Map();
    const re = /<[A-Z][A-Z0-9_]*_\d+>/g;
    let mIdx = 0;
    let rIdx = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const tag = m[0];
      const before = masked.slice(mIdx, m.index);
      if (restored.slice(rIdx, rIdx + before.length) !== before) return map;
      rIdx += before.length;
      mIdx = m.index + tag.length;
      const nextLiteralStart = mIdx;
      const nextTag = re.exec(masked);
      const nextLiteralEnd = nextTag ? nextTag.index : masked.length;
      re.lastIndex = mIdx;
      const nextLiteral = masked.slice(nextLiteralStart, nextLiteralEnd);
      const found =
        nextLiteral.length === 0
          ? restored.length
          : restored.indexOf(nextLiteral, rIdx);
      if (found === -1) return map;
      const originalValue = restored.slice(rIdx, found);
      if (!map.has(tag)) map.set(tag, originalValue);
      rIdx = found;
    }
    return map;
  }

  function replaceTextInNode(node, original, restored) {
    const placeholderRe = /<[A-Z][A-Z0-9_]*_\d+>/g;
    const map = buildPlaceholderMap(original, restored);
    if (!map.size) return false;

    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    /** @type {Text[]} */
    const targets = [];
    while (walker.nextNode()) {
      const tn = /** @type {Text} */ (walker.currentNode);
      if (tn.nodeValue && placeholderRe.test(tn.nodeValue)) {
        targets.push(tn);
      }
      placeholderRe.lastIndex = 0;
    }
    for (const tn of targets) {
      tn.nodeValue = tn.nodeValue.replace(/<[A-Z][A-Z0-9_]*_\d+>/g, (m) => {
        return map.get(m) ?? m;
      });
    }
    return true;
  }

  // ---- selector chains ------------------------------------------------------

  function findFirst(selectors, root) {
    const r = root || document;
    for (const sel of selectors) {
      try {
        const el = r.querySelector(sel);
        if (el) return el;
      } catch {
        // bad selector — skip
      }
    }
    return null;
  }

  function findAll(selectors, root) {
    const r = root || document;
    const out = new Set();
    for (const sel of selectors) {
      try {
        r.querySelectorAll(sel).forEach((n) => out.add(n));
      } catch {
        // skip
      }
    }
    return [...out];
  }

  // ---- API bridge -----------------------------------------------------------

  async function callAnonymize(text) {
    try {
      return await chrome.runtime.sendMessage({ type: 'BRIKKO_ANONYMIZE', text });
    } catch (e) {
      return { ok: false, error: 'runtime_error' };
    }
  }

  async function callRestore(text, mappingId) {
    try {
      return await chrome.runtime.sendMessage({
        type: 'BRIKKO_RESTORE',
        text,
        mappingId,
      });
    } catch (e) {
      return { ok: false, error: 'runtime_error' };
    }
  }

  // ---- main mount -----------------------------------------------------------
  //
  // Adapter contract:
  //   {
  //     host: 'claude.ai' | 'chatgpt.com',
  //     inputSelectors: string[],
  //     sendButtonSelectors: string[],
  //     assistantSelectors: string[],
  //     // Hook called once an assistant block looks finished — host-specific
  //     // because the streaming "done" signal differs (data-is-streaming on
  //     // Claude, missing class on ChatGPT etc.).
  //     isStreamFinished?: (node: Element) => boolean,
  //   }

  function mount(adapter) {
    if (window.__brikkoShieldMounted) return;
    window.__brikkoShieldMounted = true;

    /** @type {{ lastMappingId: string | null, lastMasked: string | null, restored: WeakSet<Element>, buttonEl: HTMLButtonElement | null, inflight: boolean }} */
    const state = {
      lastMappingId: null,
      lastMasked: null,
      restored: new WeakSet(),
      buttonEl: null,
      inflight: false,
    };

    loadSettings();

    function findInput() {
      return findFirst(adapter.inputSelectors);
    }

    function findSendButton() {
      return findFirst(adapter.sendButtonSelectors);
    }

    // ---- manual button (V1-compatible UX) -----------------------------------

    function ensureButton() {
      if (!siteEnabled(adapter.host)) {
        if (state.buttonEl) state.buttonEl.style.display = 'none';
        return;
      }
      const input = findInput();
      if (!input) return;

      if (state.buttonEl && document.body.contains(state.buttonEl)) {
        anchorButton(input, state.buttonEl);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'brikko-shield-btn';
      btn.setAttribute('aria-label', i18n('shield_button'));
      btn.textContent = '🛡 ' + i18n('shield_button');
      btn.addEventListener('click', onManualClick);
      document.body.appendChild(btn);
      state.buttonEl = btn;
      anchorButton(input, btn);
    }

    function anchorButton(input, btn) {
      const r = input.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        btn.style.display = 'none';
        return;
      }
      btn.style.display = 'inline-flex';
      btn.style.position = 'fixed';
      btn.style.top = `${Math.max(8, r.top - 36)}px`;
      btn.style.left = `${Math.max(8, r.right - 120)}px`;
      btn.style.zIndex = '2147483646';
    }

    function setButtonState(s) {
      if (!state.buttonEl) return;
      if (s === 'working') {
        state.buttonEl.disabled = true;
        state.buttonEl.textContent = '… ' + i18n('shield_button_working');
      } else {
        state.buttonEl.disabled = false;
        state.buttonEl.textContent = '🛡 ' + i18n('shield_button');
      }
    }

    async function onManualClick(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      const input = findInput();
      if (!input) return;
      await runAnonymize(input, /* triggerSend */ false);
    }

    // ---- auto-intercept on Enter --------------------------------------------
    // We listen at document level (capture phase) so we beat the site's own
    // submit handler. preventDefault stops the user's plaintext from being
    // submitted. After mask succeeds we re-trigger send via the host's Send
    // button — that path is more robust than synthesizing a keydown, which
    // most sites ignore for security reasons.

    /** @type {WeakSet<Element>} */
    const wiredInputs = new WeakSet();

    function wireInputs() {
      const input = findInput();
      if (!input || wiredInputs.has(input)) return;
      wiredInputs.add(input);
      input.addEventListener('keydown', onInputKeydown, /* capture */ true);
    }

    /** @param {KeyboardEvent} ev */
    async function onInputKeydown(ev) {
      if (!autoInterceptEnabled()) return;
      if (!siteEnabled(adapter.host)) return;
      if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;

      const input = ev.currentTarget;
      const text = readInputText(input).trim();
      if (!text) return;

      // If user already submitted a masked prompt and didn't type new content,
      // let it through.
      if (state.lastMasked && readInputText(input).trim() === state.lastMasked.trim()) {
        return;
      }

      ev.preventDefault();
      ev.stopImmediatePropagation();

      const ok = await runAnonymize(input, /* triggerSend */ true);
      // If anonymize failed, we already showed the error badge inside
      // runAnonymize; we DO NOT submit. The user's plaintext stays in the
      // input — surfacing the failure visibly is the safe default for a
      // privacy product.
      void ok;
    }

    async function runAnonymize(input, triggerSend) {
      if (state.inflight) return false;
      const original = readInputText(input).trim();
      if (!original) return false;

      state.inflight = true;
      setButtonState('working');
      showBadge('working');

      const resp = await callAnonymize(original);
      state.inflight = false;

      if (!resp || !resp.ok) {
        setButtonState('idle');
        showBadge('error');
        if (resp && resp.error === 'no_api_key') {
          // Lightweight nudge — no modal, no console.log.
          if (state.buttonEl) {
            const prev = state.buttonEl.textContent;
            state.buttonEl.textContent = '⚠ ' + i18n('status_inactive');
            setTimeout(() => {
              if (state.buttonEl && state.buttonEl.isConnected) state.buttonEl.textContent = prev;
            }, 1800);
          }
        }
        return false;
      }

      // Empty-mask shortcut: backend tells us nothing was masked → don't
      // pollute the UI with a "protected" badge for a no-op.
      const entitiesCount =
        (resp.entities && resp.entities.length) || resp.count || 0;
      const wroteSomething = resp.masked !== original;

      if (!wroteSomething && !entitiesCount) {
        setButtonState('idle');
        hideBadge();
        if (triggerSend) {
          // Nothing to mask — let user's original Enter through by
          // re-dispatching synthesized submit via the Send button.
          clickSend();
        }
        return true;
      }

      writeInputText(input, resp.masked);
      state.lastMappingId = resp.mappingId;
      state.lastMasked = resp.masked;
      setButtonState('idle');
      showBadge('protected');
      void bumpProtectedCount();

      if (triggerSend) {
        // Give React/ProseMirror a tick to flush before we click Send.
        setTimeout(clickSend, 30);
      }
      return true;
    }

    function clickSend() {
      const btn = findSendButton();
      if (!btn) return;
      // Some sites disable the button until input event flushes — wait one
      // animation frame and retry once.
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
        requestAnimationFrame(() => {
          const b2 = findSendButton();
          if (b2 && !b2.disabled) b2.click();
        });
        return;
      }
      btn.click();
    }

    // ---- assistant restore --------------------------------------------------

    /** @type {WeakMap<Element, ReturnType<typeof setTimeout>>} */
    const restoreTimers = new WeakMap();

    function scheduleRestore(node) {
      if (!state.lastMappingId) return;
      if (state.restored.has(node)) return;
      const t = restoreTimers.get(node);
      if (t) clearTimeout(t);
      restoreTimers.set(
        node,
        setTimeout(() => runRestore(node), 600),
      );
    }

    async function runRestore(node) {
      if (!node || !node.isConnected) return;
      if (state.restored.has(node)) return;
      if (adapter.isStreamFinished && !adapter.isStreamFinished(node)) {
        // Streaming still in flight — try again later.
        const t = setTimeout(() => runRestore(node), 600);
        restoreTimers.set(node, t);
        return;
      }

      const text = node.innerText || '';
      if (!text.includes('<') || !text.includes('>')) {
        state.restored.add(node);
        return;
      }
      const mappingId = state.lastMappingId;
      if (!mappingId) return;

      const resp = await callRestore(text, mappingId);
      if (!resp || !resp.ok || typeof resp.restored !== 'string') return;
      if (resp.restored === text) {
        state.restored.add(node);
        return;
      }
      replaceTextInNode(node, text, resp.restored);
      state.restored.add(node);
      showBadge('protected');
    }

    function findAssistantNodes() {
      return findAll(adapter.assistantSelectors);
    }

    // ---- bootstrap loop -----------------------------------------------------

    async function tick() {
      await whenSettingsReady();
      ensureBadge();
      ensureButton();
      wireInputs();
      findAssistantNodes().forEach(scheduleRestore);
    }

    const obs = new MutationObserver(() => tick());
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const reanchor = () => {
      if (state.buttonEl) {
        const input = findInput();
        if (input) anchorButton(input, state.buttonEl);
      }
    };
    window.addEventListener('resize', reanchor);
    window.addEventListener('scroll', reanchor, { passive: true });

    tick();
  }

  // ---- export ---------------------------------------------------------------

  window.BrikkoShield = {
    mount,
    utils: {
      i18n,
      readInputText,
      writeInputText,
      buildPlaceholderMap,
      replaceTextInNode,
      findFirst,
      findAll,
      siteEnabled,
      autoInterceptEnabled,
      whenSettingsReady,
    },
  };
})();
