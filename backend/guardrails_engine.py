"""
guardrails_engine.py — Production-grade security scanner for ContextArmor-ai.

Detects PII, secrets, and prompt-injection patterns using only Python stdlib.
No third-party dependencies required.
"""

import re
from collections import Counter
from math import log2


# ---------------------------------------------------------------------------
# Severity → risk weight mapping
# ---------------------------------------------------------------------------

_SEVERITY_WEIGHT: dict[str, int] = {
    "CRITICAL": 50,
    "HIGH": 30,
    "MEDIUM": 15,
    "LOW": 5,
}

# ---------------------------------------------------------------------------
# Luhn algorithm (credit-card validation)
# ---------------------------------------------------------------------------

def _luhn_valid(digits: str) -> bool:
    """Return True if the digit string passes the Luhn check."""
    total = 0
    reversed_digits = digits[::-1]
    for i, ch in enumerate(reversed_digits):
        n = int(ch)
        if i % 2 == 1:          # every second digit (from the right, 0-indexed)
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


# ---------------------------------------------------------------------------
# Shannon entropy
# ---------------------------------------------------------------------------

def _shannon_entropy(s: str) -> float:
    """Return Shannon entropy in bits per character."""
    if not s:
        return 0.0
    freq = Counter(s)
    length = len(s)
    return -sum((c / length) * log2(c / length) for c in freq.values())


# ---------------------------------------------------------------------------
# GuardrailsEngine
# ---------------------------------------------------------------------------

