// ContextArmor AI - Content Script
// Injects floating guardrails HUD into ChatGPT, Claude, and Gemini
'use strict';

const API_BASE = 'http://127.0.0.1:8000';
let hudInjected = false;
let currentInput = null;
let scanDebounceTimer = null;
let hudHost = null;
let shadowRoot = null;
let isBackendOnline = false;
let liveScanSequence = 0;

// ─── Platform Detection ───────────────────────────────────────────────────────

function detectPlatform() {
  const host = window.location.hostname;
  if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return 'chatgpt';
  if (host.includes('claude.ai')) return 'claude';
  if (host.includes('gemini.google.com')) return 'gemini';
  return 'unknown';
}

// ─── Prompt Input Selectors ───────────────────────────────────────────────────

const SELECTORS = {
  chatgpt: ['#prompt-textarea', 'textarea[data-id="root"]', '[contenteditable="true"][data-placeholder*="Message"]', 'form [contenteditable="true"]'],
  claude: ['div[contenteditable="true"].ProseMirror', 'fieldset div[contenteditable="true"]', 'div[contenteditable="true"][data-placeholder]'],
  gemini: ['rich-textarea div[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'rich-textarea textarea']
};

function findPromptInput() {
  const platform = detectPlatform();
  const selectors = SELECTORS[platform] || ['textarea', 'div[contenteditable="true"]'];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && (el.offsetHeight > 0 || el.offsetWidth > 0) && !el.disabled && !el.readOnly) return el;
  }
  return null;
}

// ─── Text Extraction ──────────────────────────────────────────────────────────

function getPromptText(element) {
  if (!element) return '';
  if (element.tagName === 'TEXTAREA') {
    return element.value;
  }
  // contenteditable div
  return element.innerText || element.textContent || '';
}

// ─── Text Setting ─────────────────────────────────────────────────────────────

function setPromptInputValue(element, newText) {
  if (!element) return;

  if (element.tagName === 'TEXTAREA') {
    // Native input value setter to trigger React synthetic events
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    );
    if (nativeInputValueSetter && nativeInputValueSetter.set) {
      nativeInputValueSetter.set.call(element, newText);
    } else {
      element.value = newText;
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: newText
    }));
  } else {
    // contenteditable — try execCommand first for ProseMirror compatibility
    element.focus();
    try {
      document.execCommand('selectAll', false, null);
      const inserted = document.execCommand('insertText', false, newText);
      if (!inserted) throw new Error('execCommand failed');
    } catch (_) {
      // Fallback: direct innerText assignment
      element.innerText = newText;
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true, composed: true, inputType: 'insertText', data: newText
      }));
    }
  }
}

// ─── Conversation Scraping ────────────────────────────────────────────────────

