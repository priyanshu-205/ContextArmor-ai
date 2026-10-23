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
        recent_context = self._extract_recent_context(sanitized_messages)

        # ------------------------------------------------------------------
        # Step 5 — Generate bridge prompt
        # ------------------------------------------------------------------
        message_count = len(sanitized_messages)

        # Tech stack section
        if tech_stack:
            tech_stack_section = "\n".join(f"- {item}" for item in tech_stack)
        else:
            tech_stack_section = "Not specified"

        # Key decisions section
        if key_decisions:
            key_decisions_section = "\n".join(
                f"{idx + 1}. {decision}"
                for idx, decision in enumerate(key_decisions)
            )
        else:
            key_decisions_section = "None recorded"

        # Latest code section
        latest_code_section = latest_code if latest_code else "No code blocks found in conversation"

        # Pending tasks section
        if pending_tasks:
            pending_tasks_section = "\n".join(
                f"- ⚠️ {task}" for task in pending_tasks
            )
        else:
            pending_tasks_section = "None identified"

        bridge_prompt = (
            "# 🔄 Continuation Bridge — ContextArmor Transfer\n\n"
            "## Requirements & User Priorities\n"
            f"{requirements or 'No additional requirements identified'}\n\n"
            "## Recent Conversation Context\n"
            f"{recent_context or 'No recent context available'}\n\n"
            "## 🎯 Primary Objective\n"
            f"{primary_objective}\n\n"
            "## 🛠 Tech Stack & Constraints\n"
            f"{tech_stack_section}\n\n"
            "## ✅ Key Decisions & Completed Work\n"
            f"{key_decisions_section}\n\n"
            "## 💻 Latest Active Code State\n"
            f"{latest_code_section}\n\n"
            "## ⏳ Pending Tasks & Open Issues\n"
            f"{pending_tasks_section}\n\n"
            "## 📋 Session Context\n"
            f"- **Messages analyzed**: {message_count}\n"
            f"- **Redactions applied**: {total_redactions}\n"
            "- **Generated by**: ContextArmor Transfer Engine\n\n"
            "---\n"
            "*Continue from exactly this state. All prior context is captured above.*"
        )

        # ------------------------------------------------------------------
        # Step 6 — Compute final statistics
        # ------------------------------------------------------------------
        bridge_tokens = count_tokens(bridge_prompt)
        tokens_saved = max(0, original_tokens - bridge_tokens)
        compression_ratio = (
            round(original_tokens / bridge_tokens, 4)
            if bridge_tokens > 0
            else 1.0
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

        def _first_sentences(text: str, n: int = 3) -> str:
            """Return the first N sentences of text."""
            sentence_re = re.compile(r'(?<=[.!?])\s+')
            sentences = sentence_re.split(text.strip())
            return " ".join(sentences[:n]).strip()

        first_summary = _first_sentences(user_messages[0]["content"], 3)

        pivot_text = ""
        if len(user_messages) >= 2:
            second_content = user_messages[1]["content"].lower()
            first_content = user_messages[0]["content"].lower()

            # Simple pivot heuristic: check for pivot/change keywords
            pivot_keywords = {
                "actually", "instead", "different", "change", "switch",
                "pivot", "forget that", "scratch that", "new approach",
                "let's do", "let me try", "try a different",
            }
            second_words = set(re.findall(r'\b\w+\b', second_content))
            if second_words & pivot_keywords:
                pivot_summary = _first_sentences(user_messages[1]["content"], 2)
                pivot_text = f" Later pivoted to: {pivot_summary}"

        latest_summary = _first_sentences(user_messages[-1]["content"], 2)
        if len(user_messages) > 1 and latest_summary.lower() not in first_summary.lower():
            pivot_text = f" Latest user request: {latest_summary}"
        return (first_summary + pivot_text).strip()

    def _extract_requirements(self, messages: list) -> str:
        """Extract concrete constraints and requirements from user turns."""
        text = "\n".join(m["content"] for m in messages if m["role"] == "user")
        pattern = re.compile(r"[^.!?\n]*(?:must|should|need to|needs to|require(?:ment|s)?|do not|don't|cannot|without|at least|no more than)[^.!?\n]*[.!?]?", re.IGNORECASE)
        found, seen = [], set()
        for match in pattern.finditer(text):
            item = re.sub(r"\s+", " ", match.group(0)).strip(" -\t")
            if len(item) > 12 and item.casefold() not in seen:
                seen.add(item.casefold())
                found.append(item)
        return "\n".join(f"- {item}" for item in found[-10:])

    def _extract_recent_context(self, messages: list) -> str:
        """Keep recent conversational details with a per-turn size bound."""
        lines = []
        for message in messages[-4:]:
            content = re.sub(r"```.*?```", "[code excerpt captured above]", message["content"], flags=re.DOTALL)
            content = re.sub(r"\s+", " ", content).strip()
            if len(content) > 220:
                content = content[:217].rsplit(" ", 1)[0] + "..."
            if content:
                lines.append(f"- {message['role'].title()}: {content}")
        return "\n".join(lines)

    def _extract_tech_stack(self, messages: list) -> list:
        """
        Scan all messages for programming languages, frameworks, databases,
        cloud providers, and tools. Also extract constraint sentences.
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
            # Use word boundary for most, but allow "next.js" etc.
            pattern = re.compile(r'\b' + re.escape(tech) + r'\b', re.IGNORECASE)
            if pattern.search(all_text):
                detected.append(tech)

        # Extract explicit constraint sentences
        constraint_pattern = re.compile(
            r'[^.!?\n]*(?:must use|do not use|cannot use|requires|error:)[^.!?\n]*[.!?]?',
            re.IGNORECASE,
        )
        all_messages_text = " ".join(m["content"] for m in messages)
        constraint_matches = constraint_pattern.findall(all_messages_text)
        for match in constraint_matches:
            cleaned = match.strip()
            if cleaned and cleaned not in detected:
                detected.append(cleaned)

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
        Return up to 5 most recent.
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

        # Split into sentences
        sentence_re = re.compile(r'(?<=[.!?])\s+')
        sentences = sentence_re.split(assistant_text)

        decision_sentences = [
            s.strip()
            for s in sentences
            if decision_keywords.search(s) and len(s.strip()) > 10
        ]

        # Return up to 5 most recent
        return decision_sentences[-5:]

    def _extract_latest_code(self, messages: list) -> str:
        """
        Find the last message containing a fenced code block.
        Compress it with signatures mode and return it.
        """
        code_block_pattern = re.compile(r'```(\w*)\n(.*?)```', re.DOTALL)

        # Search messages in reverse to find the last one with code
        latest_by_language = {}
        for msg in messages:
            for language, code_body in code_block_pattern.findall(msg["content"]):
                latest_by_language[language.strip().lower() or "text"] = (language, code_body)
        if not latest_by_language:
            return ""

        compressed_parts: list[str] = []
        for language, code_body in latest_by_language.values():
            lang = language.strip().lower()
            try:
                compressed = self._compressor._compress_code(code_body, lang, "signatures")
            except Exception:
                compressed = code_body
            compressed_parts.append(f"```{language}\n{compressed}\n```")

        return "\n\n".join(compressed_parts)

    def _extract_pending_tasks(self, messages: list) -> list:
        """
        Scan the last 4 messages for unresolved tasks and issues.
        Return up to 5 relevant sentences.
        """
        recent_messages = [m for m in messages[-8:] if m["role"] == "user"]
        combined_text = " ".join(m["content"] for m in recent_messages)

        pending_pattern = re.compile(
            r'[^.!?\n]*\b(TODO|still need to|next step|remaining|not yet|'
            r'pending|broken|bug|error|issue|doesn\'t work|failing|need to)\b[^.!?\n]*[.!?]?',
            re.IGNORECASE,
        )

        matches = pending_pattern.findall(combined_text)
        # findall with groups returns group tuples; we need the full sentences
        # Re-run with finditer to get the full match strings
        pending_sentences: list[str] = []
        for match in pending_pattern.finditer(combined_text):
            sentence = match.group(0).strip()
            if sentence and len(sentence) > 5:
                pending_sentences.append(sentence)

        # Deduplicate
        seen: set[str] = set()
        unique: list[str] = []
        for s in pending_sentences:
            key = s.lower().strip()
            if key not in seen:
                seen.add(key)
                unique.append(s)

        return unique[:5]
