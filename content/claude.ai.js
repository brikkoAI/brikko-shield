// Brikko Shield — content script for claude.ai
//
// MVP strategy (manual mode, by design):
//   1. We inject a "Защитить" button next to Claude's input area.
//   2. User clicks it → we send the typed text to the background, get masked
//      text + mapping_id, write masked text back into the contenteditable.
//   3. User reviews the masked draft and presses Send themselves.
//   4. We MutationObserver assistant messages and post-process them through
//      /v1/restore so the user reads original entities back.
//
// Why manual instead of auto-intercept:
//   - claude.ai uses ProseMirror; the model receives text from React state,
//     not from DOM innerText. Hijacking submit reliably needs deeper hooks
//     and is the leading source of breakage every time Anthropic ships a UI.
//   - A visible button is also better UX: the user *knows* their data was
//     sanitized before hitting the network. Trust > convenience for a
//     security extension.
//   - This keeps the MVP to one DOM-write per user action.

(() => {
  'use strict';

  if (window.__brikkoShieldLoaded) return;
  window.__brikkoShieldLoaded = true;

  // ---- selectors (claude.ai, 2026-05) ---------------------------------------
  // Primary: ProseMirror contenteditable. Falls back to any textarea.
  const INPUT_SELECTORS = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"].ProseMirror',
    'div.ProseMirror[contenteditable="true"]',
    'textarea',
  ];

  const ASSISTANT_MESSAGE_SELECTORS = [
    '[data-testid="user-message"] ~ div [data-is-streaming]',
    'div.font-claude-message',
    '[data-test-render-count]',
  ];

  // ---- per-tab state --------------------------------------------------------
  const state = {
    lastMappingId: null,
    badgeEl: null,
    buttonEl: null,
    /** @type {WeakSet<Element>} */
    restoredAssistantNodes: new WeakSet(),
  };

  // ---- helpers --------------------------------------------------------------

  function findInput() {
    for (const sel of INPUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function getInputText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function setInputText(el, text) {
    if (!el) return;
    if (el.tagName === 'TEXTAREA') {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // contenteditable / ProseMirror — reset to a single text node so
    // ProseMirror's internal model rebuilds cleanly on next input event.
    el.focus();
    while (el.firstChild) el.removeChild(el.firstChild);
    const p = document.createElement('p');
    p.textContent = text;
    el.appendChild(p);
    // Place caret at the end.
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

  function showBadge(state_) {
    if (!state.badgeEl) return;
    const map = {
      idle: { text: i18n('badge_protected'), cls: 'brikko-badge--idle' },
      working: { text: i18n('badge_protecting'), cls: 'brikko-badge--working' },
      protected: { text: '✓ ' + i18n('badge_protected'), cls: 'brikko-badge--ok' },
      error: { text: i18n('badge_error'), cls: 'brikko-badge--err' },
    };
    const m = map[state_] || map.idle;
    state.badgeEl.className = 'brikko-badge ' + m.cls;
    state.badgeEl.textContent = m.text;
    state.badgeEl.style.display = 'flex';
    if (state_ === 'protected') {
      clearTimeout(state.badgeEl.__hideTimer);
      state.badgeEl.__hideTimer = setTimeout(() => {
        if (state.badgeEl) state.badgeEl.classList.add('brikko-badge--fade');
      }, 4000);
    } else {
      state.badgeEl.classList.remove('brikko-badge--fade');
    }
  }

  function i18n(key) {
    try {
      const v = chrome.i18n.getMessage(key);
      return v || key;
    } catch {
      return key;
    }
  }

  function ensureBadge() {
    if (state.badgeEl && document.body.contains(state.badgeEl)) return;
    const el = document.createElement('div');
    el.className = 'brikko-badge brikko-badge--idle';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.display = 'none';
    el.textContent = i18n('badge_protected');
    document.body.appendChild(el);
    state.badgeEl = el;
  }

  function ensureShieldButton() {
    const input = findInput();
    if (!input) return;

    // Reuse existing button if still in DOM.
    if (state.buttonEl && document.body.contains(state.buttonEl)) {
      // Re-anchor near the input every time, in case Claude re-renders.
      anchorButton(input, state.buttonEl);
      return;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'brikko-shield-btn';
    btn.setAttribute('aria-label', i18n('shield_button'));
    btn.textContent = '🛡 ' + i18n('shield_button');
    btn.addEventListener('click', onShieldClick);
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
    // Anchor above-right of the input, fixed positioning so layout shifts
    // in the page don't drag it around.
    btn.style.position = 'fixed';
    btn.style.top = `${Math.max(8, r.top - 36)}px`;
    btn.style.left = `${Math.max(8, r.right - btn.offsetWidth - 4 || r.right - 120)}px`;
    btn.style.zIndex = '2147483646';
  }

  // ---- core action: shield the current draft -------------------------------

  let inflight = false;
  async function onShieldClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (inflight) return;

    const input = findInput();
    if (!input) return;

    const original = getInputText(input).trim();
    if (!original) {
      flashButton(state.buttonEl, i18n('shield_button'));
      return;
    }

    inflight = true;
    setButtonState('working');
    showBadge('working');

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'BRIKKO_ANONYMIZE',
        text: original,
      });
    } catch (e) {
      resp = { ok: false, error: 'runtime_error' };
    }

    inflight = false;

    if (!resp || !resp.ok) {
      setButtonState('idle');
      showBadge('error');
      console.warn('[Brikko Shield] anonymize failed:', resp && resp.error);
      // Surface the most actionable case: missing API key.
      if (resp && resp.error === 'no_api_key') {
        flashButton(state.buttonEl, '⚠ ' + i18n('status_inactive'));
      }
      return;
    }

    setInputText(input, resp.masked);
    state.lastMappingId = resp.mappingId;
    setButtonState('idle');
    showBadge('protected');
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

  function flashButton(btn, text) {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = text;
    setTimeout(() => {
      if (btn && btn.isConnected) btn.textContent = prev;
    }, 1800);
  }

  // ---- assistant response restore ------------------------------------------
  //
  // After Claude streams its answer, we walk new assistant message blocks and
  // call /v1/restore on their full text once the streaming finishes (i.e. the
  // node text stops mutating for ~600ms). We then swap text nodes in-place.
  //
  // For MVP this is a best-effort: if restoration fails we leave the rendered
  // placeholders alone (better than corrupting the message).

  const debounceMap = new WeakMap();

  function findAssistantNodes() {
    const nodes = new Set();
    for (const sel of ASSISTANT_MESSAGE_SELECTORS) {
      document.querySelectorAll(sel).forEach((n) => nodes.add(n));
    }
    return [...nodes];
  }

  function scheduleRestore(node) {
    if (!state.lastMappingId) return;
    if (state.restoredAssistantNodes.has(node)) return;
    clearTimeout(debounceMap.get(node));
    debounceMap.set(
      node,
      setTimeout(() => runRestore(node), 600),
    );
  }

  async function runRestore(node) {
    if (!node || !node.isConnected) return;
    if (state.restoredAssistantNodes.has(node)) return;
    const text = node.innerText || '';
    if (!text.includes('<') || !text.includes('>')) {
      // No placeholder shape, nothing to restore.
      state.restoredAssistantNodes.add(node);
      return;
    }
    const mappingId = state.lastMappingId;
    if (!mappingId) return;

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'BRIKKO_RESTORE',
        text,
        mappingId,
      });
    } catch {
      resp = { ok: false };
    }

    if (!resp || !resp.ok || typeof resp.restored !== 'string') return;
    if (resp.restored === text) {
      state.restoredAssistantNodes.add(node);
      return;
    }

    replaceTextInNode(node, text, resp.restored);
    state.restoredAssistantNodes.add(node);
    showBadge('protected');
  }

  function replaceTextInNode(node, original, restored) {
    // Naive but safe approach: replace each contiguous text node where its
    // text appears in `original`, mapping placeholders → restored values.
    // We only swap leaves that contain a `<XXX_N>` token, which keeps the
    // surrounding markdown rendering intact.
    const placeholderRe = /<[A-Z][A-Z0-9_]*_\d+>/g;

    // Build a placeholder → original substring map by aligning the two strings
    // on placeholder positions.
    const map = buildPlaceholderMap(original, restored);
    if (!map.size) return;

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
  }

  function buildPlaceholderMap(masked, restored) {
    // Walk both strings keeping equal prefixes, every time `masked` hits a
    // placeholder token, the chunk in `restored` up to the next equal segment
    // is the original value for that placeholder.
    const map = new Map();
    const re = /<[A-Z][A-Z0-9_]*_\d+>/g;
    let mIdx = 0;
    let rIdx = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const tag = m[0];
      const before = masked.slice(mIdx, m.index);
      // Advance both by the literal `before`. If they don't match, alignment
      // failed (e.g. Claude paraphrased) — bail out, leave the placeholder.
      if (restored.slice(rIdx, rIdx + before.length) !== before) return map;
      rIdx += before.length;
      mIdx = m.index + tag.length;
      // Find the next literal segment after the tag.
      const nextLiteralStart = mIdx;
      const nextTag = re.exec(masked);
      const nextLiteralEnd = nextTag ? nextTag.index : masked.length;
      // Reset re state to the position we just consumed.
      re.lastIndex = mIdx;
      const nextLiteral = masked.slice(nextLiteralStart, nextLiteralEnd);
      // Find where that literal appears in `restored` after rIdx.
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

  // ---- bootstrap ------------------------------------------------------------

  function tick() {
    ensureBadge();
    ensureShieldButton();
    findAssistantNodes().forEach(scheduleRestore);
  }

  const obs = new MutationObserver(() => tick());
  obs.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Re-anchor button on resize / scroll so it tracks the input.
  window.addEventListener('resize', () => {
    if (state.buttonEl) {
      const input = findInput();
      if (input) anchorButton(input, state.buttonEl);
    }
  });
  window.addEventListener(
    'scroll',
    () => {
      if (state.buttonEl) {
        const input = findInput();
        if (input) anchorButton(input, state.buttonEl);
      }
    },
    { passive: true },
  );

  // First paint.
  tick();
})();