function scrapeConversationMessages() {
  const platform = detectPlatform();
  const messages = [];

  if (platform === 'chatgpt') {
    const turns = document.querySelectorAll('[data-message-author-role]');
    turns.forEach(el => {
      const role = el.getAttribute('data-message-author-role');
      const content = el.innerText.trim();
      if (content) {
        messages.push({ role: role === 'user' ? 'user' : 'assistant', content });
      }
    });
    if (messages.length > 0) return messages;
  }

  if (platform === 'claude') {
    // Primary selectors for Claude's conversation structure
    const humanTurns = document.querySelectorAll('.human-turn');
    const botTurns = document.querySelectorAll('.bot-turn');

    if (humanTurns.length > 0 || botTurns.length > 0) {
      // Collect all turns with position info and sort by DOM order
      const allTurns = [];
      humanTurns.forEach(el => {
        allTurns.push({ el, role: 'user', index: getElementDomIndex(el) });
      });
      botTurns.forEach(el => {
        allTurns.push({ el, role: 'assistant', index: getElementDomIndex(el) });
      });
      allTurns.sort((a, b) => a.index - b.index);
      allTurns.forEach(({ el, role }) => {
        const content = el.innerText.trim();
        if (content) messages.push({ role, content });
      });
      if (messages.length > 0) return messages;
    }

    // Fallback: streaming div parents
    const streamingEls = document.querySelectorAll('[data-is-streaming]');
    streamingEls.forEach(el => {
      const parent = el.closest('[class*="turn"], [class*="message"]') || el.parentElement;
      if (parent) {
        const role = parent.classList.contains('human') || parent.classList.contains('user') ? 'user' : 'assistant';
        const content = parent.innerText.trim();
        if (content) messages.push({ role, content });
      }
    });
    if (messages.length > 0) return messages;
  }

  if (platform === 'gemini') {
    // Try Gemini conversation selectors
    const userQueries = document.querySelectorAll('.conversation-container .user-query, .user-query-container, [data-turn-role="user"]');
    const modelResponses = document.querySelectorAll('.conversation-container .model-response, .response-container, [data-turn-role="model"]');

    if (userQueries.length > 0 || modelResponses.length > 0) {
      const allTurns = [];
      userQueries.forEach(el => {
        allTurns.push({ el, role: 'user', index: getElementDomIndex(el) });
      });
      modelResponses.forEach(el => {
        allTurns.push({ el, role: 'assistant', index: getElementDomIndex(el) });
      });
      allTurns.sort((a, b) => a.index - b.index);
      allTurns.forEach(({ el, role }) => {
        const content = el.innerText.trim();
        if (content) messages.push({ role, content });
      });
      if (messages.length > 0) return messages;
    }
  }

  // ── Universal Fallback ────────────────────────────────────────────────────
  // Try common role-based patterns used across AI chat UIs
  const roleEls = document.querySelectorAll(
    '[data-role], [data-author], [class*="user-message"], [class*="assistant-message"], ' +
    '[class*="human-message"], [class*="bot-message"], [class*="ai-message"]'
  );

  if (roleEls.length > 0) {
    roleEls.forEach(el => {
      const roleAttr = (el.getAttribute('data-role') || el.getAttribute('data-author') || '').toLowerCase();
      const classList = el.className.toLowerCase();
      let role = 'assistant';
      if (roleAttr.includes('user') || roleAttr.includes('human') ||
          classList.includes('user') || classList.includes('human')) {
        role = 'user';
      }
      const content = el.innerText.trim();
      if (content) messages.push({ role, content });
    });
    if (messages.length > 0) return messages;
  }

  // Last resort: alternating pattern heuristic
  const possibleTurns = document.querySelectorAll('article, [class*="message"], [class*="turn"]');
  let lastRole = 'assistant';
  possibleTurns.forEach(el => {
    // Skip deeply nested duplicates
    if (el.closest('[class*="message"] [class*="message"]')) return;
    const content = el.innerText.trim();
    if (!content || content.length < 2) return;
    const role = lastRole === 'user' ? 'assistant' : 'user';
    lastRole = role;
    messages.push({ role, content });
  });

  return messages;
}

/** Helper: returns a comparable DOM position index for sorting */
function getElementDomIndex(el) {
  let index = 0;
  let node = el;
  while (node) {
    if (node.previousElementSibling) {
      node = node.previousElementSibling;
      index++;
    } else {
      node = node.parentElement;
      if (node) index += 1000; // weight parent traversal
    }
  }
  return index;
}

// ─── Backend Status Check ─────────────────────────────────────────────────────

