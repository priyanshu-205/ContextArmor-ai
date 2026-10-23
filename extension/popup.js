// ContextArmor AI - Popup Controller
'use strict';

const API_BASE = 'http://127.0.0.1:8000';

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

/**
 * Send a message to the background service worker and return its response.
 * @param {string} action
 * @param {object} data
 * @returns {Promise<object>}
 */
function sendToBackground(action, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/**
 * Format a number into a compact string (e.g. 1500 → "1.5k").
 * @param {number} n
 * @returns {string}
 */
function formatNumber(n) {
  const num = Number(n) || 0;
  return num >= 1000 ? (num / 1000).toFixed(1) + 'k' : String(num);
}

// ---------------------------------------------------------------------------
// Backend status
// ---------------------------------------------------------------------------

/**
 * Ask the background worker whether the Python backend is reachable and
 * update the status badge in the popup header accordingly.
 */
async function checkBackendStatus() {
  const badge = document.getElementById('backend-status');
  const statusText = document.getElementById('status-text');

  // Optimistic "checking" state is already set by the HTML.
  const result = await sendToBackground('check_backend');

  // Clear both classes and apply the correct one.
  badge.classList.remove('status-online', 'status-offline');

  if (result && result.success) {
    badge.classList.add('status-online');
    statusText.textContent = ':8000 Online';
  } else {
    badge.classList.add('status-offline');
    statusText.textContent = 'Offline';
  }
}

// ---------------------------------------------------------------------------
// Analytics / KPI cards
// ---------------------------------------------------------------------------

/**
 * Load analytics from the background worker and populate the KPI cards.
 */
async function loadAnalytics() {
  const result = await sendToBackground('analytics');

  if (!result || !result.success) return;

  const data = result.data || result; // support both wrapped and flat responses

  const totalScans =
    (Number(data.total_scans) || 0) +
    (Number(data.total_optimizations) || 0) +
    (Number(data.total_transfers) || 0);

  const scansEl = document.getElementById('kpi-scans');
  const blockedEl = document.getElementById('kpi-blocked');
  const tokensEl = document.getElementById('kpi-tokens');
  const riskEl = document.getElementById('kpi-risk');

  if (scansEl) scansEl.textContent = formatNumber(totalScans);
  if (blockedEl) blockedEl.textContent = formatNumber(Number(data.threats_blocked) || 0);
  if (tokensEl) tokensEl.textContent = formatNumber(Number(data.total_tokens_saved) || 0);
  if (riskEl) {
    const avg = data.average_risk_score;
    riskEl.textContent = avg != null ? Number(avg).toFixed(1) : '0.0';
  }
}

// ---------------------------------------------------------------------------
// Toggle switches
// ---------------------------------------------------------------------------

/**
 * Initialise the settings toggles by reading persisted state from
 * chrome.storage.local and wiring up click handlers.
 */
function setupToggles() {
  const autoInterceptBtn = document.getElementById('toggle-auto-intercept');
  const signatureBtn = document.getElementById('toggle-signature');

  // Load persisted state.
  chrome.storage.local.get(['autoIntercept', 'signaturePruning'], (prefs) => {
    // autoIntercept defaults to true (button already has .active in HTML).
    if (prefs.autoIntercept === false) {
      autoInterceptBtn.classList.remove('active');
    }
    // signaturePruning defaults to false.
    if (prefs.signaturePruning === true) {
      signatureBtn.classList.add('active');
    }
  });

  autoInterceptBtn.addEventListener('click', () => {
    const isActive = autoInterceptBtn.classList.toggle('active');
    chrome.storage.local.set({ autoIntercept: isActive });
  });

  signatureBtn.addEventListener('click', () => {
    const isActive = signatureBtn.classList.toggle('active');
    chrome.storage.local.set({ signaturePruning: isActive });
  });
}

// ---------------------------------------------------------------------------
// Scrape & Transfer
// ---------------------------------------------------------------------------

/**
 * Self-contained page scraper injected into the active tab via executeScript.
 * Must NOT reference any variables from the outer popup scope.
 */
function scrapePage() {
  const messages = [];

  // ── ChatGPT ────────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-message-author-role]').forEach((el) => {
    messages.push({
      role: el.getAttribute('data-message-author-role'),
      content: el.innerText.trim(),
    });
  });
  if (messages.length > 0) return messages;

  // ── Claude ─────────────────────────────────────────────────────────────────
  const humanTurns = document.querySelectorAll('.human-turn, [data-testid="human-turn"]');
  const botTurns = document.querySelectorAll('.bot-turn, [data-testid="ai-turn"]');
  if (humanTurns.length > 0) {
    const maxLen = Math.max(humanTurns.length, botTurns.length);
    for (let i = 0; i < maxLen; i++) {
      if (humanTurns[i]) {
        messages.push({ role: 'user', content: humanTurns[i].innerText.trim() });
      }
      if (botTurns[i]) {
        messages.push({ role: 'assistant', content: botTurns[i].innerText.trim() });
      }
    }
    return messages;
  }

  // ── Gemini ─────────────────────────────────────────────────────────────────
  document.querySelectorAll('.user-query-content, .model-response-text').forEach((el) => {
    const role = el.classList.contains('user-query-content') ? 'user' : 'assistant';
    messages.push({ role, content: el.innerText.trim() });
  });

  return messages.filter((m) => m.content.length > 0);
}

