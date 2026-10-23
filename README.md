<div align="center">

![Python 3.12+](https://img.shields.io/badge/Python-3.12%20%7C%203.13%20%7C%203.14-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![Chrome Extension](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![Uvicorn](https://img.shields.io/badge/Uvicorn-ASGI%20Server-499848?style=for-the-badge&logo=gunicorn&logoColor=white)
![Tiktoken](https://img.shields.io/badge/Tiktoken-BPE%20Tokenizer-000000?style=for-the-badge)

# 🛡️ ContextArmor AI

**An intelligent, privacy-first Chrome Extension and high-performance FastAPI engine for real-time AI prompt guardrails, AST code compression, sensitive data redaction, and lossless chat transfer across ChatGPT, Claude, and Gemini.**

[Key Features](#-key-features) • [How It Works](#-how-it-works) • [System Architecture](#%EF%B8%8F-system-architecture) • [Getting Started](#-getting-started) • [API Routes](#-api-routes-reference) • [Testing](#-testing--verification)

</div>

---

## 📑 Table of Contents
- [Overview](#-overview)
- [The Problem](#-the-problem)
- [Our Solution](#-our-solution)
- [Key Features](#-key-features)
  - [1. Security Guardrails & DLP Engine](#1--security-guardrails--dlp-engine)
  - [2. AST Code Compression & Prompt Optimizer](#2--ast-code-compression--prompt-optimizer)
  - [3. Continuation Bridge Chat Transfer](#3--continuation-bridge-chat-transfer)
  - [4. Non-Intrusive Floating HUD](#4--non-intrusive-floating-hud)
  - [5. Real-Time Analytics Dashboard & Live Sandbox](#5--real-time-analytics-dashboard--live-sandbox)
  - [6. Local Data Ownership & Zero Cloud Telemetry](#6--local-data-ownership--zero-cloud-telemetry)
- [How It Works](#-how-it-works)
- [UI & Design System](#-ui--design-system)
- [System Architecture](#%EF%B8%8F-system-architecture)
  - [Component Architecture](#component-architecture)
  - [Data Model & Event Persistence](#data-model--event-persistence)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Step 1: Clone the Repository](#step-1-clone-the-repository)
  - [Step 2: Start the FastAPI Backend](#step-2-start-the-fastapi-backend)
  - [Step 3: Load the Chrome Extension](#step-3-load-the-chrome-extension)
  - [Step 4: Verify the Connection](#step-4-verify-the-connection)
- [Environment & Policy Configuration](#-environment--policy-configuration)
- [API Routes Reference](#-api-routes-reference)
- [Example Workflow](#-example-workflow)
- [Testing & Verification](#-testing--verification)
- [Limitations & Future Roadmap](#-limitations--future-roadmap)
- [Contributing](#-contributing)
- [Author & Acknowledgements](#-author--acknowledgements)
- [License](#-license)

---

## 📖 Overview
**ContextArmor AI** is a production-ready, client-side browser guardrail system paired with an asynchronous FastAPI security backend. Built specifically for developers, security engineers, and enterprise users, it acts as an intelligent shield between your keyboard and commercial Large Language Model (LLM) interfaces including **ChatGPT**, **Claude**, and **Google Gemini**.

ContextArmor intercepts prompt submissions in the browserDOM before packets leave your machine. It scans for credentials, API tokens, cryptographic keys, PII, and jailbreak prompt injection patterns, provides instant redaction or blocking, compresses bloated code blocks using Python Abstract Syntax Trees (AST) and state-machine comment strippers, and produces compact Continuation Bridge Prompts to seamlessly hand off conversations across different LLMs without losing context.

---

## 🚨 The Problem
The widespread adoption of generative AI interfaces has introduced critical security, cost, and friction points:

* **Accidental Credential & Secret Leaks:** Developers routinely paste environment variables, `.env` files, API keys (`sk-...`, `AKIA...`, `ghp_...`), database connection strings, and private certificates into public LLMs.
* **Personally Identifiable Information (PII) Exposure:** Customer emails, phone numbers, Aadhaar/PAN cards, SSNs, and credit card numbers are transmitted unredacted, triggering regulatory violations (GDPR, HIPAA, PCI-DSS).
* **Prompt Injection & Jailbreak Vulnerabilities:** Malicious or untrusted inputs can manipulate LLM system prompts, bypassing organizational security policies.
* **Context Window Waste & High Token Costs:** Pasting large source files with extensive inline documentation, docstrings, and comments consumes context windows and drives up latency and token consumption.
* **Vendor Lock-In & Fragmented Chat Handoffs:** When hitting usage caps or switching between models (e.g., from ChatGPT to Claude Opus for coding), transferring multi-turn debugging sessions requires manual copying and results in lost reasoning context.

---

## 💡 Our Solution
**ContextArmor AI** resolves these issues through a dual-engine architecture:

1. **Pre-Submission Interception:** Client-side event interception traps keystrokes and submit button clicks, scanning the prompt in real time before transmission.
2. **Deterministic 16-Pattern Guardrails Engine:** High-speed regex matching, Shannon entropy calculation (>3.8 bits/char), and Luhn algorithm validation classify threats into `ALLOW`, `WARN`, or `BLOCK` actions.
3. **AST-Driven Token Optimizer:** Compresses code prompts by 30% to 65% by intelligently pruning docstrings, comments, and non-essential function bodies while preserving type annotations and interfaces.
4. **Continuation Bridge Engine:** Analyzes conversation transcripts to extract the core objective, technology stack, architectural decisions, and pending tasks into a single standardized bridge prompt.
5. **Complete Data Sovereignty:** All event logging, security auditing, and settings persistence occur locally in SQLite with zero telemetry sent to third-party tracking services.

---

## ✨ Key Features

### 1. 🛡️ Security Guardrails & DLP Engine
* **16 Specialized Pattern Detectors:** Detects emails, phone numbers, IPv4 addresses, credit cards (Luhn-validated), Indian PAN cards, Aadhaar IDs, and US SSNs.
* **Credential & Secret Identification:** Detects OpenAI API keys, Anthropic keys, AWS Access Keys (`AKIA...`), GitHub personal access tokens (`ghp_...`), Google API keys, Slack tokens, JWTs, Bearer tokens, and database URLs (`postgres://`, `mongodb://`).
* **High-Entropy Secret Detection:** Evaluates Shannon entropy to catch randomized hex and base64 API secrets exceeding 3.8 bits per character.
* **Prompt Injection Defense:** Recognizes 9 distinct injection vectors including system prompt overrides, delimiter manipulation, and jailbreak commands.
* **Dynamic Risk Scoring:** Computes a composite risk score (0 to 100) and maps it to configurable thresholds (`ALLOW < 30`, `WARN 30–69`, `BLOCK ≥ 70`).

### 2. ⚡ AST Code Compression & Prompt Optimizer
* **Lossless Compression Mode:** Strips comments and docstrings from Python using the native `ast` module. Employs regex/state-machine cleaners for JavaScript, TypeScript, Java, C++, Go, and SQL.
* **Signatures Mode (AST Body Pruning):** Replaces function and method bodies longer than 5 lines with `pass  # [Body pruned for context efficiency]`, preserving imports, class signatures, and type annotations for architectural reviews.
* **Token Reduction Metrics:** Automatically calculates token counts using OpenAI's `tiktoken` (cl100k_base tokenizer), reporting exact tokens saved and percentage reduction.

### 3. 📦 Continuation Bridge Chat Transfer
* **Multi-Turn Scraping:** Automatically extracts conversation turns (User & Assistant) from ChatGPT (`[data-message-author-role]`), Claude (`.human-turn`, `.bot-turn`), and Gemini (`.user-query`, `.model-response`).
* **Structured Handoff Generation:** Generates a standardized Continuation Bridge Prompt containing:
  - Primary Objective & Scope
  - Technical Stack & Constraints
  - Key Architectural Decisions Made
  - Current Code Implementation State
  - Pending Next Steps
* **One-Click Handoff:** Instantly copies the bridge prompt to the clipboard and opens a fresh session in the target AI platform.

### 4. 🧩 Non-Intrusive Floating HUD
* **Shadow DOM Isolation:** Injects a floating status pill (`🛡️ ContextArmor Active`) into ChatGPT, Claude, and Gemini with isolated styles, preventing interference with host application layouts.
* **Live Pre-Submission Warnings:** If sensitive data is found during submission, intercepts the event and displays an interactive modal offering **"🛡️ Redact & Send"**, **"⚠️ Proceed Anyway"**, or **"✕ Cancel"**.
* **Hard Block Enforcement:** High-risk secrets and jailbreak injection prompts are blocked from dispatch, displaying a critical policy alert modal.
* **Editor Blur & Privacy Mode:** Allows users to blur the prompt editor when sharing screens or working in public spaces.

### 5. 📊 Real-Time Analytics Dashboard & Live Sandbox
* **Status Badges & Auto-Recovery:** Truthful live connection status (`● API Online :8000` / `● API Offline`) with automatic 15-second background recovery loops.
* **KPI Ribbon:** Tracks total prompts protected, cumulative tokens saved, PII items redacted, threats blocked, and average risk score.
* **Interactive Sandbox Studio:** Test and benchmark prompts live across Guardrails, Compression, and Transfer modules with built-in presets.
* **Audit Trail Log:** Filterable security audit log supporting date range filtering (Last 24 Hours, 7 Days, 30 Days, All Time) and module filters.

### 6. 🔒 Local Data Ownership & Zero Cloud Telemetry
* All security logs, settings, and token metrics are persisted locally in `backend/contextarmor.db`.
* Zero third-party telemetry, tracking pixels, or remote database synchronization.

---

## 🔄 How It Works

<img width="1224" height="1285" alt="image" src="https://github.com/user-attachments/assets/be2ff2bf-967e-46a3-9554-d8e85e615de0" />

---

## 🖥️ UI & Design System
ContextArmor AI utilizes a unified glassmorphic dark design system:
* **Typography:** Modern typography using [Inter](https://fonts.google.com/specimen/Inter) for UI elements and [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) for code, tokens, and placeholders.
* **Color Palette:** Curated deep indigo and navy gradient backdrop (`#0a0f24` → `#162459`), accented by high-contrast status colors:
  - 🟢 **Emerald (`#10B981`):** Protected / Allowed / Online
  - 🟡 **Amber (`#F59E0B`):** Warnings / Medium Risk / Checking
  - 🔴 **Crimson (`#EF4444`):** Blocked Threats / Critical Risk / Offline
* **Iconography:** Cohesive shield identity (`🛡️`) with vector SVG icons across HUD, popup, and dashboard.
* **Ambient Engine:** Interactive particle canvas engine embedded in the popup and dashboard views.

---

## 🏗️ System Architecture

### Component Architecture
```mermaid
flowchart TD
    subgraph Browser ["Chrome Browser Environment"]
        WebPage["Host LLM DOM\n(ChatGPT / Claude / Gemini)"]
        ContentScript["Content Script (content.js)\n• Capture Listeners\n• DOM Parser\n• Shadow DOM HUD"]
        Popup["Extension Popup (popup.html / js)\n• Live Status Badge\n• KPI Animation Cards\n• Quick Studio Tabs"]
        Dashboard["Full Dashboard (dashboard.html / js)\n• Multi-Host API Client\n• Donut & Bar Charts\n• Filterable Audit Table\n• Interactive Sandbox"]
        Worker["Background Service Worker (background.js)\n• API Proxy & Fallback\n• Host Permissions Manager\n• Toolbar Icon Badge State"]
    end

    subgraph BackendAPI ["ContextArmor FastAPI Backend (:8000)"]
        Router["FastAPI Application Core (main.py)"]
        GuardEngine["Guardrails Engine (guardrails_engine.py)\n• 16 Pattern Detectors\n• Shannon Entropy\n• Luhn Algorithm"]
        CompEngine["Compressor Engine (compressor_engine.py)\n• Python AST Transformer\n• Multilingual Comment Stripper\n• Tiktoken Tokenizer"]
        TransEngine["Transfer Engine (transfer_engine.py)\n• Transcript Heuristic Extractor\n• Continuation Bridge Synthesizer"]
        DBLayer["Database Persistence (database.py)\n• SQLite Connection Manager\n• Aggregations & Query Filters"]
    end

    subgraph Storage ["Local Persistence Layer"]
        DB[("SQLite Database\n(backend/contextarmor.db)")]
    end

    WebPage <-->|Inject & Intercept| ContentScript
    ContentScript -->|chrome.runtime.sendMessage| Worker
    Popup -->|chrome.runtime.sendMessage| Worker
    Dashboard -->|Direct HTTP fetch| Router
    Dashboard -.->|Fallback Proxy| Worker
    Worker -->|Async HTTP calls| Router

    Router --> GuardEngine
    Router --> CompEngine
    Router --> TransEngine
    Router --> DBLayer
    DBLayer <--> DB
```

### Data Model & Event Persistence
```mermaid
erDiagram
    EVENTS {
        int id PK
        string timestamp "ISO 8601 UTC"
        string module "SCAN | OPTIMIZE | TRANSFER"
        real risk_score "0.0 to 100.0"
        string action "ALLOW | WARN | BLOCK"
        string detected_entities "JSON Array of Findings"
        int tokens_saved "Number of tokens saved"
        int original_tokens "Input token count"
        int compressed_tokens "Output token count"
        string details "JSON Object Metadata"
    }

    SETTINGS {
        string key PK "app_config"
        string value "JSON Object of Policy Config"
    }
```

---

## 🛠️ Tech Stack

| Layer | Technology | Details |
| :--- | :--- | :--- |
| **Backend Framework** | [FastAPI 0.115+](https://fastapi.tiangolo.com/) | High-performance asynchronous API framework with automated OpenAPI docs |
| **ASGI Server** | [Uvicorn 0.30+](https://www.uvicorn.org/) | Lightning-fast ASGI production server with reload capabilities |
| **Data Serialization** | [Pydantic V2](https://docs.pydantic.dev/) | Strict request validation, thresholds typing, and error handling |
| **Database Layer** | [SQLite 3](https://www.sqlite.org/) | Zero-config, ACID-compliant local database storing event telemetry |
| **Code Parser** | Python `ast` | Native Abstract Syntax Tree analysis for docstring stripping and body pruning |
| **Tokenizer** | [tiktoken](https://github.com/openai/tiktoken) | Fast BPE tokenizer (`cl100k_base`) matching OpenAI, Anthropic, and Gemini ratios |
| **Browser Extension** | Chrome Manifest V3 | Service worker architecture, declarative host permissions, Shadow DOM HUD |
| **Styling** | Vanilla CSS3 | Glassmorphic design tokens, CSS variables, backdrop filters, zero npm bloat |
| **Typography** | [Inter](https://fonts.google.com/specimen/Inter) & [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) | Clean typography from Google Fonts |

---

## 📂 Project Structure

```
ContextArmor-ai/
├── README.md                                # Project documentation, architecture & guides
├── backend/                                 # FastAPI security and optimization backend
│   ├── main.py                              # FastAPI entrypoint, CORS configuration, API routes
│   ├── database.py                          # SQLite persistence layer, schema & analytics queries
│   ├── guardrails_engine.py                 # 16-pattern security scanner (PII, secrets, injection)
│   ├── compressor_engine.py                 # AST code compressor & state-machine comment stripper
│   ├── transfer_engine.py                   # Chat transcript parser & Continuation Bridge generator
│   ├── contextarmor.db                      # Local SQLite database storing live events & settings
│   ├── requirements.txt                     # Backend Python dependencies manifest
│   ├── test_dashboard_metrics.py            # Automated tests for analytics, zeros, and status model
│   ├── test_full_suite.py                   # 28-test full engine regression suite
│   ├── evaluate_targets.py                  # Benchmarking script for compression ratios
│   └── verify_pilot.py                      # Pilot validation script for quick diagnostics
└── extension/                               # Chrome Manifest V3 extension
    ├── manifest.json                        # Extension manifest V3 metadata, permissions, resources
    ├── background.js                        # Background service worker (API proxy, badge updates)
    ├── content.js                           # Content script: Shadow DOM HUD, prompt interception
    ├── popup.html                           # Extension toolbar popup interface
    ├── popup.js                             # Popup controller: animated counters, studio sandboxes
    ├── dashboard.html                       # Standalone security dashboard & analytics console
    ├── dashboard.js                         # Dashboard controller: multi-host client, charts & filters
    ├── styles.css                           # Glassmorphic dark design system and animations
    └── icons/                               # Chrome extension icons (16px, 32px, 48px, 128px)
        ├── icon16.png                       # 16x16 shield toolbar icon
        ├── icon32.png                       # 32x32 high-DPI Windows toolbar shield icon
        ├── icon48.png                       # 48x48 extensions management icon
        └── icon128.png                      # 128x128 Chrome Web Store icon
```

---

## 🚀 Getting Started

Follow these steps to set up and run ContextArmor AI on your machine.

### Prerequisites
* **Python:** 3.12 or newer.
* **Browser:** Google Chrome (or any Chromium browser like Brave, Edge).
* **Git:** Installed locally.

---

### Step 1: Clone the Repository
```bash
git clone https://github.com/priyanshu-205/ContextArmor-ai.git
cd ContextArmor-ai
```

---

### Step 2: Start the FastAPI Backend

#### On Windows (PowerShell):
```powershell
# Navigate to the backend directory
cd backend

# Create and activate a virtual environment
python -m venv .venv
.venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Start the server
python main.py
```

#### On Linux / macOS:
```bash
# Navigate to the backend directory
cd backend

# Create and activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start the server
python3 main.py
```

The backend server will start at:
* **API Root:** [http://127.0.0.1:8000](http://127.0.0.1:8000)
* **Interactive Swagger Docs:** [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
* **Alternative ReDoc:** [http://127.0.0.1:8000/redoc](http://127.0.0.1:8000/redoc)

---

### Step 3: Load the Chrome Extension
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the `extension/` directory from this project (`ContextArmor-ai/extension`).
5. The **🛡️ ContextArmor AI** icon will appear in your Chrome toolbar.
6. *(Optional)* Pin the extension to your toolbar for instant one-click access.

---

### Step 4: Verify the Connection
1. Click the ContextArmor AI icon in your Chrome toolbar.
2. The popup will open and the status badge will display `:8000 Online` with a pulsing green indicator.
3. Click **"Open Security Dashboard"** to view real-time metrics, charts, and the interactive sandbox.

---

## 🔑 Environment & Policy Configuration

Guardrails policies and thresholds are persisted in SQLite and can be configured through the **Settings Modal (⚙️)** in the dashboard or via `POST /api/settings`:

| Parameter | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `warn_threshold` | `int` | `30` | Risk score threshold to trigger pre-submission warning modals. |
| `block_threshold` | `int` | `70` | Risk score threshold to block submission completely. |
| `enabled_rules` | `list[str]` | `["PII", "SECRET", "PROMPT_INJECTION"]` | Active inspection categories. |
| `restricted_websites` | `list[str]` | `[]` | List of domain patterns where prompts are completely prohibited. |
| `auto_redact_on_send` | `bool` | `false` | When true, automatically sanitizes PII before sending without prompting. |
| `fail_closed` | `bool` | `false` | When true, blocks submissions if the backend service is offline. |

---

## 📡 API Routes Reference

### Core Endpoints

| Method | Endpoint | Handler | Description | Request Body | Response Payload |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `GET` | `/` | `root` | Service discovery and health check | None | `{"status": "running", "service": "...", "version": "1.0.0"}` |
| `POST` | `/api/scan` | `scan` | Security scan for PII, secrets, and injections | `{"text": str, "log_event": bool}` | `{"findings": list, "risk_score": float, "action": str, "sanitized_text": str}` |
| `POST` | `/api/optimize` | `optimize` | AST compression & code prompt optimizer | `{"text": str, "mode": "lossless" \| "signatures"}` | `{"optimized_prompt": str, "tokens_saved": int, "reduction_percentage": float}` |
| `POST` | `/api/transfer` | `transfer` | Chat transcript parser & bridge generator | `{"messages": list[{"role": str, "content": str}]}` | `{"bridge_prompt": str, "original_tokens": int, "bridge_tokens": int, "compression_ratio": float}` |
| `GET` | `/api/analytics` | `analytics` | Aggregated metrics, categories & audit logs | Query params: `?days=7&module=SCAN` | `{"total_scans": int, "threats_blocked": int, "pii_redacted_count": int, ...}` |
| `GET` | `/api/settings` | `get_settings` | Retrieve active policy configuration | None | Active settings JSON |
| `POST` | `/api/settings` | `update_settings`| Update thresholds and rule toggles | Settings payload | `{"status": "success", "settings": dict}` |
| `POST` | `/api/reset-demo` | `reset_demo` | Clear database and reseed demo data | None | `{"status": "success", "message": "..."}` |

---

## 💡 Example Workflow

Here is an end-to-end scenario demonstrating ContextArmor AI in action:

1. **Active LLM Interception on ChatGPT:**
   * Open [ChatGPT](https://chatgpt.com/).
   * Notice the floating `🛡️ ContextArmor Active` pill in the bottom-right corner.
   * Paste a prompt with a mock credential:
     ```text
     Please review this script. My AWS access key is AKIAIOSFODNN7EXAMPLE and secret is sk-proj-1234567890abcdef.
     ```
   * Press **Enter** or click **Send**.
   * ContextArmor intercepts the event before submission:
     - Detects the critical `AWS_KEY` and `OPENAI_KEY` findings.
     - Displays the **🚨 Submission Blocked by Policy** modal with high-risk red badges.
     - Prevents credentials from reaching OpenAI's servers.

2. **Auto-Redaction & Submission:**
   * Enter a prompt containing personal details:
     ```text
     Send invoices to john.doe@acme.corp or call +1 (555) 019-2834.
     ```
   * The warning modal appears: **⚠️ Security Warning: Sensitive Data Detected**.
   * Click **"🛡️ Redact & Send"**.
   * The text in ChatGPT's editor is sanitized to:
     ```text
     Send invoices to [REDACTED_EMAIL] or call [REDACTED_PHONE].
     ```
   * The sanitized prompt submits cleanly, and the event is recorded in your local audit log.

3. **Lossless Code Optimization:**
   * Open the ContextArmor extension popup and navigate to **Compress**.
   * Paste 100 lines of verbose Python code with docstrings and comments.
   * Select **Lossless Mode** and click **Optimize Prompt**.
   * Token consumption drops by ~40% while preserving runtime code execution.

4. **Multi-Turn Chat Transfer:**
   * On a lengthy debugging conversation on ChatGPT, click **Transfer Chat** on the floating HUD.
   * ContextArmor scrapes the conversation history, compresses context, and creates a structured **Continuation Bridge Prompt**.
   * Click **🚀 Open Fresh Chat** to immediately open Claude or Gemini and paste the bridge prompt to continue seamlessly.

---

## 🧪 Testing & Verification

ContextArmor AI includes comprehensive automated testing covering both backend engines and the analytics/status data model.

### 1. Run Dashboard Metrics & Status Tests
Verifies zero-valued database integrity, live event counting, typing duplicate prevention, date filtering, and health endpoints:
```powershell
python backend/test_dashboard_metrics.py
```
**Expected Output:**
```text
Ran 7 tests in 0.150s
OK
```

### 2. Run Full Engine Regression Suite
Verifies 28 test cases across regex scanners, Shannon entropy, Luhn validation, AST compressors, and transfer bridges:
```powershell
python backend/test_full_suite.py
```
**Expected Output:**
```text
Ran 28 tests in 0.068s
OK
```

### 3. Run Live Endpoint Verification (PowerShell)
```powershell
# Health check probe
Invoke-RestMethod -Uri "http://127.0.0.1:8000/" -Method Get

# Real-time analytics query
Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/analytics" -Method Get
```

---

## 📋 Limitations & Future Roadmap

To keep technical expectations clear, here is a distinction between current capabilities and planned future milestones:

### Current Capabilities
- Client-side pre-submission DOM interception across ChatGPT, Claude, and Gemini.
- 16-rule security scanner for PII, API tokens, cryptographic keys, and prompt injections.
- Shannon entropy calculator for detecting randomized high-entropy secrets.
- Python AST docstring removal and body signature pruning.
- Continuation Bridge Prompt generation for cross-model chat handoffs.
- Local SQLite audit log with zero external telemetry.
- Dynamic connection status model with automatic background recovery.

### Proposed Future Improvements
- [ ] **Firefox & Safari Extension Ports:** Migrate MV3 background service worker to support Firefox WebExtensions and Safari app extensions.
- [ ] **Local Small Language Model (SLM) Classifier:** Integrate on-device WebAssembly or Ollama models for contextual semantic intent analysis.
- [ ] **Custom Enterprise Regex Editor:** Allow security administrators to define custom proprietary regex rules directly through the dashboard UI.
- [ ] **CSV / PDF Compliance Report Export:** Enable one-click compliance audit export (ISO 27001 / SOC 2) from the analytics audit table.
- [ ] **Encrypted SQLite Database:** Support SQLCipher for encrypted-at-rest local event storage.

---

## 🤝 Contributing
Contributions, feedback, and security improvements are welcome!

1. **Fork the repository** on GitHub.
2. **Create a feature branch:**
   ```bash
   git checkout -b feature/enhancement-name
   ```
3. **Commit your changes:**
   ```bash
   git commit -m "feat: add support for new secret detector"
   ```
4. **Push to your branch:**
   ```bash
   git push origin feature/enhancement-name
   ```
5. **Open a Pull Request** explaining your changes and test coverage.

---

## 👤 Author & Acknowledgements
* **Author & Lead Engineer:** Shamit Bundela ([@Shamit248](https://github.com/Shamit248))
* **Repository:** [https://github.com/priyanshu-205/ContextArmor-ai](https://github.com/priyanshu-205/ContextArmor-ai)
* **Built With:** [FastAPI](https://fastapi.tiangolo.com/), [tiktoken](https://github.com/openai/tiktoken), [Uvicorn](https://www.uvicorn.org/), and Chrome Extensions MV3.

---

## 📄 License
This project is open-source and provided under the project author's repository guidelines. Please review the repository settings or contact the author before commercial redistribution.