async function checkBackendStatus() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${API_BASE}/`, {
      signal: controller.signal,
      method: 'GET',
      cache: 'no-store'
    });
    clearTimeout(timeoutId);
    isBackendOnline = response.ok;
  } catch (_) {
    isBackendOnline = false;
  }
  clearTimeout(timeoutId);
  return isBackendOnline;
}

// ─── Client-Side Scan ─────────────────────────────────────────────────────────

function clientSideScan(text) {
  if (!text || typeof text !== 'string') {
    return { riskScore: 0, action: 'ALLOW', hasPII: false, hasSecret: false, hasInjection: false };
  }

  // PII patterns
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const phoneRegex = /(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?)(\d{3}[\s.\-]?\d{4})/g;
  const ssnRegex = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
  const creditCardRegex = /\b(?:\d{4}[\s\-]?){3}\d{4}\b/g;

  // Secret patterns
  const openAIKeyRegex = /\bsk-[a-zA-Z0-9]{20,}\b/g;
  const awsKeyRegex = /\bAKIA[A-Z0-9]{16}\b/g;
  const githubTokenRegex = /\bghp_[a-zA-Z0-9]{36}\b/g;
  const genericSecretRegex = /\b(api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*['"]?[a-zA-Z0-9+/\-_]{8,}/gi;

  // Prompt injection patterns
  const injectionPatterns = [
    /ignore\s+all\s+previous\s+(instructions?|prompts?|rules?)/gi,
    /disregard\s+(all\s+)?(previous\s+)?(instructions?|context)/gi,
    /you\s+are\s+now\s+(a\s+)?(different|new)\s+(ai|assistant|bot|model)/gi,
    /forget\s+(everything|all|your)\s+(you|previous|prior)/gi,
    /act\s+as\s+if\s+you\s+(have\s+no|don't\s+have)\s+(restrictions?|rules?|guidelines?)/gi,
    /jailbreak/gi,
    /\bDAN\b/g,
    /do\s+anything\s+now/gi,
    /override\s+(your\s+)?(safety|content)\s+(filter|policy|restriction)/gi
  ];

  const hasMatch = (pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(text);
    pattern.lastIndex = 0;
    return matched;
  };
  const hasPII = [emailRegex, phoneRegex, ssnRegex, creditCardRegex].some(hasMatch);
  const hasSecret = [openAIKeyRegex, awsKeyRegex, githubTokenRegex, genericSecretRegex].some(hasMatch);
  const hasInjection = injectionPatterns.some(hasMatch);

  let riskScore = 0;
  if (hasPII)       riskScore += 25;
  if (hasSecret)    riskScore += 40;
  if (hasInjection) riskScore += 35;

  let action;
  if (riskScore >= 60) {
    action = 'BLOCK';
  } else if (riskScore > 0) {
    action = 'WARN';
  } else {
    action = 'ALLOW';
  }

  return { riskScore, action, hasPII, hasSecret, hasInjection };
}

// ─── HUD Status Update ────────────────────────────────────────────────────────

function updateHudStatus(action, label) {
  if (!shadowRoot) return;
  const pill = shadowRoot.querySelector('#ca-status-pill');
  if (!pill) return;

  // Reset classes
  pill.className = 'pulse-dot';

  if (action === 'BLOCK') {
    pill.classList.add('pill-red');
    pill.innerHTML = `🚨 HIGH RISK — ${label}`;
  } else if (action === 'WARN') {
    pill.classList.add('pill-amber');
    pill.innerHTML = `⚠️ Risk Detected — ${label}`;
  } else {
    pill.classList.add('pill-green');
    pill.innerHTML = `🛡️ Protected — ${label}`;
  }
}

// ─── Toast Notifications ──────────────────────────────────────────────────────

function showToast(message, type = 'success') {
  if (!shadowRoot) return;

  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✅' : '⚠️';
  t.innerHTML = `<span>${icon}</span> ${message}`;
  shadowRoot.appendChild(t);

  // Fade out then remove
  setTimeout(() => {
    t.style.transition = 'opacity 0.3s ease';
    t.style.opacity = '0';
    setTimeout(() => {
      if (t.parentNode) t.remove();
    }, 300);
  }, 2700);

  // Fallback hard remove
  setTimeout(() => {
    if (t.parentNode) t.remove();
  }, 3000);
}

// ─── HUD HTML Template ────────────────────────────────────────────────────────

function createHudHTML() {
  return `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  #ca-hud {
    position: fixed;
    bottom: 80px;
    right: 20px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-family: 'Inter', system-ui, sans-serif;
  }
  #ca-status-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(17,24,39,0.95);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 999px;
    padding: 8px 16px;
    font-size: 13px;
    color: #F9FAFB;
    cursor: pointer;
    backdrop-filter: blur(12px);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    transition: all 0.2s ease;
    min-width: 180px;
    justify-content: center;
    user-select: none;
  }
  #ca-status-pill:hover {
    background: rgba(30,40,60,0.98);
    border-color: rgba(255,255,255,0.22);
  }
  #ca-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: rgba(17,24,39,0.95);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    padding: 10px;
    backdrop-filter: blur(12px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  }
  .ca-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    color: #F9FAFB;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
    font-family: 'Inter', system-ui, sans-serif;
  }
  .ca-btn:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.2); }
  .ca-btn.loading { opacity: 0.6; pointer-events: none; }
  .ca-btn-primary { border-color: rgba(99,102,241,0.4); color: #a5b4fc; }
  .ca-btn-primary:hover { background: rgba(99,102,241,0.2); border-color: rgba(99,102,241,0.6); }
  #ca-toggle-btn {
    position: fixed; bottom: 80px; right: 20px; z-index: 2147483647;
    width: 44px; height: 44px; border-radius: 50%;
    background: #6366F1; border: none; cursor: pointer;
    font-size: 20px; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 16px rgba(99,102,241,0.5);
    transition: all 0.2s ease;
  }
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: rgba(26,34,52,0.98); border: 1px solid rgba(255,255,255,0.12);
    border-radius: 10px; padding: 12px 20px;
    color: #F9FAFB; font-size: 13px; z-index: 2147483647;
    display: flex; align-items: center; gap: 8px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    animation: fadeInUp 0.3s ease; font-family: 'Inter', system-ui, sans-serif;
  }
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateX(-50%) translateY(8px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
  .pulse-dot::before {
    content: '';
    width: 8px; height: 8px; border-radius: 50%;
    animation: pulseDot 1.5s infinite;
    display: inline-block;
    margin-right: 2px;
  }
  .pill-green { color: #10B981; } .pill-green::before { background: #10B981; }
  .pill-amber { color: #F59E0B; } .pill-amber::before { background: #F59E0B; }
  .pill-red   { color: #EF4444; } .pill-red::before   { background: #EF4444; }
  @keyframes pulseDot { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  #ca-modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.8);
    backdrop-filter: blur(4px); z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
  }
  #ca-modal {
    background: #111827; border: 1px solid rgba(255,255,255,0.12);
    border-radius: 16px; padding: 24px; max-width: 560px; width: 90%;
    max-height: 80vh; overflow-y: auto;
    font-family: 'Inter', system-ui, sans-serif; color: #F9FAFB;
  }
  #ca-modal h3 { margin: 0 0 12px; font-size: 1.1rem; }
  #ca-modal-stats { font-size: 12px; color: #9CA3AF; margin-bottom: 8px; }
  #ca-bridge-content {
    background: #0d1117; border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px; padding: 16px; font-family: monospace;
    font-size: 12px; white-space: pre-wrap; color: #e6edf3;
    max-height: 300px; overflow-y: auto; margin: 12px 0;
  }
  .modal-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
  .modal-btn {
    padding: 8px 16px; border-radius: 8px; cursor: pointer;
    font-size: 13px; border: 1px solid rgba(255,255,255,0.12);
    font-family: 'Inter', system-ui, sans-serif; transition: all 0.2s ease;
  }
  .modal-btn-primary { background: #6366F1; color: #fff; border-color: #6366F1; }
  .modal-btn-primary:hover { background: #4F46E5; }
  .modal-btn-secondary { background: transparent; color: #a5b4fc; border-color: rgba(99,102,241,0.4); }
  .modal-btn-secondary:hover { background: rgba(99,102,241,0.15); }
  .modal-btn-close { background: transparent; color: #9CA3AF; }
  .modal-btn-close:hover { color: #F9FAFB; background: rgba(255,255,255,0.05); }
</style>
<div id="ca-hud" style="display:none;">
  <div id="ca-status-pill" class="pulse-dot pill-green">🛡️ ContextArmor Active</div>
  <div id="ca-actions" style="display:none;">
    <button class="ca-btn" id="ca-redact-btn">🛡️ Auto-Redact PII</button>
    <button class="ca-btn ca-btn-primary" id="ca-optimize-btn">✨ Optimize &amp; Compress</button>
    <button class="ca-btn" id="ca-transfer-btn">📦 Transfer Chat</button>
  </div>
</div>
`;
}

// ─── Transfer Modal ───────────────────────────────────────────────────────────

function showTransferModal(bridgePrompt, stats) {
  if (!shadowRoot) return;

  // Remove any existing modal
  const existing = shadowRoot.querySelector('#ca-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'ca-modal-overlay';

  const originalTokens = stats && Number.isFinite(stats.original_tokens) ? stats.original_tokens : null;
  const bridgeTokens = stats && Number.isFinite(stats.bridge_tokens) ? stats.bridge_tokens : null;
  const compressionRatio = stats && typeof stats.compression_ratio === 'number'
    ? stats.compression_ratio.toFixed(2)
    : '?';
  const tokenSummary = originalTokens != null && bridgeTokens != null
    ? `${originalTokens} → ${bridgeTokens} tokens (${compressionRatio}x size ratio)`
    : 'Bridge ready to copy';

  overlay.innerHTML = `
    <div id="ca-modal">
      <h3>📦 Continuation Bridge Generated</h3>
      <div id="ca-modal-stats">${escapeHtml(tokenSummary)}</div>
      <div id="ca-bridge-content">${escapeHtml(bridgePrompt)}</div>
      <div class="modal-btns">
        <button class="modal-btn modal-btn-secondary" id="ca-copy-btn">📋 Copy Bridge Prompt</button>
        <button class="modal-btn modal-btn-primary" id="ca-open-btn">🚀 Open Fresh Chat</button>
        <button class="modal-btn modal-btn-close" id="ca-close-modal-btn">✕ Close</button>
      </div>
    </div>
  `;

  shadowRoot.appendChild(overlay);

  // Copy button
  const copyBtn = overlay.querySelector('#ca-copy-btn');
  copyBtn.addEventListener('click', async () => {
    try {
      await copyTextToClipboard(bridgePrompt);
      copyBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyBtn.textContent = '📋 Copy Bridge Prompt'; }, 2000);
    } catch (_) {
      // Fallback clipboard write
      const ta = document.createElement('textarea');
      ta.value = bridgePrompt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      copyBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyBtn.textContent = '📋 Copy Bridge Prompt'; }, 2000);
    }
  });

  // Open fresh chat button
  const openBtn = overlay.querySelector('#ca-open-btn');
  openBtn.addEventListener('click', async () => {
    try {
      let copied = true;
      try {
        await copyTextToClipboard(bridgePrompt);
      } catch (_) {
        copied = false;
      }
      const opened = await sendToBackground({ action: 'open_fresh_chat', platform: detectPlatform() });
      if (opened && opened.opened) {
        showToast(copied
          ? 'New chat opened; bridge copied. Paste it to continue.'
          : 'New chat opened. Copy the bridge here, then paste it to continue.', copied ? 'success' : 'warning');
        if (copied) overlay.remove();
      } else {
        showToast(copied
          ? 'Bridge copied. Open a new chat and paste it to continue.'
          : 'Chat did not open and bridge could not be copied. Use Copy Bridge Prompt.', 'warning');
      }
    } catch (err) {
      showToast(`Could not open a new chat: ${err.message}`, 'warning');
    }
  });

  // Close button
  const closeBtn = overlay.querySelector('#ca-close-modal-btn');
  closeBtn.addEventListener('click', () => overlay.remove());

  // Click outside to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const copied = document.execCommand('copy');
    ta.remove();
    if (!copied) throw new Error('Clipboard access was denied');
  }
}

/** Escape HTML for safe innerHTML insertion */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── HUD Injection ────────────────────────────────────────────────────────────

function injectHud() {
  if (hudInjected) return;
  hudInjected = true;

  hudHost = document.createElement('div');
  hudHost.id = 'ca-hud-host';
  // Inline reset to avoid host-page styles leaking in
  hudHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
  document.body.appendChild(hudHost);

  shadowRoot = hudHost.attachShadow({ mode: 'open' });
  shadowRoot.innerHTML = createHudHTML();

  const hud = shadowRoot.querySelector('#ca-hud');
  const pill = shadowRoot.querySelector('#ca-status-pill');
  const actionsPanel = shadowRoot.querySelector('#ca-actions');

  // ── Toggle panel on pill click ──
  pill.addEventListener('click', () => {
    const isVisible = actionsPanel.style.display !== 'none';
    actionsPanel.style.display = isVisible ? 'none' : 'flex';
  });

  // ── Auto-Redact PII button ─────────────────────────────────────────────────
  const redactBtn = shadowRoot.querySelector('#ca-redact-btn');
  redactBtn.addEventListener('click', async () => {
    const input = currentInput;
    if (!input || !input.isConnected) {
      showToast('No prompt input detected', 'warning');
      return;
    }
    const text = getPromptText(input);
    if (!text.trim()) {
      showToast('Prompt is empty', 'warning');
      return;
    }

    redactBtn.classList.add('loading');
    redactBtn.textContent = '⏳ Redacting…';

    try {
      const result = await sendToBackground({ action: 'scan', text });
      if (result && result.sanitized_text !== undefined) {
        if (input.isConnected) setPromptInputValue(input, result.sanitized_text);
        const count = result.redaction_count != null
          ? result.redaction_count
          : countRedactions(text, result.sanitized_text);
        showToast(`Redacted ${count} item${count !== 1 ? 's' : ''}`, 'success');
        updateHudStatus('ALLOW', 'Redacted');
      } else if (result && result.error) {
        showToast(`Redaction failed: ${result.error}`, 'warning');
      } else {
        showToast('Redaction returned no result', 'warning');
      }
    } catch (err) {
      showToast('Redaction failed — backend offline?', 'warning');
    } finally {
      redactBtn.classList.remove('loading');
      redactBtn.textContent = '🛡️ Auto-Redact PII';
    }
  });

  // ── Optimize & Compress button ─────────────────────────────────────────────
  const optimizeBtn = shadowRoot.querySelector('#ca-optimize-btn');
  optimizeBtn.addEventListener('click', async () => {
    const input = currentInput;
    if (!input || !input.isConnected) {
      showToast('No prompt input detected', 'warning');
      return;
    }
    const text = getPromptText(input);
    if (!text.trim()) {
      showToast('Prompt is empty', 'warning');
      return;
    }

    optimizeBtn.classList.add('loading');
    optimizeBtn.textContent = '⏳ Optimizing…';

    try {
      const result = await sendToBackground({ action: 'optimize', text, mode: 'lossless' });
      if (result && result.optimized_prompt !== undefined) {
        if (input.isConnected) {
          setPromptInputValue(input, result.optimized_prompt);
        }
        const saved = result.tokens_saved != null ? result.tokens_saved : 0;
        const pct = result.reduction_percentage != null
          ? Number(result.reduction_percentage).toFixed(1)
          : '0.0';
        if (saved > 0) {
          showToast(`Optimized: saved ${saved} tokens (${pct}%)`, 'success');
          updateHudStatus('ALLOW', `${pct}% smaller`);
        } else {
          showToast('Prompt checked; no token savings were found.', 'success');
          updateHudStatus('ALLOW', 'Prompt checked');
        }
      } else if (result && result.error) {
        showToast(`Optimization failed: ${result.error}`, 'warning');
      } else {
        showToast('Optimization returned no result', 'warning');
      }
    } catch (err) {
      showToast('Optimization failed — backend offline?', 'warning');
    } finally {
      optimizeBtn.classList.remove('loading');
      optimizeBtn.textContent = '✨ Optimize & Compress';
    }
  });

  // ── Transfer Chat button ───────────────────────────────────────────────────
  const transferBtn = shadowRoot.querySelector('#ca-transfer-btn');
  transferBtn.addEventListener('click', async () => {
    transferBtn.classList.add('loading');
    transferBtn.textContent = '⏳ Packaging…';

    try {
      const messages = scrapeConversationMessages();
      if (messages.length === 0) {
        showToast('No conversation found to transfer', 'warning');
        return;
      }

      const result = await sendToBackground({ action: 'transfer', messages });
      if (result && result.bridge_prompt) {
        showTransferModal(result.bridge_prompt, {
          original_tokens: result.original_tokens,
          bridge_tokens: result.bridge_tokens,
          compression_ratio: result.compression_ratio
        });
      } else if (result && result.error) {
        showToast(`Transfer failed: ${result.error}`, 'warning');
      } else {
        showToast('Transfer returned no bridge prompt', 'warning');
      }
    } catch (err) {
      showToast('Transfer failed — backend offline?', 'warning');
    } finally {
      transferBtn.classList.remove('loading');
      transferBtn.textContent = '📦 Transfer Chat';
    }
  });
}

/** Sends a message to the background service worker and returns the response */
function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          if (!response) {
            reject(new Error('The extension background worker returned no response. Reload the extension and page.'));
          } else if (response.success === false || response.error) {
            reject(new Error(response.error || 'The extension request failed.'));
          } else {
            resolve(response.result !== undefined ? response.result : response);
          }
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

/** Counts approximate redactions by comparing [REDACTED] occurrences */
function countRedactions(original, sanitized) {
  const originalMatches = (original.match(/\[REDACTED[^\]]*\]/g) || []).length;
  const sanitizedMatches = (sanitized.match(/\[REDACTED[^\]]*\]/g) || []).length;
  return Math.max(0, sanitizedMatches - originalMatches);
}

// ─── HUD Visibility ───────────────────────────────────────────────────────────

function showHud() {
  if (!shadowRoot) return;
  const hud = shadowRoot.querySelector('#ca-hud');
  if (hud) hud.style.display = 'flex';
}

function hideHud() {
  if (!shadowRoot) return;
  const hud = shadowRoot.querySelector('#ca-hud');
  if (hud) hud.style.display = 'none';
}

// ─── Input Handling (Debounced Live Scan) ────────────────────────────────────

function handleInput(event) {
  clearTimeout(scanDebounceTimer);
  const requestId = ++liveScanSequence;
  scanDebounceTimer = setTimeout(async () => {
    const text = getPromptText(currentInput);

    if (!text || text.trim().length < 20) {
      updateHudStatus('ALLOW', 'Protected');
      return;
    }

    // Immediate client-side feedback
    const clientResult = clientSideScan(text);
    let labelParts = [];
    if (clientResult.hasPII)       labelParts.push('PII');
    if (clientResult.hasSecret)    labelParts.push('Secret');
    if (clientResult.hasInjection) labelParts.push('Injection');
    const clientLabel = labelParts.length > 0 ? labelParts.join(', ') : 'Clean';
    updateHudStatus(clientResult.action, clientLabel);

    // Background API scan if backend is available
    if (isBackendOnline) {
      try {
        const result = await sendToBackground({ action: 'scan', text });
        if (requestId !== liveScanSequence) return;
        if (result && result.risk_action) {
          const apiLabel = result.risk_label || result.risk_action;
          updateHudStatus(result.risk_action, apiLabel);
        } else if (result && result.risk_score !== undefined) {
          // Derive action from score
          let action = 'ALLOW';
          if (result.risk_score >= 60) action = 'BLOCK';
          else if (result.risk_score >= 20) action = 'WARN';
          updateHudStatus(action, `Score: ${result.risk_score}`);
        }
      } catch (_) {
        // Backend scan failed — client-side result already shown, keep it
      }
    }
  }, 300);
}

// ─── MutationObserver Setup ───────────────────────────────────────────────────

function initObserver() {
  // Try immediately in case the input is already present
  const initialInput = findPromptInput();
  if (initialInput) {
    attachToInput(initialInput);
  }

  const observer = new MutationObserver(() => {
    const input = findPromptInput();
    if (input && input !== currentInput) {
      attachToInput(input);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function attachToInput(input) {
  // Remove listener from old input if any
  if (currentInput && currentInput !== input) {
    currentInput.removeEventListener('input', handleInput);
    currentInput.removeEventListener('keyup', handleInput);
  }

  currentInput = input;
  currentInput.addEventListener('input', handleInput);
  // keyup as fallback for contenteditable elements that may not fire 'input'
  currentInput.addEventListener('keyup', handleInput);

  if (!hudInjected) {
    injectHud();
  }

  showHud();
}

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
  // Only run on supported platforms
  const platform = detectPlatform();
  if (platform === 'unknown') return;

  // Initial backend check
  await checkBackendStatus();

  // Set up the observer
  initObserver();

  // Re-check backend status every 30 seconds
  setInterval(async () => {
    const wasOnline = isBackendOnline;
    await checkBackendStatus();
    if (wasOnline !== isBackendOnline && shadowRoot) {
      if (isBackendOnline) {
        showToast('ContextArmor backend connected', 'success');
      } else {
        showToast('Backend offline — local scan only', 'warning');
      }
    }
  }, 30000);

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (hudHost && hudHost.parentNode) {
      hudHost.remove();
    }
  });
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

init();
