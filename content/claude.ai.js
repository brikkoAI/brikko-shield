// Brikko Shield — claude.ai adapter (V2).
//
// All UX and protection logic lives in content/_shared.js. This file is just a
// site contract: selectors + a streaming-finished probe. Keep it short.

(() => {
  'use strict';
  if (!window.BrikkoShield) return; // _shared.js must load first

  // Claude uses ProseMirror for the composer. Selectors are ordered most-
  // specific to least, so generic textarea fallback only kicks in when
  // Anthropic ships a redesign.
  const inputSelectors = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"].ProseMirror',
    'div.ProseMirror[contenteditable="true"]',
    'textarea',
  ];

  const sendButtonSelectors = [
    'button[aria-label="Send Message"]',
    'button[aria-label*="Send"]',
    'button[data-testid*="send"]',
    'fieldset button[type="submit"]',
  ];

  const assistantSelectors = [
    '[data-testid="user-message"] ~ div [data-is-streaming]',
    'div.font-claude-message',
    '[data-test-render-count]',
  ];

  // Claude exposes data-is-streaming="true|false" on the assistant block. We
  // treat the absence/false value as "stream finished".
  function isStreamFinished(node) {
    const streaming = node.querySelector('[data-is-streaming="true"]');
    if (streaming) return false;
    const self = node.getAttribute && node.getAttribute('data-is-streaming');
    return self !== 'true';
  }

  window.BrikkoShield.mount({
    host: 'claude.ai',
    inputSelectors,
    sendButtonSelectors,
    assistantSelectors,
    isStreamFinished,
  });
})();
