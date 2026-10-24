// ContextArmor AI - Content Script
// Injects floating guardrails HUD into ChatGPT, Claude, and Gemini
'use strict';

let hudInjected = false;
let currentInput = null;
let scanDebounceTimer = null;
let hudHost = null;
let shadowRoot = null;
let isBackendOnline = false;
let liveScanSequence = 0;
let isBypassingSubmit = false;
let isEditorBlurred = false;

let policySettings = {
  warn_threshold: 30,
  block_threshold: 70,
  enabled_rules: ['PII', 'SECRET', 'PROMPT_INJECTION'],
  restricted_websites: [],
  auto_redact_on_send: false,
  fail_closed: false
};

// ─── Platform Detection ───────────────────────────────────────────────────────

function detectPlatform() {
  const host = window.location.hostname;
  if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return 'chatgpt';
  if (host.includes('claude.ai')) return 'claude';
  if (host.includes('gemini.google.com')) return 'gemini';
  return 'unknown';
}

// ─── Prompt Input & Send Button Selectors ─────────────────────────────────────

const SELECTORS = {
  chatgpt: [
    '#prompt-textarea',
    'div#prompt-textarea',
    'div.ProseMirror',
    'div[contenteditable="true"]',
    'textarea[data-id="root"]',
    'textarea[tabindex="0"]',
    'textarea',
    '[contenteditable="true"][data-placeholder*="Message"]',
    '[contenteditable="true"][data-placeholder*="Ask"]',
    'form [contenteditable="true"]',
    'form textarea'
  ],
  claude: [
    'div[contenteditable="true"].ProseMirror',
    'fieldset div[contenteditable="true"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]'
  ],
  gemini: [
    'rich-textarea div[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea textarea',
    'div[contenteditable="true"]'
  ]
};

const SEND_SELECTORS = {
  chatgpt: [
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[data-testid*="send"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Prompt" i]',
    'button[aria-label*="message" i]',
    'form button[type="submit"]',
    'form button:last-child',
    'form button'
  ],
  claude: [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'fieldset button:last-of-type',
    'button:has(svg[data-icon="arrow-up"])'
  ],
  gemini: [
    'button.send-button',
    'button[aria-label*="Send"]',
    'button[aria-label*="Submit"]',
    '.send-button-container button'
  ]
};

function findPromptInput() {
  const platform = detectPlatform();
  // If the user is currently focused inside an editable element, prioritize it
  const active = document.activeElement;
  if (active && (active.isContentEditable || active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && active.type === 'text'))) {
    return active.isContentEditable ? (active.closest('#prompt-textarea') || active) : active;
  }

  const selectors = SELECTORS[platform] || ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea'];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && !el.disabled && !el.readOnly) return el;
    } catch (_) {}
  }

  // Universal fallback: look for any prompt textarea or contenteditable inside a form or document
  const fallback = document.querySelector('#prompt-textarea, div.ProseMirror, form [contenteditable="true"], form textarea, textarea, [contenteditable="true"]');
  if (fallback) return fallback;

  return null;
}

// ─── Text Extraction ──────────────────────────────────────────────────────────

function getPromptText(element) {
  if (!element) return '';
  const editor = element.closest ? (element.closest('#prompt-textarea') || element.closest('[contenteditable="true"]') || element) : element;
  if (editor.tagName === 'TEXTAREA') {
    return editor.value || '';
  }
  // contenteditable div / ProseMirror
  return editor.innerText || editor.textContent || '';
}

// ─── Text Setting ─────────────────────────────────────────────────────────────