/**
 * Wire up the "Scrape & Transfer" button and its sub-actions (copy / open).
 */
function setupTransfer() {
  const btn = document.getElementById('btn-scrape-transfer');
  const spinner = document.getElementById('transfer-spinner');
  const outputDiv = document.getElementById('transfer-output');
  const actionsDiv = document.getElementById('transfer-actions');
  const copyBtn = document.getElementById('btn-copy-bridge');
  const openFreshBtn = document.getElementById('btn-open-fresh');

  // Persisted bridge prompt for sub-action buttons.
  let lastBridgePrompt = '';

  btn.addEventListener('click', async () => {
    // Loading state.
    btn.classList.add('loading');
    spinner.style.display = 'inline';
    outputDiv.style.display = 'none';
    actionsDiv.style.display = 'none';
    lastBridgePrompt = '';

    try {
      // Get the active tab.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        outputDiv.textContent = '⚠ Could not determine the active tab.';
        outputDiv.style.display = 'block';
        return;
      }

      // Inject the scraper into the page.
      let injectionResults;
      try {
        injectionResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrapePage,
        });
      } catch (err) {
        outputDiv.textContent = `⚠ Script injection failed: ${err.message}`;
        outputDiv.style.display = 'block';
        return;
      }

      const messages =
        injectionResults && injectionResults[0] ? injectionResults[0].result : [];

      if (!messages || messages.length === 0) {
        outputDiv.textContent =
          '⚠ No chat messages found on this page.\nSupported: ChatGPT, Claude, Gemini.';
        outputDiv.style.display = 'block';
        return;
      }

      // Send messages to background for transfer / bridge-prompt generation.
      const result = await sendToBackground('transfer', { messages });

      if (!result || !result.success) {
        const errMsg = result.error || 'Transfer failed — is the backend running?';
        outputDiv.textContent = `⚠ ${errMsg}`;
        outputDiv.style.display = 'block';
        return;
      }

      const bridgePrompt =
        result.bridge_prompt || result.data?.bridge_prompt || JSON.stringify(result, null, 2);

      lastBridgePrompt = bridgePrompt;

      // Show first 400 chars in the preview.
      outputDiv.textContent =
        bridgePrompt.length > 400 ? bridgePrompt.slice(0, 400) + '…' : bridgePrompt;
      outputDiv.style.display = 'block';
      actionsDiv.style.display = 'flex';
    } finally {
      btn.classList.remove('loading');
      spinner.style.display = 'none';
    }
  });

  // ── Copy bridge prompt ─────────────────────────────────────────────────────
  copyBtn.addEventListener('click', async () => {
    if (!lastBridgePrompt) return;
    try {
      await navigator.clipboard.writeText(lastBridgePrompt);
      const original = copyBtn.textContent;
      copyBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    } catch (_) {
      copyBtn.textContent = '⚠ Failed';
    }
  });

  // ── Copy + open a fresh ChatGPT tab ───────────────────────────────────────
  openFreshBtn.addEventListener('click', async () => {
    if (!lastBridgePrompt) return;
    try {
      await navigator.clipboard.writeText(lastBridgePrompt);
    } catch (_) {
      // Non-fatal — still open the tab.
    }
    chrome.tabs.create({ url: 'https://chatgpt.com/' });
  });
}

