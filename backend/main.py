"""
ContextArmor AI - FastAPI Backend
Production-grade security guardrails, prompt optimization, and chat transfer API.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Literal
import uvicorn
import json
from datetime import datetime

from database import (
    init_db, log_event, get_analytics, seed_demo_data, reset_demo,
    get_settings, save_settings
)
from guardrails_engine import GuardrailsEngine
from compressor_engine import CompressorEngine
from transfer_engine import TransferEngine


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="ContextArmor AI API",
    description="Intelligent AI prompt optimization, security, and context transfer",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup() -> None:
    """Initialize the database and seed demo data if the DB is empty."""
    init_db()
    analytics = get_analytics()
    if analytics.get("total_scans", 0) == 0:
        seed_demo_data()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ScanRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    warn_threshold: Optional[int] = None
    block_threshold: Optional[int] = None
    enabled_rules: Optional[List[str]] = None


class OptimizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    mode: Literal["lossless", "signatures"] = "lossless"
    api_key: Optional[str] = None
    provider: Optional[str] = None  # "openai", "anthropic", "gemini", "ollama"


class Message(BaseModel):
    role: Literal["user", "assistant", "system", "developer"]
    content: str = Field(min_length=1, max_length=50_000)


class TransferRequest(BaseModel):
    messages: Optional[List[Message]] = Field(default=None, max_length=500)
    raw_transcript: Optional[str] = Field(default=None, max_length=200_000)


class SettingsRequest(BaseModel):
    warn_threshold: Optional[int] = Field(default=30, ge=1, le=100)
    block_threshold: Optional[int] = Field(default=70, ge=1, le=100)
    enabled_rules: Optional[List[str]] = None
    restricted_websites: Optional[List[str]] = None
    auto_redact_on_send: Optional[bool] = False
    fail_closed: Optional[bool] = False


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/scan")
async def scan(request: ScanRequest) -> dict:
    """
    Scan text for PII, secrets, and prompt-injection patterns.
    Returns risk score, action (ALLOW/WARN/BLOCK), findings, and sanitized text.
    """
    settings = get_settings()
    warn_th = request.warn_threshold if request.warn_threshold is not None else settings.get("warn_threshold", 30)
    block_th = request.block_threshold if request.block_threshold is not None else settings.get("block_threshold", 70)
    rules = request.enabled_rules if request.enabled_rules is not None else settings.get("enabled_rules")

    engine = GuardrailsEngine(
        warn_threshold=warn_th,
        block_threshold=block_th,
        enabled_rules=rules,
    )
    result = engine.scan(request.text)

    log_event(
        module="SCAN",
        risk_score=result["risk_score"],
        action=result["action"],
        detected_entities=[f["type"] for f in result["findings"]],
        tokens_saved=0,
        original_tokens=0,
        compressed_tokens=0,
        details_dict={"findings_count": len(result["findings"])},
    )

    return result


@app.post("/api/optimize")
async def optimize(request: OptimizeRequest) -> dict:
    """
    Compress and optimize a prompt.
    Removes comments/docstrings (lossless) or prunes bodies (signatures mode).
    """
    engine = CompressorEngine()
    result = engine.compress_and_optimize(
        request.text,
        mode=request.mode,
        api_key=request.api_key,
        provider=request.provider,
    )

    log_event(
        module="OPTIMIZE",
        risk_score=0,
        action="ALLOW",
        detected_entities=[r["type"] for r in result.get("redactions_applied", [])],
        tokens_saved=result["tokens_saved"],
        original_tokens=result["original_tokens"],
        compressed_tokens=result["compressed_tokens"],
        details_dict={
            "mode": result["mode"],
            "reduction_pct": result["reduction_percentage"],
        },
    )

    return result


@app.post("/api/transfer")
async def transfer(request: TransferRequest) -> dict:
    """
    Generate a compact bridge prompt from a conversation transcript.
    Enables seamless context handoff between AI sessions.
    """
    msgs_list: Optional[list] = None
    if request.messages is not None:
        msgs_list = [m.dict() for m in request.messages]

    engine = TransferEngine()
    result = engine.transfer(
        messages=msgs_list,
        raw_transcript=request.raw_transcript,
    )

    log_event(
        module="TRANSFER",
        risk_score=0,
        action="ALLOW",
        detected_entities=[],
        tokens_saved=result["tokens_saved"],
        original_tokens=result["original_tokens"],
        compressed_tokens=result["bridge_tokens"],
        details_dict={"compression_ratio": result["compression_ratio"]},
    )

    return result


@app.get("/api/analytics")
async def analytics(
    module: Optional[str] = None,
    action: Optional[str] = None,
    days: Optional[int] = None,
) -> dict:
    """
    Return aggregated usage statistics and recent events with optional filters.
    """
    return get_analytics(module=module, action=action, days=days)


@app.get("/api/settings")
async def get_settings_endpoint() -> dict:
    """Get current guardrails and extension policy settings."""
    return get_settings()


@app.post("/api/settings")
async def update_settings_endpoint(request: SettingsRequest) -> dict:
    """Update guardrails thresholds, enabled rules, and website restrictions."""
    updated = save_settings(request.dict(exclude_none=True))
    return {"status": "success", "settings": updated}


@app.post("/api/reset-demo")
async def reset_demo_endpoint() -> dict:
    """
    Wipe all events and re-seed the database with baseline demo data.
    """
    reset_demo()
    return {"status": "success", "message": "Demo data reset successfully"}


@app.get("/")
async def root() -> dict:
    """Health-check / service discovery endpoint."""
    return {
        "status": "running",
        "service": "ContextArmor AI API",
        "version": "1.0.0",
        "endpoints": [
            "/api/scan",
            "/api/optimize",
            "/api/transfer",
            "/api/analytics",
            "/api/reset-demo",
        ],
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
