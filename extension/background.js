// ContextArmor AI - Background Service Worker
const API_BASES = ['http://127.0.0.1:8000', 'http://localhost:8000'];

// ---------------------------------------------------------------------------
// 1. API helper
// ---------------------------------------------------------------------------

async function callAPI(endpoint, method = 'GET', data = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (data !== null) {
    options.body = JSON.stringify(data);
  }

  let response;
  let lastError;
  for (const base of API_BASES) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      response = await fetch(base + endpoint, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      break;
    } catch (networkErr) {
      clearTimeout(timeoutId);
      lastError = networkErr;
    }
  }

  if (!response) {
    const reason = lastError && lastError.name === 'AbortError'
      ? 'the request timed out'
      : 'connection was refused or the extension lacks local API access';
    throw new Error(`Cannot reach ContextArmor at 127.0.0.1:8000 (${reason}). Confirm the backend is listening on port 8000 and reload the extension after granting local network access.`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`API error ${response.status}: ${text}`);
  }

  // Some endpoints may return no body (204 / empty)
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// 2. Badge helper
// ---------------------------------------------------------------------------

function updateBadge(tabId, riskScore, action) {
  const badgeOpts = { tabId };

  if (action === 'BLOCK') {
    chrome.action.setBadgeBackgroundColor({ color: '#EF4444', tabId });
    chrome.action.setBadgeText({ text: '🛡', ...badgeOpts });
  } else if (action === 'WARN') {
    chrome.action.setBadgeBackgroundColor({ color: '#F59E0B', tabId });
    chrome.action.setBadgeText({ text: '!', ...badgeOpts });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: '#10B981', tabId });
    chrome.action.setBadgeText({ text: '✓', ...badgeOpts });
  }
}

// ---------------------------------------------------------------------------
// 3. Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Always return true so the message channel stays open for async work
  (async () => {
    try {
      switch (msg.action) {

        case 'scan': {
          const result = await callAPI('/api/scan', 'POST', {
            text: msg.text,
            warn_threshold: msg.warn_threshold,
            block_threshold: msg.block_threshold,
            enabled_rules: msg.enabled_rules,
            log_event: msg.log_event !== false,
          });
          const tabId = sender.tab && sender.tab.id;
          if (tabId !== undefined && tabId !== null) {
            updateBadge(tabId, result.risk_score, result.action);
          }
          sendResponse({ success: true, result });
          break;
        }

        case 'optimize': {
          const result = await callAPI('/api/optimize', 'POST', {
            text: msg.text,
            mode: msg.mode || 'lossless',
          });
          sendResponse({ success: true, result });
          break;
        }

        case 'transfer': {
          const result = await callAPI('/api/transfer', 'POST', {
            messages: msg.messages,
          });
          sendResponse({ success: true, result });
          break;
        }

        case 'open_fresh_chat': {
          const chatUrls = {
            chatgpt: 'https://chatgpt.com/',
            claude: 'https://claude.ai/new',
            gemini: 'https://gemini.google.com/app',
          };
          const url = chatUrls[msg.platform] || chatUrls.chatgpt;
          await chrome.tabs.create({ url, active: true });
          sendResponse({ success: true, result: { opened: true } });
          break;
        }

        case 'analytics': {
          const params = new URLSearchParams();
          if (msg.module) params.append('module', msg.module);
          if (msg.action_filter) params.append('action', msg.action_filter);
          if (msg.days) params.append('days', msg.days);
          const queryString = params.toString() ? `?${params.toString()}` : '';
          const result = await callAPI(`/api/analytics${queryString}`, 'GET');
          sendResponse({ success: true, result });
          break;
        }

        case 'get_settings': {
          const result = await callAPI('/api/settings', 'GET');
          sendResponse({ success: true, result });
          break;
        }

        case 'save_settings': {
          const result = await callAPI('/api/settings', 'POST', msg.settings || {});
          sendResponse({ success: true, result });
          break;
        }

        case 'reset_demo': {
          await callAPI('/api/reset-demo', 'POST');
          sendResponse({ success: true });
          break;
        }

        case 'check_backend': {
          try {
            await callAPI('/', 'GET');
            sendResponse({ online: true, success: true });
          } catch {
            sendResponse({ online: false, success: false });
          }
          break;
        }

        default: {
          sendResponse({ success: false, error: `Unknown action: ${msg.action}` });
        }
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  })();

  return true; // keep message channel open
});

// ---------------------------------------------------------------------------
// 4. Install defaults
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    autoIntercept: true,
    signaturePruning: false,
    apiKey: '',
    provider: 'openai',
    scanCount: 0,
    tokensaved: 0,
    threatsBlocked: 0,
  });
});
