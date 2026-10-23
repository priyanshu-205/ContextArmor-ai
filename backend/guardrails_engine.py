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
        # 1. EMAIL
        (
            "EMAIL",
            re.compile(r'\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b'),
            "[REDACTED_EMAIL]",
            "MEDIUM",
            "pii",
        ),
        # 2. PHONE (US + Indian)
        (
            "PHONE",
            re.compile(
                r'(?:'
                r'\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}'   # US: (123) 456-7890
                r'|\b[6-9]\d{9}\b'                          # Indian 10-digit
                r'|\+91[\s\-]?\d{10}'                       # Indian +91 prefix
                r')'
            ),
            "[REDACTED_PHONE]",
            "MEDIUM",
            "pii",
        ),
        # 3. IPV4
        (
            "IPV4",
            re.compile(
                r'\b'
                r'(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.'
                r'(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.'
                r'(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.'
                r'(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)'
                r'\b'
            ),
            "[REDACTED_IP]",
            "MEDIUM",
            "pii",
        ),
        # 4. CREDIT_CARD (requires Luhn check) — handled specially
        (
            "CREDIT_CARD",
            re.compile(r'\b(?:\d[ \-]?){13,19}\b'),
            "[REDACTED_CREDIT_CARD]",
            "HIGH",
            "pii",          # Luhn check performed in _run_credit_card()
        ),
        # 5. PAN_CARD
        (
            "PAN_CARD",
            re.compile(r'\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b'),
            "[REDACTED_PAN]",
            "HIGH",
            "pii",
        ),
        # 6. GOVT_ID (Aadhaar-style)
        (
            "GOVT_ID",
            re.compile(r'\b[2-9][0-9]{3}\s?[0-9]{4}\s?[0-9]{4}\b'),
            "[REDACTED_GOVT_ID]",
            "HIGH",
            "pii",
        ),
        # 7. OPENAI_KEY
        (
            "OPENAI_KEY",
            re.compile(r'sk-[a-zA-Z0-9_\-]{20,}'),
            "[REDACTED_OPENAI_KEY]",
            "CRITICAL",
            "secret",
        ),
        # 8. ANTHROPIC_KEY  (must come before OPENAI_KEY match so it gets
        #    its own placeholder; ordering is fine because ANTHROPIC prefix
        #    is longer and already consumed when we get here)
        (
            "ANTHROPIC_KEY",
            re.compile(r'sk-ant-[a-zA-Z0-9_\-]{20,}'),
            "[REDACTED_ANTHROPIC_KEY]",
            "CRITICAL",
            "secret",
        ),
        # 9. AWS_KEY
        (
            "AWS_KEY",
            re.compile(r'AKIA[0-9A-Z]{16}'),
            "[REDACTED_AWS_KEY]",
            "CRITICAL",
            "secret",
        ),
        # 10. GITHUB_TOKEN
        (
            "GITHUB_TOKEN",
            re.compile(r'gh[pousr]_[A-Za-z0-9_]{20,}'),
            "[REDACTED_GITHUB_TOKEN]",
            "CRITICAL",
            "secret",
        ),
        # 11. SLACK_TOKEN
        (
            "SLACK_TOKEN",
            re.compile(r'xox[baprs]-[0-9a-zA-Z\-]+'),
            "[REDACTED_SLACK_TOKEN]",
            "HIGH",
            "secret",
        ),
        # 12. GOOGLE_API_KEY
        (
            "GOOGLE_API_KEY",
            re.compile(r'AIza[0-9A-Za-z\-_]{35}'),
            "[REDACTED_GOOGLE_KEY]",
            "CRITICAL",
            "secret",
        ),
        # 13. PRIVATE_KEY
        (
            "PRIVATE_KEY",
            re.compile(r'-----BEGIN [A-Z ]+ PRIVATE KEY-----'),
            "[REDACTED_PRIVATE_KEY]",
            "CRITICAL",
            "secret",
        ),
        # 14. JWT_TOKEN
        (
            "JWT_TOKEN",
            re.compile(r'eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+'),
            "[REDACTED_JWT]",
            "HIGH",
            "secret",
        ),
        # 15. HIGH_ENTROPY_SECRET — handled specially (entropy check)
        (
            "HIGH_ENTROPY_SECRET",
            re.compile(
                r'(?:api[_\-]?key|password|secret|token|passwd|pwd|auth|credential)'
                r'\s*[=:]\s*["\']([^"\']{16,})["\']',
                re.IGNORECASE,
            ),
            "[REDACTED_SECRET]",
            "HIGH",
            "secret",
        ),
        # 16. PROMPT_INJECTION — handled specially (multiple sub-patterns)
        (
            "PROMPT_INJECTION",
            None,           # pattern list applied in _run_injection()
            "[REDACTED_INJECTION]",
            "CRITICAL",
            "injection",
        ),
    ]

    # Prompt-injection sub-patterns
    _INJECTION_PATTERNS = [
        re.compile(r'ignore all previous instructions', re.IGNORECASE),
        re.compile(
            r'disregard (?:the |your |all |)?(?:system |)?(?:prompt|instructions)',
            re.IGNORECASE,
        ),
        re.compile(
            r'you are now in (?:developer|dev|jailbreak|DAN) mode',
            re.IGNORECASE,
        ),
        re.compile(
            r'print (?:your |the |)?(?:system |)?(?:prompt|instructions)',
            re.IGNORECASE,
        ),
        re.compile(r'exfiltrate', re.IGNORECASE),
        re.compile(
            r'act as (?:if |)?(?:you have no|DAN|jailbreak)',
            re.IGNORECASE,
        ),
        # Empty markdown link (pixel tracker)
        re.compile(r'\[\s*\]\(https?://[^\)]+\)'),
        # Markdown image with http
        re.compile(r'!\[[^\]]*\]\(https?://[^\)]*\)'),
        # Inline system override comment
        re.compile(r'//\s*SYSTEM\s*:'),
    ]

    # -----------------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------------

    def scan(self, text: str) -> dict:
        """
        Scan *text* and return a result dict with findings, risk score, action,
        sanitized text, and category counts.
        """
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

        if risk_score >= 60:
            action = "BLOCK"
        elif risk_score >= 20:
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
        High-entropy secret detector.
        Finds variable assignments whose values have entropy > 3.8 bits/char.
        """
        findings: list[dict] = []
        offset = 0
        result_text = text

        for m in pattern.finditer(text):
            secret_value = m.group(1)
            if _shannon_entropy(secret_value) <= 3.8:
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
        Prompt-injection detector.
        Each sub-pattern match is recorded as a separate finding.
        Replacements happen in a single pass per sub-pattern.
        """
        findings: list[dict] = []
        result_text = text

        for sub_pattern in self._INJECTION_PATTERNS:
            offset = 0
            scan_base = result_text  # scan the text as it stands at start of this sub-loop

            for m in sub_pattern.finditer(scan_base):
                start = m.start() + offset
                end = m.end() + offset

                findings.append(
                    {
                        "type": "PROMPT_INJECTION",
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