// ---------------------------------------------------------------------------
// Quick Optimizer
// ---------------------------------------------------------------------------

/**
 * Wire up the Scan and Optimize buttons in the Quick Optimizer section.
 */
function setupQuickOptimizer() {
  const textarea = document.getElementById('quick-input');
  const scanBtn = document.getElementById('btn-scan-quick');
  const optimizeBtn = document.getElementById('btn-optimize-quick');
  const outputDiv = document.getElementById('quick-output');
  const tokenStatDiv = document.getElementById('quick-token-stat');

  // ── Scan ──────────────────────────────────────────────────────────────────
  scanBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) {
      textarea.focus();
      return;
    }

    scanBtn.disabled = true;
    scanBtn.textContent = '⏳ Scanning…';
    outputDiv.style.display = 'none';
    tokenStatDiv.style.display = 'none';

    try {
      const result = await sendToBackground('scan', { text });

      if (!result || !result.success) {
        outputDiv.textContent = `⚠ Scan failed: ${result.error || 'unknown error'}`;
      } else {
        const d = result.data || result;
        const summary = {
          risk_score: d.risk_score ?? 'N/A',
          action: d.action ?? 'N/A',
          pii_count: d.pii_count ?? (d.pii_findings?.length ?? 0),
          secrets_count: d.secrets_count ?? (d.secrets_findings?.length ?? 0),
          injection_count: d.injection_count ?? (d.injection_findings?.length ?? 0),
        };
        outputDiv.textContent = JSON.stringify(summary, null, 2);
      }
    } catch (err) {
      outputDiv.textContent = `⚠ Unexpected error: ${err.message}`;
    } finally {
      outputDiv.style.display = 'block';
      scanBtn.disabled = false;
      scanBtn.textContent = '🛡️ Scan';
    }
  });

  // ── Optimize ──────────────────────────────────────────────────────────────
  optimizeBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) {
      textarea.focus();
      return;
    }

    optimizeBtn.disabled = true;
    optimizeBtn.textContent = '⏳ Optimizing…';
    outputDiv.style.display = 'none';
    tokenStatDiv.style.display = 'none';

    // Read the current signature pruning preference.
    chrome.storage.local.get(['signaturePruning'], async (prefs) => {
      const mode = prefs.signaturePruning ? 'signatures' : 'lossless';

      try {
        const result = await sendToBackground('optimize', { text, mode });

        if (!result || !result.success) {
          outputDiv.textContent = `⚠ Optimization failed: ${result.error || 'unknown error'}`;
          outputDiv.style.display = 'block';
          return;
        }

        const d = result.data || result;
        const optimized = d.optimized_prompt || d.optimized || text;
        outputDiv.textContent = optimized;
        outputDiv.style.display = 'block';

        const tokensSaved = Number(d.tokens_saved) || 0;
        const reductionPct = Number(d.reduction_percentage) || 0;

        if (tokensSaved > 0 || reductionPct > 0) {
          tokenStatDiv.textContent =
            `✅ Saved ${tokensSaved} tokens (${reductionPct.toFixed(1)}% reduction)`;
          tokenStatDiv.style.display = 'block';
        }
      } catch (err) {
        outputDiv.textContent = `⚠ Unexpected error: ${err.message}`;
        outputDiv.style.display = 'block';
      } finally {
        optimizeBtn.disabled = false;
        optimizeBtn.textContent = '✨ Optimize';
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  await checkBackendStatus();
  await loadAnalytics();

  setupToggles();
  setupTransfer();
  setupQuickOptimizer();

  document.getElementById('btn-open-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });
});
