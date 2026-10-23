"""
transfer_engine.py
Full Context-Preserving Chat Transfer engine for ContextArmor-ai.
"""

import re
import json

from guardrails_engine import GuardrailsEngine
from compressor_engine import CompressorEngine, count_tokens


class TransferEngine:
    """
    Analyzes a conversation history and generates a dense, structured
    "bridge prompt" that captures all essential context, decisions, and
    pending tasks so a new chat session can continue seamlessly.
    """

    def __init__(self):
        self._guardrails = GuardrailsEngine()
        self._compressor = CompressorEngine()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def transfer(
        self,
        messages: list = None,
        raw_transcript: str = None,
    ) -> dict:
        """
        Main entry point.

        Parameters
        ----------
        messages : list of {"role": str, "content": str}, optional
        raw_transcript : str, optional
            Raw text of a conversation that will be parsed into turns.

        Returns
        -------
        dict with bridge_prompt and compression statistics.
        """
        # ------------------------------------------------------------------
        # Step 1 — Normalize input to list of role/content dicts
        # ------------------------------------------------------------------
        normalized = self._normalize_input(messages, raw_transcript)

        # ------------------------------------------------------------------
        # Step 2 — Redact PII/Secrets via GuardrailsEngine
        # ------------------------------------------------------------------
        total_redactions = 0
        sanitized_messages = []
        for msg in normalized:
            scan = self._guardrails.scan(msg["content"])
            sanitized_content = scan.get("sanitized_text", msg["content"])
            findings = scan.get("findings", [])
            total_redactions += len(findings)
            sanitized_messages.append(
                {"role": msg["role"], "content": sanitized_content}
            )

        # ------------------------------------------------------------------
        # Step 3 — Compute original token count
        # ------------------------------------------------------------------
        original_tokens = sum(
            count_tokens(m["content"]) for m in sanitized_messages
        )

        # ------------------------------------------------------------------
        # Step 4 — Extract insights
        # ------------------------------------------------------------------
        primary_objective = self._extract_primary_objective(sanitized_messages)
        tech_stack = self._extract_tech_stack(sanitized_messages)
        key_decisions = self._extract_key_decisions(sanitized_messages)
        latest_code = self._extract_latest_code(sanitized_messages)
        pending_tasks = self._extract_pending_tasks(sanitized_messages)
        requirements = self._extract_requirements(sanitized_messages)
        # Deduplicate sentences against primary objective
        obj_lower = primary_objective.lower()
        if requirements:
            req_lines = [line for line in requirements.split("\n") if line.strip("- \t").lower() not in obj_lower]
            requirements = "\n".join(req_lines)
        pending_tasks = [t for t in pending_tasks if t.lower() not in obj_lower]

        # ------------------------------------------------------------------
        # Step 5 — Generate bridge prompt (Dense, structured context bridge)
        # ------------------------------------------------------------------
        sections = [
            "# Context Continuation Bridge\n",
            f"**Primary Objective**: {primary_objective}\n",
        ]

        if tech_stack:
            sections.append(f"**Environment & Stack**: {', '.join(tech_stack[:6])}\n")

        if key_decisions:
            sections.append("**Decisions**:\n" + "\n".join(f"- {d}" for d in key_decisions[:3]) + "\n")

        if requirements:
            sections.append(f"**Constraints & Requirements**:\n{requirements}\n")

        if latest_code:
            sections.append(f"**Latest Code**:\n{latest_code}\n")

        if pending_tasks:
            sections.append("**Next Steps / Pending Tasks**:\n" + "\n".join(f"- {task}" for task in pending_tasks[:3]) + "\n")

        recent_context = self._extract_recent_context(sanitized_messages)
        if recent_context:
            sections.append(f"**Recent Conversation Context**:\n{recent_context}\n")

        bridge_prompt = "\n".join(sections).strip()

        # ------------------------------------------------------------------
        # Step 6 — Compute final statistics
        # ------------------------------------------------------------------
        bridge_tokens = count_tokens(bridge_prompt)
        tokens_saved = max(0, original_tokens - bridge_tokens)
        compression_ratio = (
            round(max(0.0, 1.0 - (bridge_tokens / original_tokens)), 4)
            if original_tokens > 0
            else 0.0
        )

        return {
            "bridge_prompt": bridge_prompt,
            "original_tokens": original_tokens,
            "bridge_tokens": bridge_tokens,
            "tokens_saved": tokens_saved,
            "compression_ratio": compression_ratio,
            "primary_objective": primary_objective,
            "tech_stack": tech_stack,
            "key_decisions": key_decisions,
            "pending_tasks": pending_tasks,
            "redactions_applied": total_redactions,
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _normalize_input(
        self,
        messages: list = None,
        raw_transcript: str = None,
    ) -> list:
        """
        Normalize input to a list of {"role": str, "content": str} dicts.
        """
        if messages and isinstance(messages, list) and len(messages) > 0:
            # Validate and pass through
            normalized = []
            for item in messages:
                if isinstance(item, dict):
                    role = str(item.get("role", "user")).strip().lower()
                    if role not in {"user", "assistant", "system", "developer"}:
                        role = "user"
                    raw_content = item.get("content", "")
                    content = raw_content.strip() if isinstance(raw_content, str) else str(raw_content).strip()
                    normalized.append({"role": role, "content": content})
            if normalized:
                return normalized

        if raw_transcript and isinstance(raw_transcript, str):
            return self._parse_raw_transcript(raw_transcript)

        # Absolute fallback
        if raw_transcript:
            return [{"role": "user", "content": raw_transcript}]

        return []

    def _parse_raw_transcript(self, transcript: str) -> list:
        """
        Parse a raw text transcript into role/content pairs.
        Recognizes: User:, Human:, Assistant:, AI:, ChatGPT:, Claude: at line starts.
        """
        # Pattern to split on speaker labels at the start of a line
        speaker_pattern = re.compile(
            r'^(user|human|assistant|ai|chatgpt|claude)\s*:\s*',
            re.IGNORECASE | re.MULTILINE,
        )

        role_map = {
            "user": "user",
            "human": "user",
            "assistant": "assistant",
            "ai": "assistant",
            "chatgpt": "assistant",
            "claude": "assistant",
        }

        parts = speaker_pattern.split(transcript)
        # split returns: [pre_text, speaker, content, speaker, content, ...]
        # parts[0] is any text before the first speaker label

        messages = []

        if len(parts) < 3:
            # No speaker labels found; treat entire transcript as user message
            content = transcript.strip()
            if content:
                messages.append({"role": "user", "content": content})
            return messages

        # parts[0] is pre-text (ignored if empty)
        pre_text = parts[0].strip()
        if pre_text:
            messages.append({"role": "user", "content": pre_text})

        # Iterate over (speaker, content) pairs
        i = 1
        while i < len(parts) - 1:
            speaker_label = parts[i].strip().lower()
            content = parts[i + 1].strip()
            role = role_map.get(speaker_label, "user")
            if content:
                messages.append({"role": role, "content": content})
            i += 2

        return messages

    def _extract_primary_objective(self, messages: list) -> str:
        """
        Summarize the core intent from the first 2 user messages.
        Detect pivots if a later message diverges significantly.
        """
        user_messages = [m for m in messages if m["role"] == "user"]

        if not user_messages:
            return "No user messages found."

        def _first_sentences(text: str, n: int = 2) -> str:
            """Return the first N sentences of text."""
            sentence_re = re.compile(r'(?<=[.!?])\s+')
            sentences = sentence_re.split(text.strip())
            return " ".join(sentences[:n]).strip()

        first_summary = _first_sentences(user_messages[0]["content"], 2)
        if len(first_summary) > 220:
            first_summary = first_summary[:217].rsplit(" ", 1)[0] + "..."

        pivot_text = ""
        if len(user_messages) > 1:
            latest_summary = _first_sentences(user_messages[-1]["content"], 1)
            if len(latest_summary) > 140:
                latest_summary = latest_summary[:137].rsplit(" ", 1)[0] + "..."
            if latest_summary.lower() not in first_summary.lower():
                pivot_text = f" Current focus: {latest_summary}"

        return (first_summary + pivot_text).strip()

    def _extract_requirements(self, messages: list) -> str:
        """Extract concrete constraints and requirements from user turns."""
        text = "\n".join(re.sub(r'```[\s\S]*?```', '', m["content"]) for m in messages if m["role"] == "user")
        pattern = re.compile(r"[^.!?\n]*(?:must|should|need to|needs to|require(?:ment|s)?|do not|don't|cannot|without)[^.!?\n]*[.!?]?", re.IGNORECASE)
        found, seen = [], set()
        for match in pattern.finditer(text):
            item = re.sub(r"\s+", " ", match.group(0)).strip(" -*•\t")
            key = item.casefold()
            if len(item) > 12 and len(item) < 150 and key not in seen:
                seen.add(key)
                found.append(item)
        return "\n".join(f"- {item}" for item in found[-4:])

    def _extract_recent_context(self, messages: list) -> str:
        """Keep recent conversational details with a per-turn size bound."""
        lines = []
        for message in messages[-3:]:
            content = re.sub(r"```.*?```", "[code]", message["content"], flags=re.DOTALL)
            content = re.sub(r"\s+", " ", content).strip()
            if len(content) > 150:
                content = content[:147].rsplit(" ", 1)[0] + "..."
            if content:
                lines.append(f"- {message['role'].title()}: {content}")
        return "\n".join(lines)

    def _extract_tech_stack(self, messages: list) -> list:
        """
        Scan all messages for programming languages, frameworks, databases,
        cloud providers, and tools. Also extract explicit constraint sentences.
        """
        all_text = " ".join(m["content"] for m in messages).lower()

        known_tech = {
            # Languages
            "python", "javascript", "typescript", "java", "rust", "go",
            "c++", "ruby", "php", "swift", "kotlin", "scala",
            # Frameworks
            "react", "vue", "angular", "django", "fastapi", "flask",
            "express", "spring", "rails", "next.js", "nuxt", "svelte",
            "laravel",
            # Databases
            "postgresql", "mysql", "sqlite", "mongodb", "redis",
            "elasticsearch",
            # Cloud
            "aws", "azure", "gcp", "vercel", "netlify",
            # Tools
            "docker", "kubernetes", "git", "webpack", "vite", "prisma",
        }

        detected: list[str] = []
        for tech in sorted(known_tech):
            pattern = re.compile(r'\b' + re.escape(tech) + r'\b', re.IGNORECASE)
            if pattern.search(all_text):
                detected.append(tech)

        # Deduplicate preserving order
        seen = set()
        unique = []
        for item in detected:
            key = item.lower()
            if key not in seen:
                seen.add(key)
                unique.append(item)

        return unique

    def _extract_key_decisions(self, messages: list) -> list:
        """
        Scan assistant turns for decision/completion sentences.
        Strips inline code blocks so decision summaries remain readable and compact.
        """
        decision_keywords = re.compile(
            r'\b(decided to|implemented|fixed|resolved|completed|switched to|'
            r'refactored|migrated|upgraded|installed|configured|'
            r'the solution is|the fix is|works now|successfully)\b',
            re.IGNORECASE,
        )

        assistant_text = " ".join(
            m["content"] for m in messages if m["role"] == "assistant"
        )
        # Strip code blocks from decision text so code stays in code section
        clean_text = re.sub(r'```[\s\S]*?```', '', assistant_text)

        # Split into sentences
        sentence_re = re.compile(r'(?<=[.!?])\s+')
        sentences = sentence_re.split(clean_text)

        decision_sentences = [
            s.strip()
            for s in sentences
            if decision_keywords.search(s) and len(s.strip()) > 10
        ]

        # Return up to 4 most recent unique decisions
        seen = set()
        unique = []
        for d in decision_sentences:
            cleaned = re.sub(r'\s+', ' ', d).strip()
            key = cleaned.lower()
            if key not in seen and len(cleaned) < 200:
                seen.add(key)
                unique.append(cleaned)

        return unique[-4:]

    def _extract_latest_code(self, messages: list) -> str:
        """
        Find the latest message containing a code block representing current state.
        Compress it with signatures mode and return it.
        """
        code_block_pattern = re.compile(r'```(\w*)\n(.*?)```', re.DOTALL)

        # Search messages in reverse to find the latest turn containing code
        for msg in reversed(messages):
            matches = code_block_pattern.findall(msg["content"])
            if matches:
                compressed_parts = []
                for language, code_body in matches:
                    lang = language.strip().lower() or "text"
                    if len(code_body.strip()) < 5:
                        continue
                    try:
                        compressed = self._compressor._compress_code(code_body, lang, "signatures")
                    except Exception:
                        compressed = code_body
                    compressed_parts.append(f"```{language}\n{compressed}\n```")
                if compressed_parts:
                    return "\n\n".join(compressed_parts)

        return ""

    def _extract_pending_tasks(self, messages: list) -> list:
        """
        Scan the last 4 messages for unresolved tasks and issues.
        Return up to 5 relevant sentences.
        """
        recent_messages = [m for m in messages[-8:] if m["role"] == "user"]
        combined_text = " ".join(m["content"] for m in recent_messages)

        pending_pattern = re.compile(
            r'[^.!?\n]*\b(TODO|still need(?: to|:)?|next steps?|remaining|not yet|'
            r'pending|broken|bug|error|issue|doesn\'t work|failing|unfinished tasks?)\b[^.!?\n]*[.!?]?',
            re.IGNORECASE,
        )

        matches = pending_pattern.findall(combined_text)
        pending_sentences: list[str] = []
        for match in pending_pattern.finditer(combined_text):
            sentence = match.group(0).strip()
            if sentence and len(sentence) > 8:
                pending_sentences.append(sentence)

        # Deduplicate preserving order
        seen: set[str] = set()
        unique: list[str] = []
        for s in pending_sentences:
            key = s.lower().strip()
            if key not in seen:
                seen.add(key)
                unique.append(s)

        # Return the most relevant recent pending items
        return unique[-4:] if len(unique) > 4 else unique
