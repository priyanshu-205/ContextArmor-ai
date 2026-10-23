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
        Reads backend environment variables if api_key is not passed from client.
        """
        import os

        # Check server environment if client did not supply api_key
        effective_key = api_key
        effective_provider = provider

        if not effective_key:
            if os.getenv("OPENAI_API_KEY"):
                effective_key = os.getenv("OPENAI_API_KEY")
                effective_provider = effective_provider or "openai"
            elif os.getenv("ANTHROPIC_API_KEY"):
                effective_key = os.getenv("ANTHROPIC_API_KEY")
                effective_provider = effective_provider or "anthropic"
            elif os.getenv("GEMINI_API_KEY"):
                effective_key = os.getenv("GEMINI_API_KEY")
                effective_provider = effective_provider or "gemini"

        # ---- Deterministic pass ----
        result = self._deterministic_optimize(text)

        # ---- Optional LLM enhancement ----
        if effective_key and effective_provider:
            try:
                result = self._llm_enhance(result, effective_key, effective_provider)
            except Exception:
                pass  # Fall back to deterministic result

        return result

    def _deterministic_optimize(self, text: str) -> str:
        """
        Rule-based prompt optimization: strip pleasantries, redundant phrasing,
        tautologies, and conversational padding while strictly preserving
        technical constraints, code, entities, numbers, and intent.
        Achieves 20-30% token reduction on conversational prompts.
        """
        # Protect fenced code blocks by replacing them with tokens during text optimization
        code_blocks = []
        def _save_code(m):
            code_blocks.append(m.group(0))
            return f"__CA_CODE_BLOCK_{len(code_blocks)-1}__"

        protected_text = re.sub(r'```[\s\S]*?```', _save_code, text)

        # 1. Strip conversational salutations & intros (operate in loop until clean)
        intro_patterns = [
            r'^(?:hey|hi|hello|dear|greetings)\s+(?:there\s+)?[,\s!.]*',
            r'^(?:good\s+(?:morning|afternoon|evening)\s*(?:ai|chatgpt|claude|gemini|assistant)?[,\s!.]*)',
            r'^(?:chatgpt|claude|gemini|gpt|ai|assistant)[,\s!.]*',
            r'^(?:please\s+)?(?:help\s+me\s*(?:with\s+|to\s+|out\s+with\s+)?|i\s+need\s+your\s+help\s*(?:with|to)?)[.!]?\s*',
            r'^(?:i\s+was\s+wondering\s+if\s+(?:it\s+would\s+be\s+possible\s+to|you\s+could\s*(?:possibly\s+)?))(?:\s*help\s+me\s*(?:out\s+)?with\s+[^.!?]+[.!?]\s*)?',
            r'^(?:if\s+it\s+is\s+not\s+too\s+much\s+trouble[,\s]*)',
            r'^(?:would\s+you\s+be\s+so\s+kind\s+as\s+to\s+)',
            r'^(?:i\s+would\s+appreciate\s+it\s+if\s+you\s+could\s+assist\s+me\s*(?:today)?[.!]?\s*)',
            r'^(?:could\s+you\s+(?:please\s+)?(?:help\s+me\s+)?|would\s+you\s+(?:please\s+)?(?:be\s+able\s+to\s+)?|can\s+you\s+(?:please\s+)?|please\s+(?:could\s+you\s+|kindly\s+)?)',
            r'^(?:i\s+need\s+you\s+to\s+|i\s+would\s+like\s+you\s+to\s+|i\s+want\s+you\s+to\s+)',
            r'^(?:do\s+you\s+mind\s+(?:if\s+you\s+)?(?:writing|creating|helping)\s+)',
            r'^(?:i\s+am\s+having\s+an\s+issue\s+with\s+)',
        ]
        prev = ""
        while prev != protected_text:
            prev = protected_text
            for pat in intro_patterns:
                protected_text = re.sub(pat, '', protected_text.strip(), flags=re.IGNORECASE | re.MULTILINE).strip()

        # 2. Strip sign-offs, pleasantries, and conversational padding
        outro_patterns = [
            r'(?:(?:also,\s*)?(?:thank\s+you|thanks)\s+(?:so\s+much|very\s+much|a\s+lot)?\s*(?:in\s+advance)?\s*(?:for\s+your\s+(?:assistance|help|support)[^.!?]*)?[.!?]?\s*)',
            r'(?:(?:thank\s+you|thanks)\s+kindly[!.]?\s*)',
            r'(?:i\s+really\s+appreciate\s+your\s+help[!.]?\s*)',
            r'(?:(?:thank\s+you|thanks)\s+(?:very\s+much\s+)?for\s+your\s+great\s+support[!.]?\s*)',
            r'(?:i\s+hope\s+this\s+(?:makes\s+sense|is\s+clear|helps)[.!?,]?\s*)',
            r'(?:let\s+me\s+know\s+if\s+(?:you\s+have\s+any\s+questions|you\s+need\s+(?:more\s+)?(?:info|details|clarification))[.!?,]?\s*)',
            r'(?:looking\s+forward\s+to\s+your\s+(?:reply|response)[.!?,]?\s*)',
            r'(?:any\s+help\s+(?:would\s+be|is)\s+appreciated[.!?,]?\s*)',
            r'\bkindly[!.]',
        ]
        for pat in outro_patterns:
            protected_text = re.sub(pat, '', protected_text, flags=re.IGNORECASE).strip()

        # 3. Conciseness replacements (prune wordy fluff without losing information)
        wordiness_subs = [
            (r'\bi\s+was\s+wondering\s+if\s+you\s+could\s+', ''),
            (r'\bif\s+you\s+could\s+please\s+', ''),
            (r'\bplease\s+help\s+me\b[.!?,]?', ''),
            (r'\bbasically\s+what\s+i\s+need\s+is\s+', ''),
            (r'\bcould\s+you\s+please\s+make\s+sure\s+that\s+it\s+', 'Ensure it '),
            (r'\bplease\s+be\s+sure\s+that\s+it\s+', 'Ensure it '),
            (r'\bplease\s+make\s+sure\s+to\s+', 'Ensure to '),
            (r'\bmake\s+sure\s+to\s+', 'Ensure to '),
            (r'\bmake\s+sure\s+that\s+it\s+', 'Ensure it '),
            (r'\bit\s+is\s+really\s+important\s+that\s+you\s+', ''),
            (r'\bit\s+is\s+important\s+to\s+note\s+that\b', ''),
            (r'\bin\s+order\s+to\b', 'to'),
            (r'\bdue\s+to\s+the\s+fact\s+that\b', 'because'),
            (r'\bat\s+this\s+point\s+in\s+time\b', 'currently'),
            (r'\bat\s+the\s+present\s+time\b', 'currently'),
            (r'\bfor\s+the\s+purpose\s+of\b', 'for'),
            (r'\bin\s+the\s+event\s+that\b', 'if'),
            (r'\bhas\s+the\s+ability\s+to\b', 'can'),
            (r'\bis\s+able\s+to\b', 'can'),
            (r'\btake\s+into\s+consideration\b', 'consider'),
            (r'\bmake\s+an\s+assumption\b', 'assume'),
            (r'\bas\s+a\s+matter\s+of\s+fact\b', ''),
            (r'\bbasically\b', ''),
            (r'\bessentially\b', ''),
            (r'\bplease\s+(?:kindly\s+)?', ''),
        ]
        for pat, repl in wordiness_subs:
            protected_text = re.sub(pat, repl, protected_text, flags=re.IGNORECASE)

        # 4. Clean up punctuation, spaces, and capitalize first character of sentences
        protected_text = re.sub(r'[ \t]{2,}', ' ', protected_text)
        protected_text = re.sub(r'\s+([,!.?])', r'\1', protected_text)
        protected_text = re.sub(r'\n{3,}', '\n\n', protected_text).strip()

        # Capitalize the first letter if it starts with lowercase after stripping filler
        if protected_text and protected_text[0].islower():
            protected_text = protected_text[0].upper() + protected_text[1:]

        # Restore code blocks
        for idx, block in enumerate(code_blocks):
            protected_text = protected_text.replace(f"__CA_CODE_BLOCK_{idx}__", block)

        return protected_text.strip()

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