class GuardrailsEngine:
    """
    Scan text for PII, secrets, and prompt-injection patterns.

    Usage:
        engine = GuardrailsEngine()
        result = engine.scan("Send to alice@example.com, card 4111111111111111")
    """

    # -----------------------------------------------------------------------
    # Detector definitions
    # Each entry is a tuple:
    #   (type_name, compiled_pattern_or_None, placeholder, severity, category)
    #
    # category ∈ {"pii", "secret", "injection", "special"}
    # "special" means custom handling is required (credit card, high-entropy, injection).
    # -----------------------------------------------------------------------

    _DETECTORS = [
        # --- Critical Secrets & Structured URLs (Must run BEFORE general email/phone regex) ---
        # 1. DATABASE_URL (must precede EMAIL to prevent matching password@host as an email)
        (
            "DATABASE_URL",
            re.compile(
                r'\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[A-Za-z0-9_\-]+:[^\s@]+@[A-Za-z0-9.\-]+(?::\d+)?\/[A-Za-z0-9_\-]+',
                re.IGNORECASE,
            ),
            "[REDACTED_DATABASE_URL]",
            "CRITICAL",
            "secret",
        ),
        # 2. PRIVATE_KEY
        (
            "PRIVATE_KEY",
            re.compile(r'-----BEGIN [A-Z ]+ PRIVATE KEY-----'),
            "[REDACTED_PRIVATE_KEY]",
            "CRITICAL",
            "secret",
        ),
        # 3. BEARER_TOKEN
        (
            "BEARER_TOKEN",
            re.compile(r'\bBearer\s+[A-Za-z0-9_\-\.]{20,}\b', re.IGNORECASE),
            "[REDACTED_BEARER_TOKEN]",
            "CRITICAL",
            "secret",
        ),
        # 4. ANTHROPIC_KEY
        (
            "ANTHROPIC_KEY",
            re.compile(r'sk-ant-[a-zA-Z0-9_\-]{20,}'),
            "[REDACTED_ANTHROPIC_KEY]",
            "CRITICAL",
            "secret",
        ),
        # 5. OPENAI_KEY
        (
            "OPENAI_KEY",
            re.compile(r'sk-[a-zA-Z0-9_\-]{20,}'),
            "[REDACTED_OPENAI_KEY]",
            "CRITICAL",
            "secret",
        ),
        # 6. AWS_ACCESS_KEY
        (
            "AWS_ACCESS_KEY",
            re.compile(r'AKIA[0-9A-Z]{16}'),
            "[REDACTED_AWS_KEY]",
            "CRITICAL",
            "secret",
        ),
        # 7. GITHUB_TOKEN
        (
            "GITHUB_TOKEN",
            re.compile(r'gh[pousr]_[A-Za-z0-9_]{20,}'),
            "[REDACTED_GITHUB_TOKEN]",
            "CRITICAL",
            "secret",
        ),
        # 8. SLACK_TOKEN
        (
            "SLACK_TOKEN",
            re.compile(r'xox[baprs]-[0-9a-zA-Z\-]+'),
            "[REDACTED_SLACK_TOKEN]",
            "HIGH",
            "secret",
        ),
        # 9. GOOGLE_API_KEY
        (
            "GOOGLE_API_KEY",
            re.compile(r'AIza[0-9A-Za-z\-_]{35}'),
            "[REDACTED_GOOGLE_KEY]",
            "CRITICAL",
            "secret",
        ),
        # 10. JWT_TOKEN
        (
            "JWT_TOKEN",
            re.compile(r'eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+'),
            "[REDACTED_JWT]",
            "HIGH",
            "secret",
        ),
        # 11. HIGH_ENTROPY_SECRET (passwords, tokens, API keys)
        (
            "HIGH_ENTROPY_SECRET",
            re.compile(
                r'(?:api[_\-]?key|password|secret|token|passwd|pwd|auth|credential)'
                r'(?:\s+(?:for|is|to|value|of)?\s+[a-zA-Z0-9_\-]+)*'
                r'\s*[=:]\s*(?:["\']([^"\']{6,})["\']|([^\s"\';]{6,}))',
                re.IGNORECASE,
            ),
            "[REDACTED_SECRET]",
            "CRITICAL",
            "secret",
        ),

        # --- High Financial and Government Identifiers ---
        # 12. CREDIT_CARD (requires Luhn check) — handled specially
        (
            "CREDIT_CARD",
            re.compile(r'\b(?:\d[ \-]?){13,19}\b'),
            "[REDACTED_CREDIT_CARD]",
            "HIGH",
            "pii",
        ),
        # 13. PAN_CARD
        (
            "PAN_CARD",
            re.compile(r'\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b'),
            "[REDACTED_PAN]",
            "HIGH",
            "pii",
        ),
        # 14. AADHAAR_ID (Aadhaar-style Indian identifier)
        (
            "AADHAAR_ID",
            re.compile(r'\b[2-9][0-9]{3}\s?[0-9]{4}\s?[0-9]{4}\b'),
            "[REDACTED_AADHAAR]",
            "HIGH",
            "pii",
        ),

        # --- General Contact & Network PII ---
        # 15. EMAIL
        (
            "EMAIL",
            re.compile(r'\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b'),
            "[REDACTED_EMAIL]",
            "MEDIUM",
            "pii",
        ),
        # 16. PHONE (US + Indian)
        (
            "PHONE",
            re.compile(
                r'(?:'
                r'\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}'       # US: (123) 456-7890
                r'|\b[6-9]\d{4}[\s\-]?\d{5}\b'              # Indian 10-digit with optional space
                r'|\+91[\s\-]?[6-9]\d{4}[\s\-]?\d{5}'       # Indian +91 prefix with optional space
                r'|\+91[\s\-]?\d{10}'                       # Indian +91 prefix
                r')'
            ),
            "[REDACTED_PHONE]",
            "MEDIUM",
            "pii",
        ),
        # 17. IPV4_ADDRESS
        (
            "IPV4_ADDRESS",
            re.compile(
                r'\b'
                r'(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.'
                r'(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.'
                r'(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.'
                r'(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)'
                r'\b'
            ),
            "[REDACTED_IPV4]",
            "MEDIUM",
            "pii",
        ),

        # --- Threats ---
        # 18. PROMPT_INJECTION — handled specially (multiple sub-patterns)
        (
            "PROMPT_INJECTION",
            None,
            "[REDACTED_INJECTION]",
            "CRITICAL",
            "injection",
        ),
    ]

    # Prompt-injection sub-patterns
    _INJECTION_PATTERNS = [
        re.compile(r'ignore\s+(?:all\s+|previous\s+|prior\s+)*(?:instructions|directives|rules|constraints)', re.IGNORECASE),
        re.compile(
            r'disregard\s+(?:the\s+|your\s+|all\s+|prior\s+|earlier\s+|safety\s+|previous\s+)*(?:system\s+|developer\s+)?(?:prompt|instructions|directives|rules)',
            re.IGNORECASE,
        ),
        re.compile(
            r'(?:you are now in|you are now|act as)\s+(?:an?\s+)?(?:developer|dev|jailbreak|DAN|unlocked AI)\b',
            re.IGNORECASE,
        ),
        re.compile(
            r'(?:print|output|reveal|exfiltrate|leak|dump)\s+(?:the\s+|your\s+|all\s+|developer\s+|system\s+)*(?:exact\s+|initial\s+|system\s+)?(?:prompt|instructions|directives|filters)',
            re.IGNORECASE,
        ),
        re.compile(r'\b(?:attempt to\s+|how to\s+)?exfiltrate\s+(?:the\s+|all\s+|system\s+|prompt|data|keys|passwords)', re.IGNORECASE),
        re.compile(r'\bsystem\s+prompt\s+exfiltration\b', re.IGNORECASE),
        re.compile(r'\bsystem\s+(?:message|directive|prompt)\s+reset\b', re.IGNORECASE),
        re.compile(r'\boverride\s+(?:previous\s+|prior\s+|all\s+|safety\s+)*(?:instructions|policy|rules|directives)', re.IGNORECASE),
        re.compile(r'\b(?:no longer bound by|forget all)\s+(?:safety\s+|previous\s+)?(?:guidelines|restrictions|rules|boundaries)', re.IGNORECASE),
        re.compile(r'\bwithout\s+(?:any\s+)?(?:ethical\s+|safety\s+)?(?:considerations|boundaries|restrictions|filters)', re.IGNORECASE),
        # Empty markdown link or malicious tracker
        re.compile(r'\[\s*\]\(https?://[^\)]+\)'),
        re.compile(r'!\[\s*\]\(https?://[^\)]+\)'),
        re.compile(r'!\[[^\]]*\]\(https?://[^\)]*(?:token|secret|leak|exfil|callback|webhook)[^\)]*\)', re.IGNORECASE),
        # Inline system override comment
        re.compile(r'//\s*SYSTEM\s*:'),
    ]

    # Defensive and research context patterns to prevent false positives
    _DEFENSIVE_RESEARCH_PATTERNS = [
        re.compile(r'\b(?:how\s+(?:to\s+|can\s+we\s+)?(?:defend|prevent|mitigate|stop)|defense\s+against|mitigat(?:e|ion)|protect\s+against|detecting|security\s+research|vulnerability\s+analysis|example\s+of|safeguard|in\s+this\s+paper|cybersecurity\s+course|concept\s+of)\b', re.IGNORECASE),
        re.compile(r'["\'].*?(?:ignore\s+all|disregard|jailbreak|system\s+prompt).*?["\']', re.IGNORECASE),
    ]

    def __init__(
        self,
        warn_threshold: float = 30.0,
        block_threshold: float = 70.0,
        enabled_rules: list = None,
    ):
        self.warn_threshold = warn_threshold
        self.block_threshold = block_threshold
        self.enabled_rules = enabled_rules

    # -----------------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------------

    def scan(
        self,
        text: str,
        warn_threshold: float = None,
        block_threshold: float = None,
        enabled_rules: dict | list = None,
    ) -> dict:
        """
        Scan *text* and return a result dict with findings, risk score, action,
        sanitized text, and category counts.
        Supports dynamic policy thresholds and rule enable/disable toggles.
        """
        w_th = self.warn_threshold if warn_threshold is None else warn_threshold
        b_th = self.block_threshold if block_threshold is None else block_threshold
        e_rules = self.enabled_rules if enabled_rules is None else enabled_rules

        findings: list[dict] = []
        sanitized_text: str = text
        risk_accumulator: int = 0
        pii_count: int = 0
        secrets_count: int = 0
        injection_count: int = 0

        for (
            type_name,
            pattern,
            placeholder,
            severity,
            category,
        ) in self._DETECTORS:

            if e_rules:
                if isinstance(e_rules, dict) and e_rules.get(type_name) is False:
                    continue
                elif isinstance(e_rules, list):
                    # Category level filter: e.g. ["PII", "SECRET", "PROMPT_INJECTION"]
                    cat_map = {"pii": "PII", "secret": "SECRET", "injection": "PROMPT_INJECTION"}
                    rule_cat = cat_map.get(category)
                    if rule_cat and rule_cat not in e_rules and type_name not in e_rules:
                        continue

            if type_name == "CREDIT_CARD":
                new_findings, sanitized_text = self._run_credit_card(
                    sanitized_text, placeholder, severity
                )
            elif type_name == "HIGH_ENTROPY_SECRET":
                new_findings, sanitized_text = self._run_high_entropy(
                    sanitized_text, pattern, placeholder, severity
                )
            elif type_name == "PROMPT_INJECTION":
                new_findings, sanitized_text = self._run_injection(
                    sanitized_text, placeholder, severity
                )
            else:
                new_findings, sanitized_text = self._run_simple(
                    sanitized_text, pattern, type_name, placeholder, severity
                )

            findings.extend(new_findings)
            weight = _SEVERITY_WEIGHT[severity]
            risk_accumulator += weight * len(new_findings)

            if category == "pii":
                pii_count += len(new_findings)
            elif category == "secret":
                secrets_count += len(new_findings)
            elif category == "injection":
                injection_count += len(new_findings)

        risk_score = float(min(100, risk_accumulator))

        if risk_score >= b_th:
            action = "BLOCK"
        elif risk_score >= w_th:
            action = "WARN"
        else:
            action = "ALLOW"

        return {
            "findings": findings,
            "risk_score": risk_score,
            "action": action,
            "sanitized_text": sanitized_text,
            "pii_count": pii_count,
            "secrets_count": secrets_count,
            "injection_count": injection_count,
        }

    # -----------------------------------------------------------------------
    # Internal runners
    # -----------------------------------------------------------------------

    @staticmethod
    def _run_simple(
        text: str,
        pattern: re.Pattern,
        type_name: str,
        placeholder: str,
        severity: str,
    ) -> tuple[list[dict], str]:
        """Generic regex scan-and-replace."""
        findings: list[dict] = []
        offset = 0  # tracks shift in indices as we replace
        result_text = text

        for m in pattern.finditer(text):
            start = m.start() + offset
            end = m.end() + offset
            matched = result_text[start:end]

            findings.append(
                {
                    "type": type_name,
                    "severity": severity,
                    "matched_text": m.group(0),
                    "redacted_placeholder": placeholder,
                    "start_idx": start,
                    "end_idx": end,
                }
            )

            result_text = result_text[:start] + placeholder + result_text[end:]
            offset += len(placeholder) - (m.end() - m.start())

        return findings, result_text

    @staticmethod
    def _run_credit_card(
        text: str,
        placeholder: str,
        severity: str,
    ) -> tuple[list[dict], str]:
        """Credit card detector with Luhn validation."""
        pattern = re.compile(r'\b(?:\d[ \-]?){13,19}\b')
        findings: list[dict] = []
        offset = 0
        result_text = text

        for m in pattern.finditer(text):
            raw = m.group(0)
            digits = re.sub(r'\D', '', raw)
            if not _luhn_valid(digits):
                continue  # skip non-cards

            start = m.start() + offset
            end = m.end() + offset

            findings.append(
                {
                    "type": "CREDIT_CARD",
                    "severity": severity,
                    "matched_text": raw,
                    "redacted_placeholder": placeholder,
                    "start_idx": start,
                    "end_idx": end,
                }
            )

            result_text = result_text[:start] + placeholder + result_text[end:]
            offset += len(placeholder) - (m.end() - m.start())

        return findings, result_text

    @staticmethod
    def _run_high_entropy(
        text: str,
        pattern: re.Pattern,
        placeholder: str,
        severity: str,
    ) -> tuple[list[dict], str]:
        """
        High-entropy secret and credential detector.
        Finds variable assignments whose values have high entropy or clear credential markers.
        """
        findings: list[dict] = []
        offset = 0
        result_text = text

        for m in pattern.finditer(text):
            secret_value = m.group(1) or m.group(2)
            if not secret_value:
                continue
            entropy = _shannon_entropy(secret_value)
            # Accept if entropy > 3.2, length >= 14, or mixed alphanumeric with special chars
            has_variety = bool(re.search(r'[A-Za-z]', secret_value) and re.search(r'[0-9]', secret_value))
            if entropy <= 3.2 and not (len(secret_value) >= 14 and has_variety):
                continue

            # Replace the entire match (not just the captured group)
            start = m.start() + offset
            end = m.end() + offset

            findings.append(
                {
                    "type": "HIGH_ENTROPY_SECRET",
                    "severity": severity,
                    "matched_text": m.group(0),
                    "redacted_placeholder": placeholder,
                    "start_idx": start,
                    "end_idx": end,
                }
            )

            result_text = result_text[:start] + placeholder + result_text[end:]
            offset += len(placeholder) - (m.end() - m.start())

        return findings, result_text

    def _run_injection(
        self,
        text: str,
        placeholder: str,
        severity: str,
    ) -> tuple[list[dict], str]:
        """
        Prompt-injection detector with false-positive prevention for educational/research context.
        """
        findings: list[dict] = []
        result_text = text

        # Check if the surrounding text has defensive framing
        has_defensive_context = any(
            p.search(text) for p in self._DEFENSIVE_RESEARCH_PATTERNS
        )
        if has_defensive_context:
            return [], text

        for sub_pattern in self._INJECTION_PATTERNS:
            offset = 0
            scan_base = result_text

            for m in sub_pattern.finditer(scan_base):
                start = m.start() + offset
                end = m.end() + offset
                matched_snippet = m.group(0)

                # Context-aware check: check if quoted or in defensive context
                is_quoted = False
                if start > 0 and end < len(result_text):
                    prev_char = result_text[max(0, start - 1)]
                    next_char = result_text[min(len(result_text) - 1, end)]
                    if (prev_char in ('"', "'", '`') and next_char in ('"', "'", '`')) or has_defensive_context:
                        is_quoted = True

                assigned_severity = "LOW" if (has_defensive_context and is_quoted) else severity

                findings.append(
                    {
                        "type": "PROMPT_INJECTION",
                        "severity": assigned_severity,
                        "matched_text": matched_snippet,
                        "redacted_placeholder": placeholder,
                        "start_idx": start,
                        "end_idx": end,
                        "is_defensive_example": bool(has_defensive_context and is_quoted),
                    }
                )

                result_text = result_text[:start] + placeholder + result_text[end:]
                offset += len(placeholder) - (m.end() - m.start())

        return findings, result_text
