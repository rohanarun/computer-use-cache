#!/usr/bin/env python3
"""
Standalone OpenAI/OpenRouter-compatible completions proxy with a SQLite cache.

This is intentionally independent from the production app server. It
keeps only the code-model response cache behavior and strips app auth, billing,
credits, tools, and product-specific model catalog logic.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Any, Dict, Iterator, List, Optional, Tuple

import requests
from flask import Flask, Response, jsonify, request, stream_with_context


FALSE_VALUES = {"0", "false", "no", "off"}
TRUE_VALUES = {"1", "true", "yes", "on"}

DEFAULT_UPSTREAM_BASE_URL = "https://openrouter.ai/api/v1"
CACHE_CONTROL_KEYS = {"stream", "cache", "cache_control"}
DEFAULT_CACHE_IGNORE_KEYS = {"metadata"}
SENSITIVE_PATTERN = re.compile(
    r"(?i)(api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token|private[_-]?key)"
    r"\s*[:=]\s*['\"]?[^'\"\s]{8,}"
)


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    return default


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)) or default)
    except Exception:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)) or default)
    except Exception:
        return default


def env_list(name: str) -> List[str]:
    raw = os.environ.get(name, "")
    return [part.strip() for part in raw.split(",") if part.strip()]


UPSTREAM_BASE_URL = (
    os.environ.get("UPSTREAM_BASE_URL")
    or os.environ.get("OPENAI_BASE_URL")
    or DEFAULT_UPSTREAM_BASE_URL
).rstrip("/")
UPSTREAM_API_KEY = (
    os.environ.get("UPSTREAM_API_KEY")
    or os.environ.get("OPENROUTER_API_KEY")
    or os.environ.get("OPENAI_API_KEY")
    or ""
).strip()
UPSTREAM_TIMEOUT_SECONDS = env_float("UPSTREAM_TIMEOUT_SECONDS", 180.0)

CACHE_DB_PATH = os.environ.get(
    "CACHE_DB_PATH",
    os.path.join(os.getcwd(), "code_model_cache.sqlite3"),
)
CACHE_ENABLED_DEFAULT = env_bool("CACHE_ENABLED", True)
CACHE_TTL_SECONDS = env_int("CACHE_TTL_SECONDS", 60 * 60 * 24 * 30)
CACHE_MAX_INPUT_CHARS = env_int("CACHE_MAX_INPUT_CHARS", 120_000)
CACHE_MAX_RESPONSE_CHARS = env_int("CACHE_MAX_RESPONSE_CHARS", 240_000)
CACHE_MODEL_ALLOWLIST = env_list("CACHE_MODEL_ALLOWLIST")
CACHE_MODEL_DENYLIST = env_list("CACHE_MODEL_DENYLIST")
CACHE_IGNORE_KEYS = set(DEFAULT_CACHE_IGNORE_KEYS)
CACHE_IGNORE_KEYS.update(env_list("CACHE_IGNORE_KEYS"))
INCLUDE_CACHE_METADATA = env_bool("INCLUDE_CACHE_METADATA", False)
CACHE_ADMIN_TOKEN = os.environ.get("CACHE_ADMIN_TOKEN", "").strip()


app = Flask(__name__)


def now_seconds() -> float:
    return time.time()


def current_unix_time() -> int:
    return int(now_seconds())


def compact_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def clone_json(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def normalize_json(value: Any, string_limit: int = CACHE_MAX_INPUT_CHARS) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) > string_limit:
            return value[:string_limit]
        return value
    if isinstance(value, list):
        return [normalize_json(item, string_limit=string_limit) for item in value]
    if isinstance(value, dict):
        return {
            str(key): normalize_json(value[key], string_limit=string_limit)
            for key in sorted(value.keys(), key=lambda item: str(item))
        }
    return str(value)


def openai_error(
    message: str,
    status: int = 400,
    error_type: str = "invalid_request_error",
    code: Optional[str] = None,
) -> Tuple[Response, int]:
    return jsonify({
        "error": {
            "message": message,
            "type": error_type,
            "param": None,
            "code": code,
        }
    }), status


def bearer_from_request() -> str:
    header = request.headers.get("Authorization", "")
    if header.lower().startswith("bearer "):
        return header.split(" ", 1)[1].strip()
    return ""


def upstream_headers() -> Dict[str, str]:
    token = UPSTREAM_API_KEY or bearer_from_request()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    referer = os.environ.get("OPENROUTER_HTTP_REFERER") or request.headers.get("HTTP-Referer")
    title = os.environ.get("OPENROUTER_X_TITLE") or request.headers.get("X-Title")
    if referer:
        headers["HTTP-Referer"] = referer
    if title:
        headers["X-Title"] = title
    return headers


def upstream_url(path: str) -> str:
    return f"{UPSTREAM_BASE_URL}{path}"


def model_matches(model: str, patterns: List[str]) -> bool:
    if not patterns:
        return False
    normalized = model.strip()
    return any(fnmatch.fnmatch(normalized, pattern) for pattern in patterns)


def model_is_cacheable(model: str) -> bool:
    if model_matches(model, CACHE_MODEL_DENYLIST):
        return False
    if CACHE_MODEL_ALLOWLIST and not model_matches(model, CACHE_MODEL_ALLOWLIST):
        return False
    return True


def request_cache_enabled(data: Dict[str, Any]) -> bool:
    if "cache" in data:
        return env_bool_from_value(data.get("cache"), CACHE_ENABLED_DEFAULT)
    cache_control = data.get("cache_control")
    if isinstance(cache_control, dict) and "enabled" in cache_control:
        return env_bool_from_value(cache_control.get("enabled"), CACHE_ENABLED_DEFAULT)
    metadata = data.get("metadata")
    if isinstance(metadata, dict):
        if "cache" in metadata:
            return env_bool_from_value(metadata.get("cache"), CACHE_ENABLED_DEFAULT)
        if "cache_enabled" in metadata:
            return env_bool_from_value(metadata.get("cache_enabled"), CACHE_ENABLED_DEFAULT)
    return CACHE_ENABLED_DEFAULT


def env_bool_from_value(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    normalized = str(value).strip().lower()
    if normalized in TRUE_VALUES:
        return True
    if normalized in FALSE_VALUES:
        return False
    return default


def normalized_cache_input(data: Dict[str, Any], mode: str) -> Tuple[Optional[str], Optional[Dict[str, Any]], str]:
    if not isinstance(data, dict):
        return None, None, "request body must be an object"
    model = str(data.get("model") or "").strip()
    if not model:
        return None, None, "model is required"
    if not model_is_cacheable(model):
        return None, None, f"model is not cacheable: {model}"

    payload: Dict[str, Any] = {"mode": mode}
    ignored = CACHE_CONTROL_KEYS | CACHE_IGNORE_KEYS
    for key in sorted(data.keys(), key=lambda item: str(item)):
        if str(key) in ignored:
            continue
        payload[str(key)] = normalize_json(data[key])

    payload_json = compact_json(payload)
    if len(payload_json) > CACHE_MAX_INPUT_CHARS:
        return None, None, "request is too large for cache"
    if SENSITIVE_PATTERN.search(payload_json):
        return None, None, "request appears to contain credentials or secrets"
    cache_key = hashlib.sha256(payload_json.encode("utf-8", errors="ignore")).hexdigest()
    payload["cache_key"] = cache_key
    return cache_key, payload, ""


def response_cache_payload(payload: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    if not isinstance(payload, dict):
        return None, "response is not a JSON object"
    clone = clone_json(payload)
    if isinstance(clone, dict):
        clone.pop("code_model_cache", None)
    response_json = compact_json(clone)
    if len(response_json) > CACHE_MAX_RESPONSE_CHARS:
        return None, "response is too large for cache"
    return clone, ""


class CompletionCache:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.RLock()
        self._ensure_schema()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        directory = os.path.dirname(os.path.abspath(self.path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=30000")
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS completions (
                    cache_key TEXT PRIMARY KEY,
                    mode TEXT NOT NULL,
                    model TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    last_hit_at REAL,
                    hits INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_completions_model ON completions(model)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_completions_updated ON completions(updated_at)")

    def lookup(self, cache_key: str) -> Optional[Dict[str, Any]]:
        if not cache_key:
            return None
        now = now_seconds()
        with self.lock:
            with self.connect() as conn:
                row = conn.execute(
                    "SELECT * FROM completions WHERE cache_key = ?",
                    (cache_key,),
                ).fetchone()
                if not row:
                    return None
                created_at = float(row["created_at"] or 0.0)
                if CACHE_TTL_SECONDS > 0 and now - created_at > CACHE_TTL_SECONDS:
                    conn.execute("DELETE FROM completions WHERE cache_key = ?", (cache_key,))
                    return None
                conn.execute(
                    "UPDATE completions SET hits = hits + 1, last_hit_at = ? WHERE cache_key = ?",
                    (now, cache_key),
                )
                return {
                    "cache_key": row["cache_key"],
                    "mode": row["mode"],
                    "model": row["model"],
                    "request": json.loads(row["request_json"]),
                    "response": json.loads(row["response_json"]),
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                    "hits": int(row["hits"] or 0) + 1,
                }

    def store(self, cache_key: str, mode: str, request_payload: Dict[str, Any], response_payload: Dict[str, Any]) -> str:
        response_for_cache, reason = response_cache_payload(response_payload)
        if not response_for_cache:
            return f"skipped: {reason}"
        now = now_seconds()
        model = str(request_payload.get("model") or response_for_cache.get("model") or "").strip()
        request_json = compact_json(request_payload)
        response_json = compact_json(response_for_cache)
        with self.lock:
            with self.connect() as conn:
                existing = conn.execute(
                    "SELECT cache_key FROM completions WHERE cache_key = ?",
                    (cache_key,),
                ).fetchone()
                if existing:
                    conn.execute(
                        """
                        UPDATE completions
                        SET mode = ?, model = ?, request_json = ?, response_json = ?, updated_at = ?
                        WHERE cache_key = ?
                        """,
                        (mode, model, request_json, response_json, now, cache_key),
                    )
                    return "updated"
                conn.execute(
                    """
                    INSERT INTO completions (
                        cache_key, mode, model, request_json, response_json, created_at, updated_at, last_hit_at, hits
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
                    """,
                    (cache_key, mode, model, request_json, response_json, now, now),
                )
                return "stored"

    def stats(self) -> Dict[str, Any]:
        with self.lock:
            with self.connect() as conn:
                row = conn.execute(
                    """
                    SELECT
                        COUNT(*) AS entries,
                        COALESCE(SUM(hits), 0) AS hits,
                        MAX(updated_at) AS last_updated_at
                    FROM completions
                    """
                ).fetchone()
                return {
                    "entries": int(row["entries"] or 0),
                    "hits": int(row["hits"] or 0),
                    "last_updated_at": row["last_updated_at"],
                    "db_path": self.path,
                    "ttl_seconds": CACHE_TTL_SECONDS,
                }

    def clear(self) -> int:
        with self.lock:
            with self.connect() as conn:
                row = conn.execute("SELECT COUNT(*) AS entries FROM completions").fetchone()
                count = int(row["entries"] or 0)
                conn.execute("DELETE FROM completions")
                return count


cache = CompletionCache(CACHE_DB_PATH)


@app.after_request
def add_cors_headers(response: Response) -> Response:
    response.headers.setdefault("Access-Control-Allow-Origin", os.environ.get("CORS_ALLOW_ORIGIN", "*"))
    response.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    response.headers.setdefault(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-Cache-Bypass, X-Cache-Admin-Token",
    )
    return response


@app.route("/", methods=["GET"])
def root() -> Response:
    return jsonify({
        "name": "computer-use-cache",
        "status": "ok",
        "upstream_base_url": UPSTREAM_BASE_URL,
        "endpoints": [
            "/v1/chat/completions",
            "/chat/completions",
            "/v1/completions",
            "/v1/models",
            "/cache/stats",
        ],
    })


@app.route("/healthz", methods=["GET"])
def healthz() -> Response:
    return jsonify({
        "ok": True,
        "cache": cache.stats(),
        "upstream_base_url": UPSTREAM_BASE_URL,
    })


def require_admin() -> Optional[Tuple[Response, int]]:
    if not CACHE_ADMIN_TOKEN:
        return None
    provided = request.headers.get("X-Cache-Admin-Token", "").strip()
    if not provided:
        provided = bearer_from_request()
    if provided != CACHE_ADMIN_TOKEN:
        return openai_error("Invalid cache admin token.", 401, "authentication_error", "invalid_api_key")
    return None


@app.route("/cache/stats", methods=["GET"])
def cache_stats() -> Response:
    return jsonify(cache.stats())


@app.route("/cache/clear", methods=["POST"])
def cache_clear() -> Response:
    admin_error = require_admin()
    if admin_error:
        return admin_error
    deleted = cache.clear()
    return jsonify({"ok": True, "deleted": deleted})


def extract_text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item.get("text") or "")
                elif item.get("type") == "text" and isinstance(item.get("content"), str):
                    parts.append(item.get("content") or "")
        return "".join(parts)
    return ""


def completion_text(response_payload: Dict[str, Any]) -> str:
    choices = response_payload.get("choices") if isinstance(response_payload.get("choices"), list) else []
    choice = choices[0] if choices and isinstance(choices[0], dict) else {}
    if isinstance(choice.get("text"), str):
        return choice.get("text") or ""
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    return extract_text_content(message.get("content"))


def add_cache_metadata(
    payload: Dict[str, Any],
    cache_hit: bool,
    cache_key: Optional[str],
    store_status: str = "",
    bypass_reason: str = "",
) -> Dict[str, Any]:
    clone = clone_json(payload)
    if INCLUDE_CACHE_METADATA:
        clone["code_model_cache"] = {
            "cache_hit": bool(cache_hit),
            "cache_key": cache_key,
            "store_status": store_status or None,
            "bypass_reason": bypass_reason or None,
        }
    return clone


def sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def cached_stream_response(payload: Dict[str, Any], mode: str, cache_key: str) -> Response:
    def generate() -> Iterator[str]:
        completion_id = str(payload.get("id") or f"chatcmpl-cache-{uuid.uuid4().hex[:16]}")
        created = int(payload.get("created") or current_unix_time())
        model = str(payload.get("model") or "")
        text = completion_text(payload)
        choices = payload.get("choices") if isinstance(payload.get("choices"), list) else []
        first_choice = choices[0] if choices and isinstance(choices[0], dict) else {}
        finish_reason = first_choice.get("finish_reason") or "stop"

        if mode == "completion":
            yield sse({
                "id": completion_id,
                "object": "text_completion.chunk",
                "created": created,
                "model": model,
                "choices": [{
                    "index": 0,
                    "text": text,
                    "logprobs": first_choice.get("logprobs"),
                    "finish_reason": None,
                }],
            })
            yield sse({
                "id": completion_id,
                "object": "text_completion.chunk",
                "created": created,
                "model": model,
                "choices": [{
                    "index": 0,
                    "text": "",
                    "logprobs": None,
                    "finish_reason": finish_reason,
                }],
            })
            yield "data: [DONE]\n\n"
            return

        yield sse({
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
        })
        if text:
            yield sse({
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
            })
        yield sse({
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
        })
        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Code-Model-Cache": "HIT",
            "X-Code-Model-Cache-Key": cache_key,
        },
    )


def proxy_stream(path: str, data: Dict[str, Any], cache_status: str, bypass_reason: str) -> Response:
    upstream = requests.post(
        upstream_url(path),
        headers=upstream_headers(),
        json=data,
        timeout=UPSTREAM_TIMEOUT_SECONDS,
        stream=True,
    )

    def generate() -> Iterator[bytes]:
        try:
            for chunk in upstream.iter_content(chunk_size=None):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    headers = {
        "X-Code-Model-Cache": cache_status,
        "X-Code-Model-Cache-Bypass-Reason": bypass_reason,
        "Cache-Control": "no-cache",
    }
    content_type = upstream.headers.get("Content-Type")
    if content_type:
        headers["Content-Type"] = content_type
    return Response(
        stream_with_context(generate()),
        status=upstream.status_code,
        headers=headers,
    )


def upstream_json_response(path: str, data: Dict[str, Any]) -> requests.Response:
    return requests.post(
        upstream_url(path),
        headers=upstream_headers(),
        json=data,
        timeout=UPSTREAM_TIMEOUT_SECONDS,
    )


def upstream_models_response(path: str) -> requests.Response:
    return requests.get(
        upstream_url(path),
        headers=upstream_headers(),
        timeout=UPSTREAM_TIMEOUT_SECONDS,
    )


def passthrough_response(upstream: requests.Response, cache_status: str = "BYPASS", bypass_reason: str = "") -> Response:
    response = Response(
        upstream.content,
        status=upstream.status_code,
        content_type=upstream.headers.get("Content-Type", "application/json"),
    )
    response.headers["X-Code-Model-Cache"] = cache_status
    if bypass_reason:
        response.headers["X-Code-Model-Cache-Bypass-Reason"] = bypass_reason
    return response


def validate_body(mode: str, data: Any) -> Optional[Tuple[Response, int]]:
    if not isinstance(data, dict):
        return openai_error("Request body must be JSON.", 400)
    if not str(data.get("model") or "").strip():
        return openai_error("model is required.", 400)
    if mode == "chat":
        messages = data.get("messages")
        if not isinstance(messages, list) or not messages:
            return openai_error("messages must be a non-empty array.", 400)
    if mode == "completion" and "prompt" not in data:
        return openai_error("prompt is required.", 400)
    return None


def should_bypass_cache(data: Dict[str, Any], mode: str) -> Tuple[bool, Optional[str], Optional[Dict[str, Any]], str]:
    if request.headers.get("X-Cache-Bypass", "").strip().lower() in TRUE_VALUES:
        return True, None, None, "X-Cache-Bypass requested"
    if not request_cache_enabled(data):
        return True, None, None, "cache disabled for request"
    cache_key, cache_payload, reason = normalized_cache_input(data, mode)
    if not cache_key or not cache_payload:
        return True, None, None, reason or "request is not cacheable"
    return False, cache_key, cache_payload, ""


def handle_completion(path: str, mode: str) -> Response:
    data = request.get_json(silent=True)
    validation_error = validate_body(mode, data)
    if validation_error:
        return validation_error

    assert isinstance(data, dict)
    requested_stream = env_bool_from_value(data.get("stream"), False)
    bypass, cache_key, cache_payload, bypass_reason = should_bypass_cache(data, mode)

    if not bypass and cache_key:
        cached_entry = cache.lookup(cache_key)
        if cached_entry and isinstance(cached_entry.get("response"), dict):
            cached_payload = add_cache_metadata(cached_entry["response"], True, cache_key)
            if requested_stream:
                return cached_stream_response(cached_payload, mode, cache_key)
            response = jsonify(cached_payload)
            response.headers["X-Code-Model-Cache"] = "HIT"
            response.headers["X-Code-Model-Cache-Key"] = cache_key
            return response

    if requested_stream:
        reason = bypass_reason or "stream miss is proxied without cache write"
        return proxy_stream(path, data, "BYPASS" if bypass else "MISS", reason)

    try:
        upstream = upstream_json_response(path, data)
    except requests.RequestException as exc:
        return openai_error(str(exc), 502, "upstream_error", "upstream_request_failed")

    if upstream.status_code < 200 or upstream.status_code >= 300:
        return passthrough_response(upstream, "BYPASS", "upstream returned an error")

    try:
        payload = upstream.json()
    except ValueError:
        return passthrough_response(upstream, "BYPASS", "upstream response was not JSON")

    store_status = ""
    response_payload = payload
    if not bypass and cache_key and cache_payload:
        store_status = cache.store(cache_key, mode, cache_payload, payload)
        response_payload = add_cache_metadata(payload, False, cache_key, store_status=store_status)
    else:
        response_payload = add_cache_metadata(payload, False, cache_key, bypass_reason=bypass_reason)

    response = jsonify(response_payload)
    response.headers["X-Code-Model-Cache"] = "MISS" if not bypass else "BYPASS"
    if cache_key:
        response.headers["X-Code-Model-Cache-Key"] = cache_key
    if store_status:
        response.headers["X-Code-Model-Cache-Store"] = store_status
    if bypass_reason:
        response.headers["X-Code-Model-Cache-Bypass-Reason"] = bypass_reason
    return response


@app.route("/v1/chat/completions", methods=["POST"])
@app.route("/chat/completions", methods=["POST"])
@app.route("/api/v1/chat/completions", methods=["POST"])
@app.route("/api/chat/completions", methods=["POST"])
def chat_completions() -> Response:
    return handle_completion("/chat/completions", "chat")


@app.route("/v1/completions", methods=["POST"])
@app.route("/completions", methods=["POST"])
@app.route("/api/v1/completions", methods=["POST"])
def legacy_completions() -> Response:
    return handle_completion("/completions", "completion")


@app.route("/v1/models", methods=["GET"])
@app.route("/models", methods=["GET"])
@app.route("/api/v1/models", methods=["GET"])
def models() -> Response:
    upstream_path = "/models"
    try:
        upstream = upstream_models_response(upstream_path)
    except requests.RequestException as exc:
        return openai_error(str(exc), 502, "upstream_error", "upstream_request_failed")
    return passthrough_response(upstream, "BYPASS", "model lists are not cached")


if __name__ == "__main__":
    port = env_int("PORT", 8000)
    host = os.environ.get("HOST", "0.0.0.0")
    debug = env_bool("FLASK_DEBUG", False)
    app.run(host=host, port=port, debug=debug)
