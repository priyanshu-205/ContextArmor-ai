"""
compressor_engine.py
Full Prompt Improver & AST/Structural Code Compressor for ContextArmor-ai.
"""

import ast
import re
import math
import io
import tokenize
import collections

try:
    import tiktoken
    _enc = tiktoken.get_encoding("cl100k_base")
    def count_tokens(text: str) -> int:
        return len(_enc.encode(text))
except Exception:
    def count_tokens(text: str) -> int:
        return len(re.findall(r'\w+|[^\w\s]', text))


class CompressorEngine:
    """
    Compresses prompts and code blocks to reduce token usage while preserving semantics.
    """

    def compress_and_optimize(
        self,
        text: str,
        mode: str = "lossless",
        api_key: str = None,
        provider: str = None,
    ) -> dict:
        """
        Main entry point. Runs guardrails, compresses code blocks, then
        optimizes the natural-language portions of the prompt.

        Returns a dict with compression statistics and the optimized prompt.
        """
        # ------------------------------------------------------------------
        # Step 1 — Guardrails pre-scan
        # ------------------------------------------------------------------
        from guardrails_engine import GuardrailsEngine

        guardrails = GuardrailsEngine()
        scan_result = guardrails.scan(text)
        working_text = scan_result.get("sanitized_text", text)
        redactions_applied = scan_result.get("findings", [])

        original_tokens = count_tokens(text)

        # ------------------------------------------------------------------
        # Step 2 — Detect and compress code blocks
        # ------------------------------------------------------------------
        code_block_pattern = re.compile(r'```(\w*)\n(.*?)```', re.DOTALL)
        code_blocks_compressed = 0

        def _replace_code_block(match: re.Match) -> str:
            nonlocal code_blocks_compressed
            language = match.group(1).strip().lower()
            code_body = match.group(2)
            compressed_code = self._compress_code(code_body, language, mode)
            code_blocks_compressed += 1
            return f"```{match.group(1)}\n{compressed_code}```"

        text_with_compressed_code = code_block_pattern.sub(
            _replace_code_block, working_text
        )

        # ------------------------------------------------------------------
        # Step 3 — Optimize the natural language part
        # ------------------------------------------------------------------
        optimized_prompt = self._optimize_prompt_text(
            text_with_compressed_code, api_key, provider
        )

        compressed_tokens = count_tokens(optimized_prompt)
        tokens_saved = max(0, original_tokens - compressed_tokens)
        reduction_percentage = (
            round((tokens_saved / original_tokens) * 100, 2)
            if original_tokens > 0
            else 0.0
        )

        return {
            "optimized_prompt": optimized_prompt,
            "original_tokens": original_tokens,
            "compressed_tokens": compressed_tokens,
            "tokens_saved": tokens_saved,
            "reduction_percentage": reduction_percentage,
            "redactions_applied": redactions_applied,
            "mode": mode,
            "code_blocks_compressed": code_blocks_compressed,
        }

    # ------------------------------------------------------------------
    # Code compression
    # ------------------------------------------------------------------

    def _compress_code(self, code: str, language: str, mode: str) -> str:
        """
        Compress a code block according to language and mode.
        """
        python_languages = {"python", "py", ""}
        clike_languages = {
            "javascript", "js", "typescript", "ts",
            "java", "cpp", "c++", "c",
        }

        is_python_like = language in python_languages
        has_python_constructs = bool(re.search(r'\bdef\b|\bclass\b', code))

        if is_python_like and has_python_constructs:
            return self._compress_python(code, mode)
        elif language in clike_languages:
            return self._strip_comments_regex(code, language)
        else:
            # Generic: just strip comments as best we can
            return self._strip_comments_regex(code, language)

    def _compress_python(self, code: str, mode: str) -> str:
        """
        Compress Python code using AST manipulation.
        """
        try:
            tree = ast.parse(code)
        except SyntaxError:
            return self._strip_comments_regex(code, "python")

        if mode == "lossless":
            return self._python_lossless(tree)
        elif mode == "signatures":
            return self._python_signatures(tree, code)
        else:
            return self._python_lossless(tree)

    def _python_lossless(self, tree: ast.Module) -> str:
        """
        Remove docstrings and comments, return unparsed source.
        Collapse blank lines.
        """
        self._ast_remove_docstrings(tree)
        ast.fix_missing_locations(tree)
        try:
            result = ast.unparse(tree)
        except Exception:
            return ast.dump(tree)

        # Collapse 3+ consecutive blank lines to 1
        result = re.sub(r'\n{3,}', '\n\n', result)
        # Strip trailing whitespace from each line
        lines = [line.rstrip() for line in result.splitlines()]
        return "\n".join(lines)

    def _python_signatures(self, tree: ast.Module, original_code: str) -> str:
        """
        Keep imports, class stubs, constants, and function signatures.
        For functions with body > 5 lines, replace body with pass.
        """
        original_lines = original_code.splitlines()
        output_parts: list[str] = []

        for node in ast.walk(tree):
            # Ensure we only process top-level and class-level items once
            pass

        def _node_body_lines(node) -> int:
            """Estimate the number of source lines in a node's body."""
            if not hasattr(node, "body") or not node.body:
                return 0
            try:
                start = node.body[0].lineno - 1
                end = node.body[-1].end_lineno if hasattr(node.body[-1], "end_lineno") else node.body[-1].lineno
                return end - start + 1
            except Exception:
                return 0

        def _process_node(node, indent: int = 0) -> list[str]:
            prefix = "    " * indent
            lines_out: list[str] = []

            if isinstance(node, (ast.Import, ast.ImportFrom)):
                lines_out.append(prefix + ast.unparse(node))

            elif isinstance(node, ast.Assign):
                # Global constants (ALL_CAPS or simple assignments at module level)
                lines_out.append(prefix + ast.unparse(node))

            elif isinstance(node, ast.AnnAssign):
                lines_out.append(prefix + ast.unparse(node))

            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                # Decorators
                for dec in node.decorator_list:
                    lines_out.append(prefix + "@" + ast.unparse(dec))

                # Signature line
                async_prefix = "async " if isinstance(node, ast.AsyncFunctionDef) else ""
                args_str = ast.unparse(node.args)
                returns_str = (
                    " -> " + ast.unparse(node.returns)
                    if node.returns is not None
                    else ""
                )
                sig = f"{prefix}{async_prefix}def {node.name}({args_str}){returns_str}:"

                body_lines = _node_body_lines(node)
                if body_lines > 5:
                    lines_out.append(sig)
                    lines_out.append(prefix + "    pass  # [Body pruned for context efficiency]")
                else:
                    # Keep small functions intact
                    lines_out.append(sig)
                    for child in node.body:
                        lines_out.extend(_process_node(child, indent + 1))

            elif isinstance(node, ast.ClassDef):
                # Decorators
                for dec in node.decorator_list:
                    lines_out.append(prefix + "@" + ast.unparse(dec))

                bases_str = ", ".join(ast.unparse(b) for b in node.bases)
                lines_out.append(prefix + f"class {node.name}({bases_str}):")

                class_has_content = False
                for child in node.body:
                    child_lines = _process_node(child, indent + 1)
                    if child_lines:
                        lines_out.extend(child_lines)
                        class_has_content = True

                if not class_has_content:
                    lines_out.append(prefix + "    pass")

            elif isinstance(node, ast.Expr):
                # Skip standalone string expressions (docstrings already removed,
                # but keep other expressions)
                if not isinstance(node.value, ast.Constant):
                    lines_out.append(prefix + ast.unparse(node))

            else:
                # Other statements — include them
                try:
                    lines_out.append(prefix + ast.unparse(node))
                except Exception:
                    pass

            return lines_out

        all_lines: list[str] = []
        for node in tree.body:
            all_lines.extend(_process_node(node, 0))
            all_lines.append("")  # blank line between top-level items

        result = "\n".join(all_lines)
        result = re.sub(r'\n{3,}', '\n\n', result)
        return result.strip()

    def _ast_remove_docstrings(self, tree: ast.AST) -> ast.AST:
        """
        Walk the AST and remove docstring Expr nodes from module, class,
        and function bodies in-place.
        """
        docstring_holder_types = (
            ast.Module,
            ast.ClassDef,
            ast.FunctionDef,
            ast.AsyncFunctionDef,
        )

        for node in ast.walk(tree):
            if isinstance(node, docstring_holder_types):
                body = getattr(node, "body", [])
                if body and isinstance(body[0], ast.Expr):
                    expr_val = body[0].value
                    if isinstance(expr_val, ast.Constant) and isinstance(
                        expr_val.value, str
                    ):
                        node.body = body[1:]
                        # If body becomes empty, add a pass
                        if not node.body:
                            pass_node = ast.Pass()
                            ast.copy_location(pass_node, node)
                            node.body = [pass_node]

        return tree

    # ------------------------------------------------------------------
    # Comment stripping
    # ------------------------------------------------------------------

    def _strip_comments_regex(self, code: str, language: str) -> str:
        """
        Remove comments from code using a character-level state machine.
        Handles:
        - String literals (single/double quoted, with escapes)
        - Template literals for JS (backtick strings)
        - // single-line comments
        - /* ... */ multi-line comments
        - # single-line comments (Python)
        Never modifies content inside string literals.
        """
        result = []
        i = 0
        n = len(code)
        python_mode = language in ("python", "py", "")

        while i < n:
            c = code[i]

            # ------ Triple-quoted strings (Python) ----------------------
            if python_mode and code[i:i+3] in ('"""', "'''"):
                quote = code[i:i+3]
                result.append(quote)
                i += 3
                while i < n:
                    if code[i:i+3] == quote:
                        result.append(quote)
                        i += 3
                        break
                    if code[i] == '\\':
                        result.append(code[i:i+2])
                        i += 2
                    else:
                        result.append(code[i])
                        i += 1
                continue

            # ------ Single/double quoted strings ------------------------
            if c in ('"', "'"):
                quote_char = c
                result.append(c)
                i += 1
                while i < n:
                    ch = code[i]
                    if ch == '\\':
                        result.append(code[i:i+2])
                        i += 2
                        continue
                    result.append(ch)
                    i += 1
                    if ch == quote_char:
                        break
                continue

            # ------ Template literals (JS backtick) ---------------------
            if c == '`' and not python_mode:
                result.append(c)
                i += 1
                while i < n:
                    ch = code[i]
                    if ch == '\\':
                        result.append(code[i:i+2])
                        i += 2
                        continue
                    result.append(ch)
                    i += 1
                    if ch == '`':
                        break
                continue

            # ------ Multi-line block comment /* ... */ ------------------
            if not python_mode and code[i:i+2] == '/*':
                i += 2
                while i < n:
                    if code[i:i+2] == '*/':
                        i += 2
                        break
                    i += 1
                # Skip the rest of the line if it's only whitespace after */
                continue

            # ------ Single-line comment // --------------------------
            if not python_mode and code[i:i+2] == '//':
                while i < n and code[i] != '\n':
                    i += 1
                continue

            # ------ Python # comment -----------------------------------
            if python_mode and c == '#':
                while i < n and code[i] != '\n':
                    i += 1
                continue

            result.append(c)
            i += 1

        cleaned = "".join(result)

        # Strip trailing whitespace from each line
        lines = [line.rstrip() for line in cleaned.splitlines()]

        # Collapse 3+ consecutive blank lines to 1
        collapsed: list[str] = []
        blank_count = 0
        for line in lines:
            if line.strip() == "":
                blank_count += 1
                if blank_count <= 1:
                    collapsed.append(line)
            else:
                blank_count = 0
                collapsed.append(line)

        return "\n".join(collapsed)

    # ------------------------------------------------------------------
    # Prompt text optimizer
    # ------------------------------------------------------------------

    def _optimize_prompt_text(
        self, text: str, api_key: str = None, provider: str = None
    ) -> str:
        """
        Deterministic rule-based optimizer, with optional LLM enhancement.
        """
        # ---- Deterministic pass ----
        result = self._deterministic_optimize(text)

        # ---- Optional LLM enhancement ----
        if api_key and provider:
            try:
                result = self._llm_enhance(result, api_key, provider)
            except Exception:
                pass  # Fall back to deterministic result

        return result

    def _deterministic_optimize(self, text: str) -> str:
        """
        Rule-based prompt optimization: strip filler, structure, normalize.
        """
        # --- 1. Strip filler phrases (operate line-by-line for ^ anchors) ---
        filler_patterns = [
            (
                re.compile(
                    r'^(hey\s+)?(chatgpt|claude|gemini|gpt|ai)[,\s]+could\s+you\s+(please\s+)?',
                    re.IGNORECASE | re.MULTILINE,
                ),
                "",
            ),
            (
                re.compile(
                    r'^i\s+was\s+wondering\s+if\s+(it\s+would\s+be\s+possible\s+to\s+)?',
                    re.IGNORECASE | re.MULTILINE,
                ),
                "",
            ),
            (
                re.compile(
                    r'^(could\s+you\s+please|please\s+could\s+you|would\s+you\s+be\s+able\s+to)\s+',
                    re.IGNORECASE | re.MULTILINE,
                ),
                "",
            ),
            (
                re.compile(
                    r'(thank\s+you\s+(so\s+much\s+)?(in\s+advance|for\s+your\s+help)[.!]?\s*)',
                    re.IGNORECASE,
                ),
                "",
            ),
            (
                re.compile(
                    r'(i\s+hope\s+this\s+(makes\s+sense|is\s+clear)[.!]?\s*)',
                    re.IGNORECASE,
                ),
                "",
            ),
            (
                re.compile(r'\s{3,}'),
                " ",
            ),
        ]

        result = text
        for pattern, replacement in filler_patterns:
            result = pattern.sub(replacement, result)

        # --- 2. Structure detection ---
        # Only auto-structure if text has no existing ### headers
        has_headers = bool(re.search(r'^#{1,6}\s', result, re.MULTILINE))

        if not has_headers:
            # Split into sentences (simple heuristic)
            sentence_pattern = re.compile(r'(?<=[.!?])\s+')
            sentences = [s.strip() for s in sentence_pattern.split(result.strip()) if s.strip()]

            if len(sentences) >= 3:
                imperative_verbs = {
                    "write", "create", "fix", "analyze", "generate", "explain",
                    "refactor", "implement", "build", "convert", "optimize",
                    "add", "remove", "update", "improve", "design", "review",
                    "summarize", "translate", "debug", "test",
                }

                first_sentence = sentences[0]
                first_words = set(re.findall(r'\b\w+\b', first_sentence.lower()))
                is_imperative = bool(first_words & imperative_verbs)

                if is_imperative:
                    task_sentence = first_sentence
                    context_sentences = sentences[1:]
                else:
                    task_sentence = first_sentence
                    context_sentences = sentences[1:]

                context_text = " ".join(context_sentences)

                result = (
                    f"### Task\n{task_sentence}\n\n"
                    f"### Context\n{context_text}\n\n"
                    f"### Output Constraints\n"
                    f"- Be concise and precise\n"
                    f"- Return only the requested output"
                )

        # --- 3. Normalize multiple newlines ---
        result = re.sub(r'\n{3,}', '\n\n', result)

        return result.strip()

    def _llm_enhance(self, text: str, api_key: str, provider: str) -> str:
        """
        Send text to the specified LLM provider for prompt improvement.
        Falls back to `text` on any error.
        """
        import httpx

        system_message = (
            "You are a prompt optimization expert. Improve the clarity and specificity "
            "of the following prompt. Keep it concise. Preserve all code blocks exactly "
            "as-is. Return only the improved prompt text, no explanation."
        )

        timeout = 30.0
        provider_lower = (provider or "").lower().strip()

        if provider_lower == "openai":
            url = "https://api.openai.com/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            payload = {
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": system_message},
                    {"role": "user", "content": text},
                ],
            }
            with httpx.Client(timeout=timeout) as client:
                response = client.post(url, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
                return data["choices"][0]["message"]["content"].strip()

        elif provider_lower == "anthropic":
            url = "https://api.anthropic.com/v1/messages"
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            }
            payload = {
                "model": "claude-3-haiku-20240307",
                "max_tokens": 1024,
                "system": system_message,
                "messages": [{"role": "user", "content": text}],
            }
            with httpx.Client(timeout=timeout) as client:
                response = client.post(url, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
                return data["content"][0]["text"].strip()

        elif provider_lower == "gemini":
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/"
                f"models/gemini-1.5-flash:generateContent?key={api_key}"
            )
            headers = {"Content-Type": "application/json"}
            payload = {
                "contents": [
                    {
                        "parts": [
                            {"text": system_message + "\n\n" + text}
                        ]
                    }
                ]
            }
            with httpx.Client(timeout=timeout) as client:
                response = client.post(url, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
                return (
                    data["candidates"][0]["content"]["parts"][0]["text"].strip()
                )

        elif provider_lower == "ollama":
            url = "http://localhost:11434/api/generate"
            headers = {"Content-Type": "application/json"}
            payload = {
                "model": "llama3",
                "prompt": system_message + "\n\n" + text,
                "stream": False,
            }
            with httpx.Client(timeout=timeout) as client:
                response = client.post(url, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
                return data.get("response", text).strip()

        else:
            raise ValueError(f"Unknown provider: {provider!r}")
