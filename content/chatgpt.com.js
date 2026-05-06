// Brikko Shield — chat.openai.com / chatgpt.com adapter (V2).
//
// ChatGPT uses a real <textarea id="prompt-textarea"> (sometimes wrapped in a
// contenteditable Lexical editor in newer builds). We give a four-deep fallback
// chain because OpenAI ships DOM changes more often than Anthropic does.

(() => {
  'use strict';
  if (!window.BrikkoShield) return;

  const inputSelectors = [
    'textarea#prompt-textarea',
    'textarea[data-id="root"]',
    'div#prompt-textarea[contenteditable="true"]',
    'form textarea',
  ];

  const sendButtonSelectors = [
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label*="Send"]',
    'form button[type="submit"]',
  ];

  const assistantSelectors = [
    '[data-message-author-role="assistant"]',
    'div.markdown.prose',
    '[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
    'main article[data-testid^="conversation-turn-"]:nth-last-child(odd)',
  ];

  // ChatGPT marks the actively-streaming assistant turn with a "result-
  // streaming" class on a descendant, OR by the absence of a "data-message-id"
  // attribute on intermediate nodes. We rely on the class because it's the
  // canonical signal across recent builds.
  function isStreamFinished(node) {
    if (node.querySelector('.result-streaming')) return false;
    if (node.classList && node.classList.contains('result-streaming')) return false;
    return true;
  }

  window.BrikkoShield.mount({
    host: 'chatgpt.com',
    inputSelectors,
    sendButtonSelectors,
    assistantSelectors,
    isStreamFinished,
  });
})();