function setPromptInputValue(element, newText) {
  if (!element) return;
  const editor = element.closest ? (element.closest('#prompt-textarea') || element.closest('[contenteditable="true"]') || element) : element;

  if (editor.tagName === 'TEXTAREA') {
    // Native input value setter to trigger React synthetic events
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    );
    if (nativeInputValueSetter && nativeInputValueSetter.set) {
      nativeInputValueSetter.set.call(editor, newText);
    } else {
      editor.value = newText;
    }
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: newText
    }));
  } else {
    // contenteditable — try execCommand first for ProseMirror compatibility
    editor.focus();
    try {
      document.execCommand('selectAll', false, null);
      const inserted = document.execCommand('insertText', false, newText);
      if (!inserted) throw new Error('execCommand failed');
    } catch (_) {
      // Fallback: direct innerText assignment
      editor.innerText = newText;
      editor.dispatchEvent(new InputEvent('input', {
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
  try {
    const response = await sendToBackground({ action: 'check_backend' });
    isBackendOnline = Boolean(response && (response.online || response.success));
  } catch (_) {
    isBackendOnline = false;
  }
  return isBackendOnline;
}

// ─── Client-Side Scan ─────────────────────────────────────────────────────────

// ─── Client-Side Scan & Redact ────────────────────────────────────────────────

function clientSideScan(text) {
  if (!text || typeof text !== 'string') {
    return { riskScore: 0, action: 'ALLOW', findings: [], hasPII: false, hasSecret: false, hasInjection: false };
  }

  const findings = [];

  // PII patterns
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const ssnRegex = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
  const ipv4Regex = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
  const aadhaarRegex = /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g;
  const panRegex = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;
  const creditCardRegex = /\b(?:\d{4}[\s\-]?){3}\d{4}\b/g;

  // Secret patterns
  const openAIKeyRegex = /\bsk-[a-zA-Z0-9]{20,}\b/g;
  const awsKeyRegex = /\bAKIA[A-Z0-9]{16}\b/g;
  const githubTokenRegex = /\bghp_[a-zA-Z0-9]{36}\b/g;
  const bearerTokenRegex = /\bBearer\s+[a-zA-Z0-9_\-\.]{25,}\b/g;
  const dbUrlRegex = /\b(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+:[^\s"']+@[^\s"']+\b/g;
  const genericSecretRegex = /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*['"]?[a-zA-Z0-9+/\-_]{8,}/gi;
  const passwordRegex = /\b(?:password|passwd|pwd|secret)\s*[:=]\s*['"]?([^\s'"]{6,})['"]?/gi;

  let m;
  while ((m = emailRegex.exec(text)) !== null) findings.push({ type: 'EMAIL', match: m[0], severity: 'MEDIUM' });
  while ((m = phoneRegex.exec(text)) !== null) findings.push({ type: 'PHONE', match: m[0], severity: 'MEDIUM' });
  while ((m = ipv4Regex.exec(text)) !== null) {
    if (m[0] !== '127.0.0.1' && m[0] !== '0.0.0.0' && m[0] !== '255.255.255.255') {
      findings.push({ type: 'IPV4_ADDRESS', match: m[0], severity: 'LOW' });
    }
  }
  while ((m = aadhaarRegex.exec(text)) !== null) findings.push({ type: 'AADHAAR_ID', match: m[0], severity: 'HIGH' });
  while ((m = panRegex.exec(text)) !== null) findings.push({ type: 'PAN_CARD', match: m[0], severity: 'HIGH' });
  while ((m = ssnRegex.exec(text)) !== null) findings.push({ type: 'SSN', match: m[0], severity: 'HIGH' });
  while ((m = creditCardRegex.exec(text)) !== null) findings.push({ type: 'CREDIT_CARD', match: m[0], severity: 'HIGH' });

  while ((m = openAIKeyRegex.exec(text)) !== null) findings.push({ type: 'OPENAI_API_KEY', match: m[0], severity: 'CRITICAL' });
  while ((m = awsKeyRegex.exec(text)) !== null) findings.push({ type: 'AWS_ACCESS_KEY', match: m[0], severity: 'CRITICAL' });
  while ((m = githubTokenRegex.exec(text)) !== null) findings.push({ type: 'GITHUB_TOKEN', match: m[0], severity: 'CRITICAL' });
  while ((m = bearerTokenRegex.exec(text)) !== null) findings.push({ type: 'BEARER_TOKEN', match: m[0], severity: 'CRITICAL' });
  while ((m = dbUrlRegex.exec(text)) !== null) findings.push({ type: 'DATABASE_URL', match: m[0], severity: 'CRITICAL' });
  while ((m = genericSecretRegex.exec(text)) !== null) findings.push({ type: 'GENERIC_SECRET', match: m[0], severity: 'HIGH' });
  while ((m = passwordRegex.exec(text)) !== null) {
    const val = (m[1] || '').toLowerCase();
    if (!['password', '123456', 'your_password', 'yourpassword', 'string', 'example', 'secret'].includes(val)) {
      findings.push({ type: 'PLAINTEXT_PASSWORD', match: m[0], severity: 'CRITICAL' });
    }
  }

  // Prompt injection
  const isBenignContext = /(?:example|sample|test|explain|demonstrate|detection|research|paper|prevent|mitigate|defense)\s+(?:of|for|against)?\s*(?:prompt\s+injection|jailbreak|jailbreaking)/i.test(text);

  if (!isBenignContext) {
    const injectionPatterns = [
      { pattern: /ignore\s+all\s+previous\s+(instructions?|prompts?|rules?)/gi, type: 'PROMPT_INJECTION' },
      { pattern: /disregard\s+(all\s+)?(previous\s+)?(instructions?|context)/gi, type: 'PROMPT_INJECTION' },
      { pattern: /you\s+are\s+now\s+(a\s+)?(different|new|DAN|unrestricted)\s+(ai|assistant|bot|model|persona)/gi, type: 'PROMPT_INJECTION' },
      { pattern: /forget\s+(everything|all|your)\s+(you|previous|prior)/gi, type: 'PROMPT_INJECTION' },
      { pattern: /act\s+as\s+if\s+you\s+(have\s+no|don't\s+have)\s+(restrictions?|rules?|guidelines?)/gi, type: 'PROMPT_INJECTION' },
      { pattern: /\bDAN\b|do\s+anything\s+now/gi, type: 'JAILBREAK_ATTEMPT' },
      { pattern: /system\s*prompt\s*override/gi, type: 'PROMPT_INJECTION' },
      { pattern: /override\s+(your\s+)?(safety|content)\s+(filter|policy|restriction)/gi, type: 'PROMPT_INJECTION' },
      { pattern: /output\s+(your\s+)?(initial|original|system)\s+(prompt|instructions)/gi, type: 'SYSTEM_PROMPT_LEAK' }
    ];

    for (const item of injectionPatterns) {
      if (item.pattern.test(text)) {
        findings.push({ type: item.type, match: 'Injection sequence detected', severity: 'HIGH' });
        break;
      }
    }
  }

  const hasPII = findings.some(f => ['EMAIL', 'PHONE', 'IPV4_ADDRESS', 'AADHAAR_ID', 'PAN_CARD', 'SSN', 'CREDIT_CARD'].includes(f.type));
  const hasSecret = findings.some(f => ['OPENAI_API_KEY', 'AWS_ACCESS_KEY', 'GITHUB_TOKEN', 'BEARER_TOKEN', 'DATABASE_URL', 'GENERIC_SECRET', 'PLAINTEXT_PASSWORD'].includes(f.type));
  const hasInjection = findings.some(f => ['PROMPT_INJECTION', 'JAILBREAK_ATTEMPT', 'SYSTEM_PROMPT_LEAK'].includes(f.type));

  let riskScore = 0;
  if (hasInjection) riskScore += 75;
  if (hasSecret) riskScore += 75;
  if (findings.some(f => ['AADHAAR_ID', 'PAN_CARD', 'SSN', 'CREDIT_CARD'].includes(f.type))) riskScore += 50;
  if (findings.some(f => ['EMAIL', 'PHONE', 'IPV4_ADDRESS'].includes(f.type))) riskScore += 30;
  riskScore = Math.min(100, riskScore);

  const warnTh = policySettings.warn_threshold || 30;
  const blockTh = policySettings.block_threshold || 70;

  let action = 'ALLOW';
  if (riskScore >= blockTh) {
    action = 'BLOCK';
  } else if (riskScore >= warnTh) {
    action = 'WARN';
  }

  return { riskScore, action, findings, hasPII, hasSecret, hasInjection };
}

function clientSideRedact(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[REDACTED_PHONE]')
    .replace(/\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g, '[REDACTED_AADHAAR]')
    .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, '[REDACTED_PAN]')
    .replace(/\b(?:\d{4}[\s\-]?){3}\d{4}\b/g, '[REDACTED_CREDIT_CARD]')
    .replace(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, (m) => {
      return (m === '127.0.0.1' || m === '0.0.0.0') ? m : '[REDACTED_IPV4]';
    })
    .replace(/\bsk-[a-zA-Z0-9]{20,}\b/g, '[REDACTED_OPENAI_KEY]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bghp_[a-zA-Z0-9]{36}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bBearer\s+[a-zA-Z0-9_\-\.]{25,}\b/g, '[REDACTED_BEARER_TOKEN]')
    .replace(/\b(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+:[^\s"']+@[^\s"']+\b/g, '[REDACTED_DATABASE_URL]')
    .replace(/\b((?:password|passwd|pwd|secret)\s*[:=]\s*['"]?)[^\s'"]{6,}(['"]?)/gi, '$1[REDACTED_PASSWORD]$2');
}

// ─── Security Warning and Block Modals ────────────────────────────────────────

function showWarningModal(scanResult, text, inputEl) {
  if (!shadowRoot) return;
  const existing = shadowRoot.querySelector('#ca-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'ca-modal-overlay';

  const badges = (scanResult.findings || []).map(f => {
    const cls = f.severity === 'CRITICAL' ? 'badge-critical' : f.severity === 'HIGH' ? 'badge-high' : 'badge-medium';
    return `<span class="modal-badge ${cls}">${escapeHtml(f.type)}</span>`;
  }).join(' ');

  overlay.innerHTML = `
    <div id="ca-modal">
      <h3 style="color:#fcd34d;">⚠️ Security Warning: Sensitive Data Detected</h3>
      <div id="ca-modal-stats">Risk Score: <strong>${scanResult.riskScore}/100</strong> (Threshold: ${policySettings.warn_threshold || 30})</div>
      <div style="margin: 8px 0 12px 0;">${badges || '<span class="modal-badge badge-high">SENSITIVE_CONTENT</span>'}</div>
      <p style="font-size:13px;line-height:1.5;color:rgba(255,255,255,0.85);margin-bottom:12px;">
        Your prompt contains potential credentials or personal identifiers that could be transmitted to the AI provider.
      </p>
      <div class="modal-btns">
        <button class="modal-btn modal-btn-primary" id="ca-btn-redact-submit">🛡️ Redact &amp; Send</button>
        <button class="modal-btn modal-btn-warning" id="ca-btn-proceed-anyway">⚠️ Proceed Anyway</button>
        <button class="modal-btn modal-btn-close" id="ca-btn-cancel-modal">✕ Cancel</button>
      </div>
    </div>
  `;

  shadowRoot.appendChild(overlay);

  overlay.querySelector('#ca-btn-redact-submit').addEventListener('click', () => {
    overlay.remove();
    const sanitized = clientSideRedact(text);
    setPromptInputValue(inputEl, sanitized);
    showToast('Prompt redacted & submitted safely', 'success');
    triggerActualSubmit(inputEl);
  });

  overlay.querySelector('#ca-btn-proceed-anyway').addEventListener('click', () => {
    overlay.remove();
    showToast('Proceeding without redaction', 'warning');
    triggerActualSubmit(inputEl);
  });

  overlay.querySelector('#ca-btn-cancel-modal').addEventListener('click', () => {
    overlay.remove();
    if (inputEl && inputEl.focus) inputEl.focus();
  });
}

function showBlockedModal(scanResult, text, inputEl) {
  if (!shadowRoot) return;
  const existing = shadowRoot.querySelector('#ca-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'ca-modal-overlay';

  const badges = (scanResult.findings || []).map(f => {
    const cls = f.severity === 'CRITICAL' ? 'badge-critical' : 'badge-high';
    return `<span class="modal-badge ${cls}">${escapeHtml(f.type)}</span>`;
  }).join(' ');

  overlay.innerHTML = `
    <div id="ca-modal">
      <h3 style="color:#f87171;">🚨 Submission Blocked by Policy</h3>
      <div id="ca-modal-stats">Critical Risk Score: <strong>${scanResult.riskScore}/100</strong> (Block Threshold: ${policySettings.block_threshold || 70})</div>
      <div style="margin: 8px 0 12px 0;">${badges || '<span class="modal-badge badge-critical">HIGH_RISK_THREAT</span>'}</div>
      <p style="font-size:13px;line-height:1.5;color:rgba(255,255,255,0.85);margin-bottom:12px;">
        Submission was prevented because high-risk secrets or prompt injection patterns were detected.
      </p>
      <div class="modal-btns">
        <button class="modal-btn modal-btn-primary" id="ca-btn-redact-review">🛡️ Redact &amp; Review</button>
        <button class="modal-btn modal-btn-close" id="ca-btn-dismiss-block">✕ Dismiss</button>
      </div>
    </div>
  `;

  shadowRoot.appendChild(overlay);

  overlay.querySelector('#ca-btn-redact-review').addEventListener('click', () => {
    overlay.remove();
    const sanitized = clientSideRedact(text);
    setPromptInputValue(inputEl, sanitized);
    showToast('Sensitive patterns replaced with placeholders in editor', 'success');
    if (inputEl && inputEl.focus) inputEl.focus();
  });

  overlay.querySelector('#ca-btn-dismiss-block').addEventListener('click', () => {
    overlay.remove();
    if (inputEl && inputEl.focus) inputEl.focus();
  });
}

function showRestrictedWebsiteModal(domain) {
  if (!shadowRoot) return;
  const existing = shadowRoot.querySelector('#ca-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'ca-modal-overlay';

  overlay.innerHTML = `
    <div id="ca-modal">
      <h3 style="color:#f87171;">🚫 Domain Restricted by Security Policy</h3>
      <p style="font-size:13px;line-height:1.5;color:rgba(255,255,255,0.85);margin:12px 0;">
        Submitting AI prompts to <strong>${escapeHtml(domain)}</strong> is restricted by your active ContextArmor policy.
      </p>
      <div class="modal-btns">
        <button class="modal-btn modal-btn-close" id="ca-btn-close-restricted">✕ Dismiss</button>
      </div>
    </div>
  `;

  shadowRoot.appendChild(overlay);
  overlay.querySelector('#ca-btn-close-restricted').addEventListener('click', () => overlay.remove());
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
    right: 24px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
  }
  #ca-status-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(22, 33, 76, 0.88);
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 999px;
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 600;
    color: #F9FAFB;
    cursor: pointer;
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    box-shadow: 0 10px 28px rgba(10, 18, 48, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.25);
    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    min-width: 180px;
    justify-content: center;
    user-select: none;
  }
  #ca-status-pill:hover {
    background: rgba(30, 48, 110, 0.95);
    border-color: rgba(255, 255, 255, 0.35);
    transform: translateY(-2px);
    box-shadow: 0 14px 34px rgba(10, 18, 48, 0.5), 0 0 20px rgba(99, 140, 255, 0.35);
  }
  #ca-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: rgba(18, 27, 65, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 16px;
    padding: 10px;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 16px 36px rgba(10, 18, 48, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.25);
  }
  .ca-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
    color: #F9FAFB;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
    font-family: inherit;
  }
  .ca-btn:hover { background: rgba(255, 255, 255, 0.16); border-color: rgba(255, 255, 255, 0.25); transform: translateY(-1px); }
  .ca-btn.loading { opacity: 0.6; pointer-events: none; }
  .ca-btn-primary { background: linear-gradient(135deg, rgba(59, 130, 246, 0.4), rgba(99, 102, 241, 0.4)); border-color: rgba(147, 197, 253, 0.35); color: #ffffff; }
  .ca-btn-primary:hover { background: linear-gradient(135deg, rgba(59, 130, 246, 0.6), rgba(99, 102, 241, 0.6)); border-color: rgba(147, 197, 253, 0.5); box-shadow: 0 0 16px rgba(99, 140, 255, 0.35); }
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
    background: rgba(22, 33, 76, 0.96); border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 12px; padding: 12px 20px;
    color: #F9FAFB; font-size: 13px; font-weight: 500; z-index: 2147483647;
    display: flex; align-items: center; gap: 8px;
    backdrop-filter: blur(16px);
    box-shadow: 0 12px 36px rgba(10, 18, 48, 0.6);
    animation: fadeInUp 0.3s cubic-bezier(0.16, 1, 0.3, 1); font-family: 'Inter', system-ui, sans-serif;
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
  .pill-green { color: #34d399; } .pill-green::before { background: #10B981; box-shadow: 0 0 8px #10B981; }
  .pill-amber { color: #fbbf24; } .pill-amber::before { background: #F59E0B; box-shadow: 0 0 8px #F59E0B; }
  .pill-red   { color: #f87171; } .pill-red::before   { background: #EF4444; box-shadow: 0 0 8px #EF4444; }
  @keyframes pulseDot { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }
  #ca-modal-overlay {
    position: fixed; inset: 0; background: rgba(8, 14, 34, 0.75);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
  }
  #ca-modal {
    background: linear-gradient(165deg, #151e48 0%, #1d2d6f 50%, #2d459c 100%);
    border: 1px solid rgba(255,255,255,0.22);
    border-radius: 20px; padding: 24px; max-width: 560px; width: 90%;
    max-height: 80vh; overflow-y: auto;
    font-family: 'Inter', system-ui, sans-serif; color: #F9FAFB;
    box-shadow: 0 24px 60px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.3);
  }
  #ca-modal h3 { margin: 0 0 12px; font-size: 1.15rem; font-weight: 700; color: #ffffff; }
  #ca-modal-stats { font-size: 12px; color: rgba(225, 235, 255, 0.75); margin-bottom: 8px; }
  #ca-bridge-content {
    background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px; padding: 16px; font-family: 'JetBrains Mono', monospace;
    font-size: 12px; white-space: pre-wrap; color: #e0e7ff;
    max-height: 300px; overflow-y: auto; margin: 12px 0;
  }
  .modal-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
  .modal-btn {
    padding: 9px 16px; border-radius: 10px; cursor: pointer;
    font-size: 13px; font-weight: 600; border: 1px solid rgba(255,255,255,0.15);
    font-family: 'Inter', system-ui, sans-serif; transition: all 0.2s ease;
  }
  .modal-btn-primary { background: #11141a; color: #fff; border-color: rgba(255,255,255,0.25); }
  .modal-btn-primary:hover { background: #191e28; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
  .modal-btn-danger { background: #DC2626; color: #fff; border-color: rgba(255,255,255,0.25); }
  .modal-btn-danger:hover { background: #B91C1C; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(220,38,38,0.4); }
  .modal-btn-warning { background: #D97706; color: #fff; border-color: rgba(255,255,255,0.25); }
  .modal-btn-warning:hover { background: #B45309; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(217,119,6,0.4); }
  .modal-btn-secondary { background: rgba(255,255,255,0.12); color: #ffffff; border-color: rgba(255,255,255,0.2); }
  .modal-btn-secondary:hover { background: rgba(255,255,255,0.2); }
  .modal-btn-close { background: transparent; color: rgba(255,255,255,0.6); border: none; }
  .modal-btn-close:hover { color: #F9FAFB; }
  .modal-badge { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; margin-right: 6px; margin-bottom: 6px; }
  .badge-critical { background: rgba(239, 68, 68, 0.25); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.4); }
  .badge-high { background: rgba(245, 158, 11, 0.25); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.4); }
  .badge-medium { background: rgba(59, 130, 246, 0.25); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4); }
</style>
<div id="ca-hud" style="display:none;">
  <div id="ca-status-pill" class="pulse-dot pill-green">🛡️ ContextArmor Active</div>
  <div id="ca-actions" style="display:none;">
    <button class="ca-btn" id="ca-redact-btn">🛡️ Auto-Redact PII</button>
    <button class="ca-btn ca-btn-primary" id="ca-optimize-btn">✨ Optimize &amp; Compress</button>
    <button class="ca-btn" id="ca-transfer-btn">📦 Transfer Chat</button>
    <button class="ca-btn" id="ca-blur-btn">🙈 Blur/Unblur Editor</button>
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
      showToast(`Redaction failed: ${err.message}`, 'warning');
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
      showToast(`Optimization failed: ${err.message}`, 'warning');
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
      showToast(`Transfer failed: ${err.message}`, 'warning');
    } finally {
      transferBtn.classList.remove('loading');
      transferBtn.textContent = '📦 Transfer Chat';
    }
  });
  // ── Blur/Unblur Editor button ───────────────────────────────────────────
  const blurBtn = shadowRoot.querySelector('#ca-blur-btn');
  if (blurBtn) {
    blurBtn.addEventListener('click', () => {
      const input = currentInput || findPromptInput();
      if (!input) {
        showToast('No prompt editor found to blur', 'warning');
        return;
      }
      toggleEditorBlur(input);
    });
  }
}

function toggleEditorBlur(inputEl) {
  if (!inputEl) return;
  isEditorBlurred = !isEditorBlurred;
  if (isEditorBlurred) {
    inputEl.style.filter = 'blur(6px)';
    inputEl.style.transition = 'filter 0.2s ease';
    showToast('Prompt editor blurred for privacy', 'success');
  } else {
    inputEl.style.filter = 'none';
    showToast('Prompt editor unblurred', 'success');
  }
}

// ─── Pre-Submission Interception ──────────────────────────────────────────────

function handleGlobalKeydown(event) {
  if (isBypassingSubmit) return;
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;

  let input = currentInput || findPromptInput();
  if (!input && (event.target.isContentEditable || event.target.tagName === 'TEXTAREA')) {
    input = event.target.closest('#prompt-textarea') || event.target;
  }
  if (!input) return;

  const isInputTarget = event.target === input ||
    (input.contains && input.contains(event.target)) ||
    (event.target.closest && event.target.closest('#prompt-textarea'));
  if (!isInputTarget) return;

  interceptSubmission(event, input);
}

function handleGlobalClick(event) {
  if (isBypassingSubmit) return;

  const platform = detectPlatform();
  const sendSelectors = SEND_SELECTORS[platform] || ['button[type="submit"]'];
  let isSendClick = false;

  for (const sel of sendSelectors) {
    try {
      if (event.target.closest && event.target.closest(sel)) {
        isSendClick = true;
        break;
      }
    } catch (_) {}
  }

  if (!isSendClick) return;

  const input = currentInput || findPromptInput() || document.querySelector('#prompt-textarea, div.ProseMirror, form [contenteditable="true"], form textarea, textarea');
  if (!input) return;

  interceptSubmission(event, input);
}

function interceptSubmission(event, inputEl) {
  const text = getPromptText(inputEl);
  if (!text || text.trim().length === 0) return;

  const startTime = performance.now();

  // Check website restrictions
  const currentHost = window.location.hostname;
  if (policySettings.restricted_websites && policySettings.restricted_websites.some(w => currentHost.includes(w))) {
    event.preventDefault();
    event.stopImmediatePropagation();
    showRestrictedWebsiteModal(currentHost);
    return;
  }

  const scanResult = clientSideScan(text);
  const latency = performance.now() - startTime;
  window.__ca_interception_latency = latency;

  // Persist telemetry event to backend database (scan / block / warn / allow)
  sendToBackground({
    action: 'scan',
    text,
    log_event: true,
    warn_threshold: policySettings.warn_threshold,
    block_threshold: policySettings.block_threshold,
    enabled_rules: policySettings.enabled_rules,
  }).catch(() => {});

  if (policySettings.auto_redact_on_send && scanResult.hasPII && scanResult.action !== 'BLOCK') {
    event.preventDefault();
    event.stopImmediatePropagation();
    const redacted = clientSideRedact(text);
    setPromptInputValue(inputEl, redacted);
    showToast('Prompt auto-redacted before sending', 'success');
    triggerActualSubmit(inputEl);
    return;
  }

  if (scanResult.action === 'BLOCK') {
    event.preventDefault();
    event.stopImmediatePropagation();
    showBlockedModal(scanResult, text, inputEl);
    return;
  }

  if (scanResult.action === 'WARN') {
    event.preventDefault();
    event.stopImmediatePropagation();
    showWarningModal(scanResult, text, inputEl);
    return;
  }

  // ALLOW: event continues normally
}

function triggerActualSubmit(inputEl) {
  isBypassingSubmit = true;
  const platform = detectPlatform();
  const sendSelectors = SEND_SELECTORS[platform] || ['button[type="submit"]'];
  let clicked = false;
  for (const sel of sendSelectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn && (btn.offsetHeight > 0 || btn.offsetWidth > 0) && !btn.disabled) {
        btn.click();
        clicked = true;
        break;
      }
    } catch (_) {}
  }

  if (!clicked && inputEl) {
    inputEl.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }));
  }

  setTimeout(() => {
    isBypassingSubmit = false;
  }, 400);
}

async function loadPolicySettings() {
  try {
    const res = await sendToBackground({ action: 'get_settings' });
    if (res && typeof res === 'object') {
      policySettings = { ...policySettings, ...res };
    }
  } catch (_) {
    // Keep local default policy
  }
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

    // Background API scan if backend is available (preview only, avoid duplicate event logging while typing)
    if (isBackendOnline) {
      try {
        const result = await sendToBackground({ action: 'scan', text, log_event: false });
        if (requestId !== liveScanSequence) return;
        if (result && result.risk_action) {
          const apiLabel = result.risk_label || result.risk_action;
          updateHudStatus(result.risk_action, apiLabel);
        } else if (result && result.risk_score !== undefined) {
          let action = 'ALLOW';
          if (result.risk_score >= (policySettings.block_threshold || 70)) action = 'BLOCK';
          else if (result.risk_score >= (policySettings.warn_threshold || 30)) action = 'WARN';
          updateHudStatus(action, `Score: ${result.risk_score}`);
        }
      } catch (_) {
        // Backend scan failed — client-side result already shown
      }
    }
  }, 300);
}

// ─── MutationObserver Setup ───────────────────────────────────────────────────

function initObserver() {
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
  if (currentInput && currentInput !== input) {
    currentInput.removeEventListener('input', handleInput);
    currentInput.removeEventListener('keyup', handleInput);
  }

  currentInput = input;
  currentInput.addEventListener('input', handleInput);
  currentInput.addEventListener('keyup', handleInput);
  currentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      handleGlobalKeydown(e);
    }
  }, true);

  if (!hudInjected) {
    injectHud();
  }

  showHud();
}

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
  const platform = detectPlatform();
  if (platform === 'unknown') return;

  // Immediately inject and display the floating HUD pill on supported platforms
  if (!hudInjected) {
    injectHud();
  }
  showHud();

  await checkBackendStatus();
  await loadPolicySettings();

  // Attach global capture phase interception listeners
  window.addEventListener('keydown', handleGlobalKeydown, true);
  window.addEventListener('click', handleGlobalClick, true);

  initObserver();

  // Periodic status and policy check
  setInterval(async () => {
    const wasOnline = isBackendOnline;
    await checkBackendStatus();
    if (isBackendOnline) {
      await loadPolicySettings();
    }
    if (wasOnline !== isBackendOnline && shadowRoot) {
      if (isBackendOnline) {
        showToast('ContextArmor backend connected', 'success');
      } else {
        showToast('Backend offline — local scan only', 'warning');
      }
    }
  }, 30000);

  window.addEventListener('beforeunload', () => {
    if (hudHost && hudHost.parentNode) {
      hudHost.remove();
    }
  });
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

init();
