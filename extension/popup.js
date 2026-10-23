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
// Interactive Ambient Particle Engine
// ---------------------------------------------------------------------------

function initParticlesCanvas() {
  const canvas = document.getElementById('particles-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width = canvas.width = canvas.parentElement.offsetWidth || 400;
  let height = canvas.height = canvas.parentElement.offsetHeight || 600;

  window.addEventListener('resize', () => {
    if (!canvas.parentElement) return;
    width = canvas.width = canvas.parentElement.offsetWidth || 400;
    height = canvas.height = canvas.parentElement.offsetHeight || 600;
  });

  const count = 26;
  const particles = [];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      radius: Math.random() * 1.8 + 1,
      alpha: Math.random() * 0.45 + 0.2,
    });
  }

  function render() {
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < count; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = width;
      if (p.x > width) p.x = 0;
      if (p.y < 0) p.y = height;
      if (p.y > height) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(186, 215, 255, ${p.alpha})`;
      ctx.fill();

      for (let j = i + 1; j < count; j++) {
        const p2 = particles[j];
        const dx = p.x - p2.x;
        const dy = p.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 65) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.strokeStyle = `rgba(147, 197, 253, ${0.16 * (1 - dist / 65)})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
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
// Animated Counters & Number Formatting
// ---------------------------------------------------------------------------

/**
 * Animate a numeric element from 0 to target value with easing.
 * @param {HTMLElement} element
 * @param {number} target
 * @param {boolean} isDecimal
 * @param {number} duration
 */
function animateCounter(element, target, isDecimal = false, duration = 650) {
  if (!element) return;
  const num = Number(target) || 0;
  if (num === 0) {
    element.textContent = isDecimal ? '0.0' : '0';
    return;
  }
  const startTime = performance.now();
  function update(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    // Ease-out cubic
    const factor = 1 - Math.pow(1 - progress, 3);
    const currentVal = num * factor;
    if (isDecimal) {
      element.textContent = currentVal.toFixed(1);
    } else if (num >= 1000) {
      element.textContent = (currentVal / 1000).toFixed(1) + 'k';
    } else {
      element.textContent = String(Math.round(currentVal));
    }
    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      element.textContent = isDecimal ? num.toFixed(1) : formatNumber(num);
    }
  }
  requestAnimationFrame(update);
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

  if (scansEl) animateCounter(scansEl, totalScans, false);
  if (blockedEl) animateCounter(blockedEl, Number(data.threats_blocked) || 0, false);
  if (tokensEl) animateCounter(tokensEl, Number(data.total_tokens_saved) || 0, false);
  if (riskEl) {
    const avg = data.average_risk_score != null ? Number(data.average_risk_score) : 0;
    animateCounter(riskEl, avg, true);
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
      if (!chrome.tabs || !chrome.tabs.query) {
        outputDiv.textContent = 'ℹ Extension Context: Active tab detection connects live to ChatGPT, Claude, and Gemini.';
        outputDiv.style.display = 'block';
        return;
      }

      // Get the active tab.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        outputDiv.textContent = '⚠ Could not determine the active tab.';
        outputDiv.style.display = 'block';
        return;
      }

      if (!chrome.scripting || !chrome.scripting.executeScript) {
        outputDiv.textContent = 'ℹ Scrapes active conversation in supported AI model tabs.';
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
// Guardrails & Security Studio Controller
// ---------------------------------------------------------------------------

function setupGuardrailsStudio() {
  const textarea = document.getElementById('guardrails-input');
  const scanBtn = document.getElementById('btn-scan-guardrails');
  const redactBtn = document.getElementById('btn-redact-guardrails');
  const preview = document.getElementById('guardrails-preview');
  const riskVal = document.getElementById('risk-gauge-val');
  const riskCircle = document.getElementById('risk-gauge-circle');
  const actionBadge = document.getElementById('guardrails-action-badge');
  const piiCount = document.getElementById('stat-pii-count');
  const secretCount = document.getElementById('stat-secret-count');
  const injCount = document.getElementById('stat-inj-count');

  if (!scanBtn) return;

  function updateRiskGauge(score, action) {
    if (riskVal) animateCounter(riskVal, score, false, 500);
    if (riskCircle) {
      const offset = 264 - (264 * Math.min(score, 100)) / 100;
      riskCircle.style.strokeDashoffset = offset;
      if (score > 60) {
        riskCircle.style.stroke = '#ef4444';
        if (riskVal) riskVal.style.color = '#f87171';
      } else if (score > 20) {
        riskCircle.style.stroke = '#f59e0b';
        if (riskVal) riskVal.style.color = '#fbbf24';
      } else {
        riskCircle.style.stroke = '#10b981';
        if (riskVal) riskVal.style.color = '#34d399';
      }
    }
    if (actionBadge) {
      if (action === 'BLOCK' || score > 60) {
        actionBadge.textContent = 'Status: High Risk';
        actionBadge.style.color = '#f87171';
      } else if (action === 'WARN' || score > 20) {
        actionBadge.textContent = 'Status: Warning';
        actionBadge.style.color = '#fbbf24';
      } else {
        actionBadge.textContent = 'Status: Clean';
        actionBadge.style.color = '#34d399';
      }
    }
  }

  scanBtn.addEventListener('click', async () => {
    const text = textarea ? textarea.value.trim() : '';
    if (!text) {
      if (textarea) textarea.focus();
      return;
    }
    scanBtn.disabled = true;
    scanBtn.textContent = '⏳ Scanning Threat Vector…';
    if (preview) preview.style.display = 'none';

    try {
      const result = await sendToBackground('scan', { text });
      const d = result && result.data ? result.data : result;
      const score = Number(d?.risk_score) || 0;
      const action = d?.action || 'ALLOW';
      const pii = d?.pii_count ?? (d?.pii_findings?.length ?? 0);
      const secrets = d?.secrets_count ?? (d?.secrets_findings?.length ?? 0);
      const injections = d?.injection_count ?? (d?.injection_findings?.length ?? 0);

      updateRiskGauge(score, action);
      if (piiCount) piiCount.textContent = pii;
      if (secretCount) secretCount.textContent = secrets;
      if (injCount) injCount.textContent = injections;

      if (preview) {
        const report = {
          risk_score: score,
          enforcement_action: action,
          pii_findings: d?.pii_findings || [],
          secrets_findings: d?.secrets_findings || [],
          injection_findings: d?.injection_findings || []
        };
        preview.textContent = JSON.stringify(report, null, 2);
        preview.style.display = 'block';
      }
    } catch (err) {
      if (preview) {
        preview.textContent = `⚠ Scan error: ${err.message}`;
        preview.style.display = 'block';
      }
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = '🛡️ Run Deep Security Scan';
    }
  });

  if (redactBtn) {
    redactBtn.addEventListener('click', async () => {
      const text = textarea ? textarea.value.trim() : '';
      if (!text) return;
      redactBtn.disabled = true;
      try {
        const result = await sendToBackground('scan', { text });
        const d = result && result.data ? result.data : result;
        const sanitized = d?.sanitized_text || text;
        if (preview) {
          preview.textContent = sanitized;
          preview.style.display = 'block';
        }
      } catch (err) {
        if (preview) {
          preview.textContent = `⚠ Redact error: ${err.message}`;
          preview.style.display = 'block';
        }
      } finally {
        redactBtn.disabled = false;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Dedicated AST Code & Prompt Compression Studio Controller
// ---------------------------------------------------------------------------

function setupCompressionStudio() {
  const textarea = document.getElementById('compress-input');
  const runBtn = document.getElementById('btn-run-compress');
  const copyBtn = document.getElementById('btn-copy-compressed');
  const outputDiv = document.getElementById('compress-output');
  const tokenStatDiv = document.getElementById('quick-token-stat');
  const gaugeVal = document.getElementById('compress-gauge-val');
  const gaugeCircle = document.getElementById('compress-gauge-circle');
  const reductionChip = document.getElementById('compression-reduction-chip');
  const origTokensEl = document.getElementById('comp-orig-tokens');
  const newTokensEl = document.getElementById('comp-new-tokens');
  const savedTokensEl = document.getElementById('comp-saved-tokens');

  if (!runBtn) return;

  runBtn.addEventListener('click', async () => {
    const text = textarea ? textarea.value.trim() : '';
    if (!text) {
      if (textarea) textarea.focus();
      return;
    }

    runBtn.disabled = true;
    runBtn.textContent = '⚡ Optimizing AST…';
    if (outputDiv) outputDiv.style.display = 'none';

    chrome.storage.local.get(['signaturePruning'], async (prefs) => {
      const mode = prefs.signaturePruning ? 'signatures' : 'lossless';
      try {
        const result = await sendToBackground('optimize', { text, mode });
        const d = result && result.data ? result.data : result;
        const optimized = d?.optimized_prompt || d?.optimized || text;

        if (outputDiv) {
          outputDiv.textContent = optimized;
          outputDiv.style.display = 'block';
        }

        if (copyBtn) {
          copyBtn.style.display = 'inline-flex';
          copyBtn.onclick = async () => {
            try {
              await navigator.clipboard.writeText(optimized);
              copyBtn.textContent = '✅ Copied!';
              setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 1500);
            } catch (_) {}
          };
        }

        const origTokens = Number(d?.original_tokens) || Math.max(1, (text.length / 4) | 0);
        const savedTokens = Number(d?.tokens_saved) || 0;
        const newTokens = Math.max(0, origTokens - savedTokens);
        const reductionPct = Number(d?.reduction_percentage) || (origTokens > 0 ? (savedTokens / origTokens) * 100 : 0);

        if (origTokensEl) origTokensEl.textContent = origTokens;
        if (newTokensEl) newTokensEl.textContent = newTokens;
        if (savedTokensEl) savedTokensEl.textContent = `${savedTokens} (${reductionPct.toFixed(1)}%)`;

        if (gaugeVal) {
          gaugeVal.textContent = `${Math.round(reductionPct)}%`;
        }
        if (reductionChip) {
          reductionChip.textContent = `${reductionPct.toFixed(1)}% Saved`;
        }
        if (gaugeCircle) {
          const offset = 264 - (264 * Math.min(reductionPct, 100)) / 100;
          gaugeCircle.style.strokeDashoffset = offset;
        }

        if (tokenStatDiv && savedTokens > 0) {
          tokenStatDiv.textContent = `✅ Saved ${savedTokens} tokens (${reductionPct.toFixed(1)}% reduction)`;
          tokenStatDiv.style.display = 'block';
        }
      } catch (err) {
        if (outputDiv) {
          outputDiv.textContent = `⚠ Optimization error: ${err.message}`;
          outputDiv.style.display = 'block';
        }
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = '⚡ Compress AST Code';
      }
    });
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
// Multi-Studio View Router
// ---------------------------------------------------------------------------

const STUDIOS = ['overview', 'guardrails', 'compression', 'transfer', 'analytics'];

function navigateTo(studioName) {
  if (!STUDIOS.includes(studioName)) studioName = 'overview';

  STUDIOS.forEach((name) => {
    const panelId = name === 'overview' ? 'view-hero' : `view-${name}`;
    const tabId = `tab-${name}`;
    const panel = document.getElementById(panelId);
    const tab = document.getElementById(tabId);

    if (panel) {
      if (name === studioName) {
        panel.classList.add('active-view');
      } else {
        panel.classList.remove('active-view');
      }
    }

    if (tab) {
      if (name === studioName) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    }
  });

  if (studioName === 'analytics') {
    loadAnalytics();
  }
}

function setupViewNavigation() {
  // Navigation tabs
  STUDIOS.forEach((name) => {
    const tab = document.getElementById(`tab-${name}`);
    if (tab) {
      tab.addEventListener('click', () => navigateTo(name));
    }
  });

  // Hero feature cards -> deep-link directly to their specific studios!
  const heroGuardrails = document.getElementById('hero-btn-guardrails');
  if (heroGuardrails) {
    heroGuardrails.addEventListener('click', () => navigateTo('guardrails'));
  }

  const heroCompression = document.getElementById('hero-btn-compression');
  if (heroCompression) {
    heroCompression.addEventListener('click', () => navigateTo('compression'));
  }

  const heroTransfer = document.getElementById('hero-btn-transfer');
  if (heroTransfer) {
    heroTransfer.addEventListener('click', () => navigateTo('transfer'));
  }

  // Get Started button
  const btnGetStarted = document.getElementById('btn-get-started');
  if (btnGetStarted) {
    btnGetStarted.addEventListener('click', () => navigateTo('guardrails'));
  }

  // Back breadcrumb buttons
  document.querySelectorAll('.btn-back-breadcrumb').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-back') || 'overview';
      navigateTo(target);
    });
  });

  // Close popup button
  const btnClose = document.getElementById('btn-close-popup');
  if (btnClose) {
    btnClose.addEventListener('click', () => {
      window.close();
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  initParticlesCanvas();
  setupViewNavigation();
  await checkBackendStatus();
  await loadAnalytics();

  setupToggles();
  setupGuardrailsStudio();
  setupCompressionStudio();
  setupTransfer();
  setupQuickOptimizer();

  const openDashBtn = document.getElementById('btn-open-dashboard');
  if (openDashBtn) {
    openDashBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    });
  }
});
