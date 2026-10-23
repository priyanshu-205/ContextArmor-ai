# 🛡️ ContextArmor AI

**Intelligent Chrome Extension for AI Prompt Optimization, Code Compression, Security & Context Transfer**

> Production-grade pilot implementation — FastAPI + SQLite backend · Chrome MV3 Extension · Zero external UI dependencies

---

## ✅ Verification Results

```
12 passed, 0 failed out of 12 tests
✅ ALL TESTS PASSED — ContextArmor AI is production-ready!
```

| Module | Result |
|--------|--------|
| Email / Phone / PAN / Credit Card (Luhn) detection | ✅ PASS |
| OpenAI / High-entropy secret detection | ✅ PASS |
| Prompt injection detection | ✅ PASS |
| Python lossless compression | ✅ 39.8% reduction |
| Python AST signatures mode | ✅ 64.3% reduction |
| JavaScript comment stripping | ✅ 57.2% reduction |
| Chat transfer bridge generation | ✅ PASS |
| Analytics SQLite aggregation | ✅ PASS |

---

## 🚀 Quick Start — 2 Steps

### Step 1 — Start the FastAPI Backend

```bash
# Navigate to the backend directory
cd ContextArmor-ai/backend

# Install dependencies (first time only)
pip install -r requirements.txt

# Start the server
python main.py
```

The API will be live at **http://127.0.0.1:8000**  
Swagger docs available at: http://127.0.0.1:8000/docs

> **Note:** The server auto-seeds realistic demo analytics data on first launch.

---

### Step 2 — Load the Chrome Extension

1. Open Chrome and go to: `chrome://extensions/`
2. Enable **Developer mode** (toggle, top-right)
3. Click **"Load unpacked"**
4. Select the `ContextArmor-ai/extension/` folder
5. The **🛡️ ContextArmor AI** icon will appear in your toolbar

**That's it!** Visit ChatGPT, Claude, or Gemini — the floating HUD activates automatically.

---

## 📁 Project Structure

```
ContextArmor-ai/
├── backend/
│   ├── requirements.txt        # fastapi, uvicorn, pydantic, tiktoken, httpx
│   ├── main.py                 # FastAPI app, CORS, all 5 endpoints
│   ├── database.py             # SQLite schema, analytics queries, demo seeding
│   ├── guardrails_engine.py    # 16-pattern security scanner (PII + secrets + injection)
│   ├── compressor_engine.py    # AST compressor + prompt optimizer + LLM enhancement
│   ├── transfer_engine.py      # Chat parser + Continuation Bridge Prompt generator
│   └── verify_pilot.py         # 12-test automated verification suite
└── extension/
    ├── manifest.json           # Chrome MV3 manifest
    ├── background.js           # Service worker — API proxy + badge updates
    ├── content.js              # Shadow DOM HUD for ChatGPT/Claude/Gemini
    ├── popup.html / popup.js   # Toolbar popup — KPIs, toggles, quick actions
    ├── dashboard.html / .js    # Full analytics dashboard + interactive sandbox
    ├── styles.css              # Shared dark glassmorphism design system
    └── icons/                  # Extension icons (16px, 48px, 128px)
```

---

## 🔌 API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scan` | POST | Security scan — PII, secrets, prompt injection detection |
| `/api/optimize` | POST | Guardrails + AST compression + prompt optimization |
| `/api/transfer` | POST | Chat transfer → Continuation Bridge Prompt |
| `/api/analytics` | GET | Aggregated metrics from SQLite |
| `/api/reset-demo` | POST | Reset and re-seed demo analytics data |

### POST `/api/scan`
```json
{ "text": "My key is sk-abc123... and email john@example.com" }
```
Returns: `findings[]`, `risk_score`, `action` (ALLOW/WARN/BLOCK), `sanitized_text`

### POST `/api/optimize`
```json
{ "text": "...", "mode": "lossless", "api_key": null, "provider": null }
```
`mode`: `"lossless"` (default) or `"signatures"` (AST body pruning)  
Returns: `optimized_prompt`, `original_tokens`, `compressed_tokens`, `tokens_saved`, `reduction_percentage`

### POST `/api/transfer`
```json
{ "messages": [{"role": "user", "content": "..."}] }
```
Returns: `bridge_prompt`, `original_tokens`, `bridge_tokens`, `compression_ratio`, extracted insights

---

## 🛡️ Security Features

### Guardrails Engine — 16 Detectors
| Detector | Severity | Weight |
|----------|----------|--------|
| Email, Phone, IPv4 | MEDIUM | +15 each |
| Credit Card (Luhn), PAN, Govt ID, JWT, Slack Token | HIGH | +30 each |
| OpenAI Key, Anthropic Key, AWS Key, GitHub Token, Google API Key, Private Key | CRITICAL | +50 each |
| High-Entropy Secret (Shannon > 3.8 bits/char) | HIGH | +30 |
| Prompt Injection (9 patterns) | CRITICAL | +50 each |

**Risk thresholds:** ALLOW < 20 · WARN 20–59 · BLOCK ≥ 60

### Code Compressor
- **Lossless mode**: Python AST docstring removal + comment stripping. JS/TS/Java state-machine comment stripper.
- **Signatures mode**: Python AST body pruning — keeps imports, class/function signatures with type annotations; replaces bodies >5 lines with `pass  # [Body pruned for context efficiency]`

### Chat Transfer
Extracts: Primary Objective · Tech Stack & Constraints · Key Decisions · Latest Code State · Pending Tasks  
Outputs a structured Continuation Bridge Prompt for zero-context-loss session transfer.

---

## 🎓 Live Demo — Dashboard Sandbox

Open the dashboard (popup → "Open Full Dashboard") to demo all 3 modules interactively:

| Preset | Tests |
|--------|-------|
| 🔴 Leaky Dev Prompt | API key + PII + injection → risk score gauge + redaction |
| 📝 Bloated Python/JS Code | Lossless vs. AST Signatures diff view + token savings |
| 🐛 12-Turn Debug Session | Full bridge prompt generation + compression metrics |

---

## ⚙️ Configuration

**Optional LLM Enhancement** — configure in the Dashboard Settings (⚙️):
- OpenAI (GPT-4o-mini)
- Anthropic (Claude Haiku)  
- Google Gemini Flash
- Local Ollama (llama3)

Falls back to deterministic engine if no API key is configured.

---

## 🏗️ Architecture

```
Chrome Extension (MV3)
├── content.js ──────────────────→ Floating Shadow DOM HUD
├── popup.js ────────────────────→ Quick stats + actions  
├── dashboard.js ────────────────→ Analytics + sandbox
└── background.js ───────────────→ API proxy + badge

FastAPI Backend (http://127.0.0.1:8000)
├── guardrails_engine.py ────────→ Regex + Luhn + Entropy
├── compressor_engine.py ────────→ AST + State-machine
├── transfer_engine.py ──────────→ NLP extraction + bridge
└── database.py ─────────────────→ SQLite (contextarmor.db)
```

---

*Built with FastAPI · tiktoken · Python AST · Vanilla ES6 · Shadow DOM · SQLite*

