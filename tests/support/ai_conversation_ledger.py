#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Normalize ActivityWatch AI-conversation events and derive conversation visits/turns.

The regular output is a de-identified research artifact. A conversation key is
an identity, never a reopen locator.  Reopen availability requires a separate,
strictly validated opaque-locator sidecar.  Historical raw URLs/IDs can still
be read into an explicitly requested private legacy artifact, but never make a
conversation executable/reopenable by themselves.
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import tempfile
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

PLATFORM_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PLATFORM_DIR not in sys.path:
    sys.path.insert(0, PLATFORM_DIR)

from capture_window import (  # noqa: E402
    BOUNDARY,
    CaptureWindow,
    CaptureWindowError,
    build_events_url,
    format_utc,
    parse_aware_datetime,
    point_in_window,
    read_capture_window,
)


# The support ledger keeps its stable de-identified output contract at 1.0,
# while dual-reading both producer schemas during the 1.1 turn-link rollout.
SCHEMA_VERSION = "1.0"
SUPPORTED_SOURCE_SCHEMA_VERSIONS = frozenset({"1.0", "1.1"})
TURN_LINK_SOURCE_SCHEMA_VERSION = "1.1"
TURN_LINK_EVENT_TYPES = frozenset(
    {
        "prompt_submitted",
        "assistant_response_started",
        "assistant_response_completed",
        "assistant_response_failed",
        "assistant_response_cancelled",
    }
)
TURN_LINK_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
AI_BUCKET_PREFIXES = (
    "aw-watcher-ai-conversation",
    "aw-watcher-ai-chat",
    "aw-watcher-chatgpt",
    "aw-watcher-claude",
    "aw-watcher-ai-macos",
)
AI_BUCKET_TYPES = {
    "ai.conversation.event",
    "ai.conversation.events",
    "ai-conversation-event",
    "ai_conversation_event",
    "ai.activity.macos",
}
SOURCE_EVENT_TYPES = {
    "watcher_started",
    "watcher_heartbeat",
    "watcher_stopped",
    "adapter_unhealthy",
    "adapter_recovered",
}
ACTIVATION_EVENTS = {
    "conversation_foregrounded",
    "user_returned",
    "user_engaged",
    "user_interacted",
    "input_started",
    "prompt_submitted",
}
DEACTIVATION_EVENTS = {"conversation_backgrounded"}
ENGAGEMENT_BASIS_EVENTS = {"input_started", "prompt_submitted"}
RESPONSE_TERMINAL_EVENTS = {
    "assistant_response_completed": "completed",
    "assistant_response_failed": "failed",
    "assistant_response_cancelled": "cancelled",
}
EVENT_ALIASES = {
    "tracker_started": "watcher_started",
    "tracker_heartbeat": "watcher_heartbeat",
    "tracker_stopped": "watcher_stopped",
    "heartbeat": "watcher_heartbeat",
    "conversation_observed": "conversation_foregrounded",
    "conversation_opened": "conversation_foregrounded",
    "conversation_activated": "conversation_foregrounded",
    "conversation_focused": "conversation_foregrounded",
    "conversation_viewed": "conversation_foregrounded",
    "app_foreground": "conversation_foregrounded",
    "app_foregrounded": "conversation_foregrounded",
    "app_became_active": "conversation_foregrounded",
    "conversation_deactivated": "conversation_backgrounded",
    "conversation_blurred": "conversation_backgrounded",
    "conversation_closed": "conversation_backgrounded",
    "app_background": "conversation_backgrounded",
    "app_backgrounded": "conversation_backgrounded",
    "app_resigned_active": "conversation_backgrounded",
    "response_started": "assistant_response_started",
    "generation_started": "assistant_response_started",
    "response_completed": "assistant_response_completed",
    "generation_completed": "assistant_response_completed",
    "response_done": "assistant_response_completed",
    "response_failed": "assistant_response_failed",
    "generation_failed": "assistant_response_failed",
    "response_error": "assistant_response_failed",
    "response_cancelled": "assistant_response_cancelled",
    "generation_cancelled": "assistant_response_cancelled",
    "generation_canceled": "assistant_response_cancelled",
    "response_canceled": "assistant_response_cancelled",
    "response_aborted": "assistant_response_cancelled",
    "composer_became_nonempty": "input_started",
    "composer_nonempty": "input_started",
    "submit_inferred": "prompt_submitted",
    "prompt_submitted_inferred": "prompt_submitted",
    "generating_started": "assistant_response_started",
    "response_started_inferred": "assistant_response_started",
    "response_completed_inferred": "assistant_response_completed",
    "response_failed_inferred": "assistant_response_failed",
    "response_cancelled_inferred": "assistant_response_cancelled",
    "user_interaction": "user_interacted",
    "message_sent": "prompt_submitted",
    "prompt_sent": "prompt_submitted",
    "user_message_sent": "prompt_submitted",
    "user_prompt_submitted": "prompt_submitted",
    "user_submitted": "prompt_submitted",
    "typing_started": "input_started",
    "composer_input_started": "input_started",
    "input_began": "input_started",
    "notification_shown": "tracker_notification_shown",
    "reply_notification_shown": "tracker_notification_shown",
    "conversation_alias_bound": "conversation_bound",
    "identity_bound": "conversation_bound",
    "conversation_active": "conversation_foregrounded",
    "conversation_focus": "conversation_foregrounded",
    "conversation_blur": "conversation_backgrounded",
}
PROVIDER_ALIASES = {
    "openai": "chatgpt",
    "chat_gpt": "chatgpt",
    "anthropic": "claude",
}
SURFACE_ALIASES = {
    "web": "chrome",
    "chrome_web": "chrome",
    "browser": "chrome",
    "desktop": "macos_app",
    "desktop_app": "macos_app",
    "mac_app": "macos_app",
    "native_app": "macos_app",
}
REASON_CODE_VALUES = {
    # 08 Chrome adapter.
    "identity_bound_to_existing_conversation",
    "new_submission_before_previous_terminal",
    "navigation_while_response_in_progress",
    "provider_error_control",
    "provider_error_control_visible",
    "required_composer_missing",
    "required_composer_or_send_control_missing",
    "response_completed_while_hidden",
    "response_active_scope_unverified",
    "response_start_signal_timeout",
    "route_identity_resolution_failed",
    "notification_timeout",
    "notifications_disabled",
    "study_session_inactive",
    "response_session_not_authorized",
    "response_completed_while_foreground",
    "unknown",
    # 10 macOS adapter.
    "accessibility_not_authorized",
    "accessibility_tree_unreadable",
    "participant_specific_bundle_mapping_requires_validation",
    "target_not_running",
    "ui_primitives_not_found",
    "unspecified",
    "window_changed_during_active_generation",
}
SAFE_METADATA_ENUMS = {
    "action": {
        "activated_existing_tab",
        "opened_in_original_window",
        "opened_in_new_window",
        "focus_failed",
    },
    "adapter_health": {"starting", "healthy", "unhealthy", "unknown"},
    "completion_signal": {
        "assistant_response_structure_quiet",
        "response_active_marker_disappeared_after_settle",
        "stop_control_disappeared",
        "stop_control_disappeared_after_settle",
    },
    "completion_visibility": {"background", "foreground"},
    "generation_state": {
        "response_in_progress_at_navigation",
        "response_observation_incomplete_at_new_submission",
    },
    "reason_code": REASON_CODE_VALUES,
    "error_code": {
        "identity_not_exact",
        "notification_create_failed",
        "notification_icon_load_failed",
        "notification_target_storage_failed",
    },
    "phase": {"gate", "validate_context", "create", "store_target", "focus", "clear"},
    "previous_reason_code": REASON_CODE_VALUES,
    "route_pattern": {"/c/<id>", "/chat/<id>"},
    "signal": {
        # 08 Chrome adapter.
        "click",
        "click_scroll_or_input",
        "assistant_response_container_added",
        "assistant_response_structure_quiet",
        "composer_empty_to_nonempty",
        "composer_enter",
        "composer_form_submitted",
        "composer_input",
        "conversation_switch",
        "document_visibility",
        "document_visible",
        "input_started",
        "pointer_or_keyboard",
        "prompt_submitted",
        "response_active_marker_appeared",
        "response_active_marker_disappeared_after_settle",
        "scroll",
        "send_control_clicked",
        "sixty_second_alarm",
        "spa_identity_binding",
        "spa_route_change",
        "stop_control_appeared",
        "stop_control_clicked",
        "stop_control_disappeared",
        "stop_control_disappeared_after_settle",
        "submit_control",
        "window_focus",
        "worker_initialized",
        # 10 macOS adapter.
        "composer_nonempty_to_empty",
        "generating_control_appeared",
        "generating_control_disappeared",
    },
    "state_transition": {
        # 08 Chrome adapter.
        "background_to_foreground",
        "background_to_returned",
        "draft_to_submitted",
        "empty_to_nonempty",
        "foreground_to_background",
        "initial_foreground",
        "provisional_to_exact",
        "responding_to_cancelled",
        "responding_to_completed",
        "responding_to_failed",
        "returned_to_engaged",
        "returned_to_interacted",
        "submitted_to_responding",
        # 10 macOS adapter.
        "app_activated",
        "app_deactivated",
        "app_exited",
        "app_restarted",
        "app_variant_changed",
        "same_ephemeral_window_returned",
        "same_exact_conversation_returned",
        "same_provisional_conversation_returned",
        "window_changed",
    },
    "visibility": {"hidden", "visible"},
    "identity_scope": {
        "accessibility_window",
        "focus_session",
        "provider_conversation",
        "provider_conversation_pending",
        "unknown",
    },
    "conversation_continuity": {
        "provider_conversation",
        "provider_conversation_pending",
        "window_or_focus_session_only",
    },
    "composer_state": {"empty", "nonempty", "unknown"},
    "generating_state": {"active", "inactive", "unknown"},
    "source_health": {"running", "stopped"},
    # Values emitted only by this ledger if its output is intentionally re-read.
    "event_origin": {"derived"},
    "derivation": {"visit_reentry", "post_return_action"},
    "bundle_id": {
        "com.anthropic.claudefordesktop",
        "com.openai.chat",
        "com.openai.chatgpt",
        "com.openai.codex",
    },
}
SAFE_METADATA_BOOLEAN_KEYS = {"deduplicated", "focus_succeeded"}
SAFE_METADATA_INTEGER_VALUES = {
    # Chrome watcher <=0.2.3 used 8 seconds; 0.2.4+ uses 20 seconds.
    # Keep both exact values readable without accepting invented intermediates.
    "timeout_seconds": {8, 20},
}
SAFE_METADATA_INTEGER_RANGES = {
    "attempt_count": (0, 1_000_000),
    "dropped_event_count": (0, 1_000_000),
    "queue_depth": (0, 1_000_000),
    "unhealthy_count": (0, 1_000_000),
}
SAFE_METADATA_HASH_PATTERNS = {
    "basis_event_id": re.compile(r"^evt_[0-9a-f]{20}$"),
    "visit_id": re.compile(r"^visit_[0-9a-f]{20}$"),
}
NOTIFICATION_ID_PATTERN = re.compile(
    r"^chi27-ai-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
SUPPRESSED_METADATA_KEYS = frozenset({"phase", "reason_code"})
SUPPRESSED_REASON_CODES = frozenset(
    {
        "notifications_disabled",
        "study_session_inactive",
        "response_session_not_authorized",
        "response_completed_while_foreground",
    }
)
SAFE_OUTPUT_FILES = (
    "ai_conversation_events.jsonl",
    "ai_conversations.csv",
    "ai_visits.csv",
    "ai_turns.csv",
    "ai_source_health.json",
    "ai_coverage.csv",
)
REGULAR_OUTPUT_ALLOWLIST = set(SAFE_OUTPUT_FILES) | {
    "capture_window.json",
    "timeline.csv",
    "web_domains.csv",
    "terminal_ai_events.csv",
    "terminal_ai_turns.csv",
    "combined_timeline.csv",
    "pipeline_health.json",
    "_terminal_raw_work.csv",
    "_codex_turns_tmp.csv",
}
PRIVATE_OUTPUT_ALLOWLIST = {
    "ai_conversation_locators_private.csv",
    "private_artifact_manifest.json",
}
PRIVATE_LOCATOR_SIDECAR_SCHEMA_VERSION = "1.0"
PRIVATE_LOCATOR_SIDECAR_MAX_BYTES = 1024 * 1024
PRIVATE_LOCATOR_SIDECAR_MAX_ROWS = 10_000
PRIVATE_LOCATOR_TOP_LEVEL_KEYS = frozenset({"schema_version", "locators"})
PRIVATE_LOCATOR_REQUIRED_KEYS = frozenset(
    {
        "conversation_key",
        "locator_handle",
        "provider",
        "namespace_generation",
        "namespace_fingerprint",
        "actuator_kind",
    }
)
PRIVATE_LOCATOR_OPTIONAL_KEYS = frozenset()
EXACT_CONVERSATION_KEY_PATTERN = re.compile(r"^[0-9a-f]{64}$")
OPAQUE_LOCATOR_HANDLE_PATTERN = re.compile(
    r"^loc_[A-Za-z0-9_-]{22}$"
)
REOPEN_URL_PREFIX = "chi27-ai-reopen://open/"
NAMESPACE_FINGERPRINT_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$"
)
PRIVATE_LOCATOR_PROVIDERS = frozenset({"chatgpt", "claude"})
PRIVATE_LOCATOR_ACTUATOR_KINDS = frozenset(
    {
        "browser_url",
        "claude_custom_scheme",
        "chatgpt_unified_apple_event",
    }
)
PRIVATE_LOCATOR_ACTUATOR_CONTRACT = {
    ("chatgpt", "chrome"): "browser_url",
    ("claude", "chrome"): "browser_url",
    ("claude", "macos_app"): "claude_custom_scheme",
    ("chatgpt", "macos_app"): "chatgpt_unified_apple_event",
}
PRIVATE_LOCATOR_SURFACE_BY_ACTUATOR = {
    "browser_url": "chrome",
    "claude_custom_scheme": "macos_app",
    "chatgpt_unified_apple_event": "macos_app",
}
DEPRECATED_PRIVATE_URL_FLAG_MESSAGE = (
    "拒绝 --include-private-ai-urls：raw URL/ID 导出已停用；"
    "请改用 --include-private-locators 与 --private-locator-sidecar。\n"
)


class PrivateLocatorSemanticError(ValueError):
    """A closed-schema sidecar value that cannot authorize an actuator."""


def parse_time(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def canonical_token(value):
    text = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    while "__" in text:
        text = text.replace("__", "_")
    return text


def snake_key(value):
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(value or ""))
    return canonical_token(text)


def safe_hash(prefix, *parts, length=20):
    raw = "\x1f".join(str(p) for p in parts)
    return "%s_%s" % (prefix, hashlib.sha256(raw.encode("utf-8")).hexdigest()[:length])


def sanitize_metadata(value):
    """Return content-free metadata plus generic, non-reflective issue codes.

    Keys alone are insufficient: every accepted value must also match an enum,
    a scalar type/range, or a narrow identifier pattern. Issue codes never echo
    the rejected key or value.
    """
    if not isinstance(value, dict):
        return {}, ["metadata_sanitization_invalid_shape"]
    clean = {}
    issues = []
    for key, item in value.items():
        name = snake_key(key)
        if name in SAFE_METADATA_ENUMS:
            if isinstance(item, str) and item in SAFE_METADATA_ENUMS[name]:
                clean[name] = item
            else:
                issues.append("metadata_sanitization_invalid_value")
        elif name in SAFE_METADATA_BOOLEAN_KEYS:
            if isinstance(item, bool):
                clean[name] = item
            else:
                issues.append("metadata_sanitization_invalid_value")
        elif name == "observation_gap":
            if item is True or item == "true":
                clean[name] = item
            else:
                issues.append("metadata_sanitization_invalid_value")
        elif name in SAFE_METADATA_INTEGER_VALUES:
            if (
                isinstance(item, int)
                and not isinstance(item, bool)
                and item in SAFE_METADATA_INTEGER_VALUES[name]
            ):
                clean[name] = item
            else:
                issues.append("metadata_sanitization_invalid_value")
        elif name in SAFE_METADATA_INTEGER_RANGES:
            lower, upper = SAFE_METADATA_INTEGER_RANGES[name]
            if (
                isinstance(item, int)
                and not isinstance(item, bool)
                and lower <= item <= upper
            ):
                clean[name] = item
            else:
                issues.append("metadata_sanitization_invalid_value")
        elif name in SAFE_METADATA_HASH_PATTERNS:
            if isinstance(item, str) and SAFE_METADATA_HASH_PATTERNS[name].fullmatch(item):
                clean[name] = item
            else:
                issues.append("metadata_sanitization_invalid_value")
        elif name == "notification_id":
            if isinstance(item, str) and NOTIFICATION_ID_PATTERN.fullmatch(item):
                clean[name] = item
            else:
                issues.append("metadata_sanitization_invalid_value")
        else:
            issues.append("metadata_sanitization_unknown_key")
    return clean, sorted(set(issues))


def sanitize_event_metadata(event_type, value):
    """Apply event-specific metadata contracts after generic sanitization."""
    clean, issues = sanitize_metadata(value)
    if event_type != "tracker_notification_suppressed":
        return clean, issues
    if not isinstance(value, dict):
        return {}, issues

    projection = {}
    if value.get("phase") == "gate":
        projection["phase"] = "gate"
    if value.get("reason_code") in SUPPRESSED_REASON_CODES:
        projection["reason_code"] = value["reason_code"]
    if (
        frozenset(value) != SUPPRESSED_METADATA_KEYS
        or projection.get("phase") != "gate"
        or projection.get("reason_code") not in SUPPRESSED_REASON_CODES
    ):
        issues.append("metadata_sanitization_event_contract")
    return projection, sorted(set(issues))


def real_paths_overlap(first, second):
    first_real = os.path.realpath(os.path.abspath(first))
    second_real = os.path.realpath(os.path.abspath(second))
    try:
        common = os.path.commonpath([first_real, second_real])
    except ValueError:
        return False
    return common == first_real or common == second_real


def unknown_entries(path, allowlist):
    if not os.path.isdir(path):
        return []
    return sorted(name for name in os.listdir(path) if name not in allowlist)


def load_private_locator_sidecar(path):
    """Load a content-free opaque locator sidecar with a closed schema.

    The error text deliberately reports only a row number and generic reason;
    it never echoes a handle, key, namespace fingerprint, URL, or provider ID.
    Semantic matching to observed exact events happens later in
    ``build_private_locators``.
    """
    if os.path.islink(path):
        raise ValueError("private locator sidecar 不得是符号链接")
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        raise ValueError("private locator sidecar 无法读取") from exc
    if size <= 0 or size > PRIVATE_LOCATOR_SIDECAR_MAX_BYTES:
        raise ValueError("private locator sidecar 大小不合法")
    def closed_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("private locator sidecar 含重复 JSON 字段")
            result[key] = value
        return result

    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle, object_pairs_hook=closed_object)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("private locator sidecar 不是有效 UTF-8 JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("private locator sidecar 顶层必须是对象")
    if frozenset(payload) != PRIVATE_LOCATOR_TOP_LEVEL_KEYS:
        raise ValueError("private locator sidecar 顶层字段不符合 closed schema")
    if payload.get("schema_version") != PRIVATE_LOCATOR_SIDECAR_SCHEMA_VERSION:
        raise ValueError("private locator sidecar schema_version 不受支持")
    rows = payload.get("locators")
    if not isinstance(rows, list) or len(rows) > PRIVATE_LOCATOR_SIDECAR_MAX_ROWS:
        raise ValueError("private locator sidecar locators 不是合法数组")

    normalized = []
    allowed_keys = PRIVATE_LOCATOR_REQUIRED_KEYS | PRIVATE_LOCATOR_OPTIONAL_KEYS
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError("private locator sidecar 第 %d 行不是对象" % index)
        keys = frozenset(row)
        if "actuator_kind" not in keys:
            raise PrivateLocatorSemanticError(
                "private locator sidecar 第 %d 行 actuator_kind 缺失" % index
            )
        if not PRIVATE_LOCATOR_REQUIRED_KEYS.issubset(keys) or not keys.issubset(
            allowed_keys
        ):
            raise ValueError(
                "private locator sidecar 第 %d 行字段不符合 closed schema" % index
            )
        conversation_key = row.get("conversation_key")
        locator_handle = row.get("locator_handle")
        provider = row.get("provider")
        namespace_generation = row.get("namespace_generation")
        namespace_fingerprint = row.get("namespace_fingerprint")
        actuator_kind = row.get("actuator_kind")
        if (
            not isinstance(conversation_key, str)
            or not EXACT_CONVERSATION_KEY_PATTERN.fullmatch(conversation_key)
        ):
            raise ValueError(
                "private locator sidecar 第 %d 行 conversation_key 格式不合法"
                % index
            )
        if (
            not isinstance(locator_handle, str)
            or not OPAQUE_LOCATOR_HANDLE_PATTERN.fullmatch(locator_handle)
        ):
            raise ValueError(
                "private locator sidecar 第 %d 行 locator_handle 格式不合法"
                % index
            )
        if not isinstance(provider, str) or provider not in PRIVATE_LOCATOR_PROVIDERS:
            raise PrivateLocatorSemanticError(
                "private locator sidecar 第 %d 行 provider 不受支持" % index
            )
        if (
            not isinstance(namespace_generation, int)
            or isinstance(namespace_generation, bool)
            or namespace_generation <= 0
        ):
            raise ValueError(
                "private locator sidecar 第 %d 行 namespace_generation 不合法"
                % index
            )
        if (
            not isinstance(namespace_fingerprint, str)
            or not NAMESPACE_FINGERPRINT_PATTERN.fullmatch(namespace_fingerprint)
        ):
            raise ValueError(
                "private locator sidecar 第 %d 行 namespace_fingerprint 格式不合法"
                % index
            )
        if (
            not isinstance(actuator_kind, str)
            or actuator_kind not in PRIVATE_LOCATOR_ACTUATOR_KINDS
        ):
            raise PrivateLocatorSemanticError(
                "private locator sidecar 第 %d 行 actuator_kind 不受支持"
                % index
            )
        normalized.append(
            {
                "conversation_key": conversation_key,
                "locator_handle": locator_handle,
                "provider": provider,
                "namespace_generation": namespace_generation,
                "namespace_fingerprint": namespace_fingerprint,
                "actuator_kind": actuator_kind,
            }
        )
    return normalized


def build_reopen_url(locator_handle):
    """Return the one allowed local reopen capability URL.

    Validation is intentionally repeated at the projection boundary.  This
    keeps separators, query strings, fragments, percent escapes, CSV formula
    prefixes, and alternate schemes out even if a caller bypasses the JSON
    sidecar loader and invokes ``build_private_locators`` directly.
    """
    if (
        not isinstance(locator_handle, str)
        or not OPAQUE_LOCATOR_HANDLE_PATTERN.fullmatch(locator_handle)
    ):
        raise ValueError("opaque locator handle 格式不合法")
    return REOPEN_URL_PREFIX + locator_handle


def atomic_write_text(path, text, mode=0o644):
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix="._ledger_", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.chmod(tmp_path, mode)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def write_csv(path, fieldnames, rows, mode=0o644):
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix="._ledger_", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        os.chmod(tmp_path, mode)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def bucket_is_candidate(bucket_id, bucket):
    bid = str(bucket_id or "").lower()
    btype = canonical_token(bucket.get("type", ""))
    if any(bid.startswith(prefix) for prefix in AI_BUCKET_PREFIXES):
        return True
    if btype in {canonical_token(item) for item in AI_BUCKET_TYPES}:
        return True
    for event in (bucket.get("events") or [])[:5]:
        data = event.get("data") if isinstance(event, dict) else None
        if (
            isinstance(data, dict)
            and str(data.get("schema_version"))
            in SUPPORTED_SOURCE_SCHEMA_VERSIONS
        ):
            if data.get("source_event_id") and data.get("event_type") and data.get("provider"):
                return True
    return False


def coerce_buckets(payload):
    if isinstance(payload, list):
        return {"ai-conversation-fixture": {"type": "ai.conversation.event", "events": payload}}
    if not isinstance(payload, dict):
        raise ValueError("JSON 顶层必须是对象或事件数组。")
    if isinstance(payload.get("buckets"), dict):
        return {
            str(bucket_id): {
                "type": bucket.get("type", "") if isinstance(bucket, dict) else "",
                "events": (bucket.get("events") or []) if isinstance(bucket, dict) else [],
            }
            for bucket_id, bucket in payload["buckets"].items()
        }
    if isinstance(payload.get("events"), list):
        bucket_id = str(payload.get("id") or "ai-conversation-fixture")
        return {
            bucket_id: {
                "type": payload.get("type", "ai.conversation.event"),
                "events": payload.get("events") or [],
            }
        }
    if "timestamp" in payload and isinstance(payload.get("data"), dict):
        return {
            "ai-conversation-fixture": {
                "type": "ai.conversation.event",
                "events": [payload],
            }
        }
    buckets = {}
    for bucket_id, bucket in payload.items():
        if isinstance(bucket, dict) and isinstance(bucket.get("events"), list):
            buckets[str(bucket_id)] = {
                "type": bucket.get("type", ""),
                "events": bucket.get("events") or [],
            }
    if buckets:
        return buckets
    raise ValueError("无法识别 JSON；需要 ActivityWatch 导出或合成事件 fixture。")


def load_buckets_from_file(path):
    with open(path, "r", encoding="utf-8-sig") as handle:
        text = handle.read()
    try:
        return coerce_buckets(json.loads(text))
    except json.JSONDecodeError:
        events = []
        for line_no, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError("JSONL 第 %d 行无法解析: %s" % (line_no, exc))
        return coerce_buckets(events)


TRUSTED_EMBEDDED_OBSERVATION_END_SOURCES = {
    "activitywatch_export_completed_at",
    "study_capture_stopped_at",
}


def load_embedded_observation_end(path):
    """Read an optional, explicitly provenance-tagged offline capture endpoint."""
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return None, None
    if not isinstance(payload, dict):
        return None, None
    capture = payload.get("capture_metadata")
    if not isinstance(capture, dict) or capture.get("schema_version") != SCHEMA_VERSION:
        return None, None
    source = canonical_token(capture.get("observation_end_source"))
    if source not in TRUSTED_EMBEDDED_OBSERVATION_END_SOURCES:
        return None, None
    endpoint = parse_time(capture.get("observation_end"))
    if endpoint is None:
        return None, None
    return endpoint, "embedded_%s" % source


def load_buckets_from_rest(host, start_utc=None, end_utc=None):
    import urllib.error
    import urllib.request

    def get_json(url):
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise RuntimeError("无法连接 ActivityWatch: %s" % exc)

    base = host.rstrip("/")
    listing = get_json(base + "/api/0/buckets/")
    if not isinstance(listing, dict):
        raise RuntimeError("ActivityWatch buckets API 返回格式异常。")
    buckets = {}
    for bucket_id, metadata in listing.items():
        bucket = metadata if isinstance(metadata, dict) else {}
        probe = {"type": bucket.get("type", ""), "events": []}
        if not bucket_is_candidate(bucket_id, probe):
            continue
        endpoint = build_events_url(
            base, bucket_id, start_utc=start_utc, end_utc=end_utc
        )
        events = get_json(endpoint)
        buckets[str(bucket_id)] = {
            "type": bucket.get("type", ""),
            "events": events if isinstance(events, list) else [],
        }
    return buckets


def normalize_event(outer, index):
    if not isinstance(outer, dict):
        return None, "event_%d:not_object" % index
    data = outer.get("data")
    if not isinstance(data, dict):
        return None, "event_%d:data_not_object" % index
    required = (
        "schema_version",
        "source_event_id",
        "occurred_at",
        "observed_at",
        "provider",
        "surface",
        "event_type",
        "identity_status",
        "confidence",
        "source_adapter",
        "adapter_version",
        "privacy_tier",
    )
    missing = [field for field in required if data.get(field) in (None, "")]
    if missing:
        return None, "event_%d:missing_%s" % (index, "_".join(missing))
    source_schema_version = str(data.get("schema_version"))
    if source_schema_version not in SUPPORTED_SOURCE_SCHEMA_VERSIONS:
        return None, "event_%d:unsupported_schema" % index
    occurred_at = parse_time(data.get("occurred_at"))
    observed_at = parse_time(data.get("observed_at"))
    outer_time = parse_time(outer.get("timestamp"))
    if occurred_at is None or observed_at is None or outer_time is None:
        return None, "event_%d:invalid_timestamp" % index
    event_type = canonical_token(data.get("event_type"))
    event_type = EVENT_ALIASES.get(event_type, event_type)
    turn_link_id = str(data.get("turn_link_id") or "").strip()
    turn_link_present = "turn_link_id" in data
    if source_schema_version == TURN_LINK_SOURCE_SCHEMA_VERSION:
        if event_type in TURN_LINK_EVENT_TYPES:
            if not TURN_LINK_PATTERN.fullmatch(turn_link_id):
                return None, "event_%d:missing_or_invalid_turn_link" % index
        elif turn_link_present:
            return None, "event_%d:turn_link_forbidden_for_event_type" % index
    elif turn_link_present:
        # Schema 1.0 never defined a link field. Treat an apparent hybrid as
        # invalid instead of silently granting it 1.1 pairing semantics.
        return None, "event_%d:turn_link_forbidden_for_schema" % index
    provider = canonical_token(data.get("provider"))
    provider = PROVIDER_ALIASES.get(provider, provider)
    surface = canonical_token(data.get("surface"))
    surface = SURFACE_ALIASES.get(surface, surface)
    conversation_key = str(data.get("conversation_key") or "").strip()
    if event_type not in SOURCE_EVENT_TYPES and not conversation_key:
        return None, "event_%d:missing_conversation_key" % index
    metadata = data.get("metadata", {})
    if not isinstance(metadata, dict):
        return None, "event_%d:metadata_not_object" % index
    safe_metadata, metadata_sanitization_issues = sanitize_event_metadata(
        event_type, metadata
    )
    try:
        duration = max(0.0, float(outer.get("duration", 0) or 0))
    except (TypeError, ValueError):
        duration = 0.0
    normalized = {
        "schema_version": SCHEMA_VERSION,
        "source_schema_version": source_schema_version,
        "source_event_id_raw": str(data.get("source_event_id")).strip(),
        # Private validation-only linkage. It is hashed for turn_id and never
        # projected into regular event/CSV outputs.
        "turn_link_id_raw": turn_link_id,
        "occurred_dt": occurred_at,
        "observed_dt": observed_at,
        "outer_dt": outer_time,
        "duration": duration,
        "provider": provider,
        "surface": surface,
        "event_type": event_type,
        "conversation_key_raw": conversation_key,
        "provider_conversation_id_raw": str(data.get("provider_conversation_id") or "").strip(),
        "identity_status": canonical_token(data.get("identity_status")),
        "full_url_raw": str(data.get("full_url") or "").strip(),
        "confidence": data.get("confidence"),
        "source_adapter": str(data.get("source_adapter")).strip(),
        "adapter_version": str(data.get("adapter_version")).strip(),
        "privacy_tier": str(data.get("privacy_tier")).strip(),
        "previous_conversation_key_raw": str(data.get("previous_conversation_key") or "").strip(),
        # These values remain private to validation. They are never copied to
        # regular ledger output, but allow the consumer to verify a producer's
        # provisional->exact continuity claim instead of trusting key pairs.
        "namespace_generation": (
            data.get("namespace_generation")
            if isinstance(data.get("namespace_generation"), int)
            and not isinstance(data.get("namespace_generation"), bool)
            and data.get("namespace_generation") > 0
            else None
        ),
        "namespace_generation_present": (
            "namespace_generation" in data
            and data.get("namespace_generation") not in (None, "")
        ),
        "namespace_fingerprint": str(
            data.get("namespace_fingerprint") or ""
        ).strip(),
        "namespace_fingerprint_present": (
            "namespace_fingerprint" in data
            and data.get("namespace_fingerprint") not in (None, "")
        ),
        "window_session_id": str(
            data.get("window_session_id") or ""
        ).strip(),
        "window_session_id_present": (
            "window_session_id" in data
            and data.get("window_session_id") not in (None, "")
        ),
        "process_instance_id": str(
            data.get("process_instance_id") or ""
        ).strip(),
        "process_instance_id_present": (
            "process_instance_id" in data
            and data.get("process_instance_id") not in (None, "")
        ),
        "metadata": safe_metadata,
        "metadata_sanitization_issues": metadata_sanitization_issues,
    }
    return normalized, None


def event_fingerprint(event):
    comparable = {
        key: value
        for key, value in event.items()
        if key not in {"occurred_dt", "observed_dt", "outer_dt"}
    }
    comparable["occurred_at"] = iso(event["occurred_dt"])
    comparable["observed_at"] = iso(event["observed_dt"])
    comparable["outer_at"] = iso(event["outer_dt"])
    return json.dumps(comparable, ensure_ascii=False, sort_keys=True, default=str)


def resolve_aliases(events):
    issues = []
    history = defaultdict(list)
    candidates = []

    def continuity_matches(previous_event, bound_event):
        if previous_event["surface"] != bound_event["surface"]:
            issues.append("conversation_bound_surface_mismatch")
            return False
        if previous_event["source_adapter"] != bound_event["source_adapter"]:
            issues.append("conversation_bound_source_mismatch")
            return False

        namespace_present = any((
            previous_event["namespace_generation_present"],
            previous_event["namespace_fingerprint_present"],
            bound_event["namespace_generation_present"],
            bound_event["namespace_fingerprint_present"],
        ))
        # macOS provisional events promise both namespace fields. Requiring
        # them prevents a forged bound event from gaining trust by stripping
        # the very continuity evidence the producer contract supplies.
        if bound_event["surface"] == "macos_app":
            namespace_present = True
        if namespace_present:
            namespace_matches = (
                previous_event["namespace_generation"] is not None
                and bound_event["namespace_generation"] is not None
                and bool(previous_event["namespace_fingerprint"])
                and previous_event["namespace_generation"]
                == bound_event["namespace_generation"]
                and previous_event["namespace_fingerprint"]
                == bound_event["namespace_fingerprint"]
            )
            if not namespace_matches:
                issues.append("conversation_bound_namespace_mismatch")
                return False

        window_present = (
            previous_event["window_session_id_present"]
            or bound_event["window_session_id_present"]
            or bound_event["surface"] == "macos_app"
        )
        if window_present and (
            not previous_event["window_session_id"]
            or previous_event["window_session_id"]
            != bound_event["window_session_id"]
        ):
            issues.append("conversation_bound_window_mismatch")
            return False

        process_present = (
            previous_event["process_instance_id_present"]
            or bound_event["process_instance_id_present"]
        )
        if process_present and (
            not previous_event["process_instance_id"]
            or previous_event["process_instance_id"]
            != bound_event["process_instance_id"]
        ):
            issues.append("conversation_bound_process_mismatch")
            return False
        return True

    for event in events:
        if event["event_type"] == "conversation_bound":
            previous = event["previous_conversation_key_raw"]
            current = event["conversation_key_raw"]
            if not previous or not current:
                issues.append("conversation_bound_missing_key")
            elif event["identity_status"] != "exact":
                issues.append("conversation_bound_current_not_exact")
            elif previous == current:
                issues.append("conversation_bound_self_alias")
            else:
                prior = history.get(previous, [])
                if not prior:
                    issues.append("conversation_bound_missing_prior")
                else:
                    prior_providers = {item["provider"] for item in prior}
                    same_provider = [
                        item
                        for item in prior
                        if item["provider"] == event["provider"]
                    ]
                    if (
                        event["provider"] not in prior_providers
                        or len(prior_providers) != 1
                    ):
                        issues.append("conversation_bound_provider_mismatch")
                    elif not same_provider or (
                        same_provider[-1]["identity_status"] != "provisional"
                    ):
                        issues.append(
                            "conversation_bound_previous_not_provisional"
                        )
                    elif continuity_matches(same_provider[-1], event):
                        candidates.append((
                            (event["provider"], previous),
                            (event["provider"], current),
                        ))

        current_key = event["conversation_key_raw"]
        if current_key:
            history[current_key].append(event)

    candidate_targets = defaultdict(set)
    for node, target in candidates:
        candidate_targets[node].add(target)

    aliases = {}
    for node, targets in candidate_targets.items():
        if len(targets) != 1:
            issues.append("conversation_bound_conflict")
            continue
        aliases[node] = next(iter(targets))

    cycle_reachable = set()
    cycle_found = False
    for start in list(aliases):
        path = []
        positions = {}
        current = start
        while current in aliases:
            if current in positions:
                cycle_found = True
                cycle_reachable.update(path)
                break
            positions[current] = len(path)
            path.append(current)
            current = aliases[current]
    if cycle_found:
        issues.append("conversation_bound_cycle")
        for node in cycle_reachable:
            aliases.pop(node, None)

    def resolve(node):
        visited = []
        current = node
        while current in aliases:
            visited.append(current)
            current = aliases[current]
        for item in visited:
            aliases[item] = current
        return current

    for event in events:
        raw_key = event["conversation_key_raw"]
        if raw_key:
            canonical = resolve((event["provider"], raw_key))
            event["canonical_key_raw"] = canonical[1]
        else:
            event["canonical_key_raw"] = ""
        previous = event["previous_conversation_key_raw"]
        if previous:
            event["previous_canonical_key_raw"] = resolve((event["provider"], previous))[1]
        else:
            event["previous_canonical_key_raw"] = ""
    return sorted(set(issues))


def make_safe_data(event):
    canonical_key = event.get("canonical_key_raw", "")
    return {
        "schema_version": SCHEMA_VERSION,
        "source_event_id": safe_hash("evt", event["source_event_id_raw"]),
        "occurred_at": iso(event["occurred_dt"]),
        "observed_at": iso(event["observed_dt"]),
        "provider": event["provider"],
        "surface": event["surface"],
        "event_type": event["event_type"],
        "conversation_key": (
            safe_hash("conv", event["provider"], canonical_key) if canonical_key else ""
        ),
        "identity_status": event["identity_status"],
        "confidence": event["confidence"],
        "source_adapter": event["source_adapter"],
        "adapter_version": event["adapter_version"],
        "privacy_tier": "research_deidentified",
        "previous_conversation_key": (
            safe_hash("conv", event["provider"], event["previous_conversation_key_raw"])
            if event["previous_conversation_key_raw"]
            else ""
        ),
        "metadata": event["metadata"],
    }


def close_visit(
    active,
    end_dt,
    reason,
    visits,
    counters,
    right_censored=False,
):
    if active is None:
        return
    if right_censored:
        end_dt = max(end_dt, active["start_dt"])
    else:
        end_dt = max(end_dt, active["start_dt"], active["last_evidence_end"])
    provider = active["provider"]
    raw_key = active["canonical_key_raw"]
    safe_key = safe_hash("conv", provider, raw_key)
    counters[(provider, raw_key)] += 1
    revisit_index = counters[(provider, raw_key)]
    left_censored = bool(active.get("left_censored"))
    if left_censored and right_censored:
        boundary_status = "both_censored"
    elif left_censored:
        boundary_status = "left_censored"
    elif right_censored:
        boundary_status = "right_censored"
    else:
        boundary_status = "inside"
    visit_id = safe_hash(
        "visit",
        provider,
        raw_key,
        active["surface"],
        iso(active["start_dt"]),
        revisit_index,
    )
    visits.append(
        {
            "visit_id": visit_id,
            "conversation_key": safe_key,
            "provider": provider,
            "surface": active["surface"],
            "started_at": iso(active["start_dt"]),
            "ended_at": iso(end_dt),
            "duration_sec": "%.3f" % max(0.0, (end_dt - active["start_dt"]).total_seconds()),
            "start_event_type": active["start_event_type"],
            "end_reason": reason,
            "window_boundary_status": boundary_status,
            "revisit_index": revisit_index,
            "event_count": active["event_count"],
            "identity_status": active["identity_status"],
            "confidence": active["confidence"],
            "_raw_key": raw_key,
            "_start_dt": active["start_dt"],
            "_end_dt": end_dt,
        }
    )


def derive_visits(events, window_start=None, window_end=None):
    visits = []
    counters = defaultdict(int)
    active_by_surface = {}
    scoped = [
        event
        for event in events
        if event["canonical_key_raw"]
        and event["event_type"] not in SOURCE_EVENT_TYPES
        and event["event_type"] != "conversation_bound"
    ]
    for event in scoped:
        scope = (event["provider"], event["surface"])
        current = active_by_surface.get(scope)
        event_type = event["event_type"]
        raw_key = event["canonical_key_raw"]
        event_end = event["occurred_dt"] + timedelta(seconds=event["duration"])
        activates = event_type in ACTIVATION_EVENTS

        if event_type in DEACTIVATION_EVENTS:
            if current and current["canonical_key_raw"] == raw_key:
                current["event_count"] += 1
                current["last_evidence_end"] = max(current["last_evidence_end"], event["occurred_dt"])
                close_visit(current, event["occurred_dt"], event_type, visits, counters)
                active_by_surface.pop(scope, None)
            continue

        if activates and current and current["canonical_key_raw"] != raw_key:
            close_visit(current, event["occurred_dt"], "conversation_switch", visits, counters)
            active_by_surface.pop(scope, None)
            current = None

        if activates and current is None:
            left_censored = bool(
                window_start is not None
                and event_type
                not in {"conversation_foregrounded", "user_returned"}
            )
            current = {
                "provider": event["provider"],
                "surface": event["surface"],
                "canonical_key_raw": raw_key,
                "start_dt": event["occurred_dt"],
                "last_evidence_end": event_end,
                "start_event_type": event_type,
                "event_count": 1,
                "identity_status": event["identity_status"],
                "confidence": event["confidence"],
                "left_censored": left_censored,
            }
            active_by_surface[scope] = current
        elif current and current["canonical_key_raw"] == raw_key:
            current["event_count"] += 1
            current["last_evidence_end"] = max(current["last_evidence_end"], event_end)
            if event["identity_status"] == "exact":
                current["identity_status"] = "exact"

    for current in list(active_by_surface.values()):
        if window_end is not None:
            close_visit(
                current,
                window_end,
                "window_end",
                visits,
                counters,
                right_censored=True,
            )
        else:
            close_visit(
                current,
                current["last_evidence_end"],
                "observation_end",
                visits,
                counters,
            )
    visits.sort(key=lambda row: (row["_start_dt"], row["visit_id"]))
    return visits


def make_derived_event(event_type, visit, occurred_dt, source_event=None):
    provider = visit["provider"]
    raw_key = visit["_raw_key"]
    seed = "%s|%s|%s|%s" % (event_type, provider, raw_key, iso(occurred_dt))
    event_id = safe_hash("evt", "ledger-derived", seed)
    metadata = {
        "event_origin": "derived",
        "derivation": "visit_reentry" if event_type == "user_returned" else "post_return_action",
        "visit_id": visit["visit_id"],
    }
    if source_event is not None:
        metadata["basis_event_id"] = safe_hash("evt", source_event["source_event_id_raw"])
    data = {
        "schema_version": SCHEMA_VERSION,
        "source_event_id": event_id,
        "occurred_at": iso(occurred_dt),
        "observed_at": iso(occurred_dt),
        "provider": provider,
        "surface": visit["surface"],
        "event_type": event_type,
        "conversation_key": safe_hash("conv", provider, raw_key),
        "identity_status": visit["identity_status"],
        "confidence": visit["confidence"],
        "source_adapter": "ai_conversation_ledger",
        "adapter_version": SCHEMA_VERSION,
        "privacy_tier": "research_deidentified",
        "previous_conversation_key": "",
        "metadata": metadata,
    }
    return {"timestamp": iso(occurred_dt), "duration": 0.0, "data": data}


def derive_return_events(events, visits):
    derived = []
    for visit in visits:
        if int(visit["revisit_index"]) <= 1:
            continue
        start = visit["_start_dt"]
        end = visit["_end_dt"]
        raw_key = visit["_raw_key"]
        provider = visit["provider"]
        surface = visit["surface"]
        matching = [
            event
            for event in events
            if event["provider"] == provider
            and event["surface"] == surface
            and event["canonical_key_raw"] == raw_key
            and start <= event["occurred_dt"] <= end
        ]
        if not any(event["event_type"] == "user_returned" for event in matching):
            derived.append(make_derived_event("user_returned", visit, start))
        # A generic click/scroll is user_interacted, not engagement. Only the next
        # input_started or prompt_submitted operationalizes post-return engagement.
        actions = [
            event for event in matching if event["event_type"] in ENGAGEMENT_BASIS_EVENTS
        ]
        producer_engaged = any(
            event["event_type"] == "user_engaged" for event in matching
        )
        if actions and not producer_engaged:
            action = min(actions, key=lambda event: event["occurred_dt"])
            derived.append(
                make_derived_event("user_engaged", visit, action["occurred_dt"], action)
            )
    return derived


def validate_turn_links(events):
    """Validate 1.1 linkage without exposing the raw UUID in any issue."""
    grouped = defaultdict(list)
    for event in events:
        if (
            event["source_schema_version"] == TURN_LINK_SOURCE_SCHEMA_VERSION
            and event["event_type"] in TURN_LINK_EVENT_TYPES
        ):
            grouped[event["turn_link_id_raw"]].append(event)

    issues = []
    terminal_types = set(RESPONSE_TERMINAL_EVENTS)
    for group in grouped.values():
        identities = {
            (event["provider"], event["canonical_key_raw"], event["surface"])
            for event in group
        }
        if len(identities) != 1:
            issues.append("turn_link_identity_conflict")

        prompts = [event for event in group if event["event_type"] == "prompt_submitted"]
        starts = [
            event
            for event in group
            if event["event_type"] == "assistant_response_started"
        ]
        terminals = [event for event in group if event["event_type"] in terminal_types]
        if len(prompts) > 1:
            issues.append("turn_link_multiple_prompts")
        if len(starts) > 1:
            issues.append("turn_link_multiple_starts")
        if len(terminals) > 1:
            issues.append("turn_link_multiple_terminals")
        if (
            terminals
            and not starts
            and (
                not prompts
                or any(
                    event["event_type"] != "assistant_response_cancelled"
                    for event in terminals
                )
            )
        ):
            issues.append("turn_link_terminal_without_start")

        prompt_dt = prompts[0]["occurred_dt"] if prompts else None
        start_dt = starts[0]["occurred_dt"] if starts else None
        terminal_dt = terminals[0]["occurred_dt"] if terminals else None
        if (
            prompt_dt is not None
            and start_dt is not None
            and start_dt < prompt_dt
        ) or (
            prompt_dt is not None
            and terminal_dt is not None
            and terminal_dt < prompt_dt
        ) or (
            start_dt is not None
            and terminal_dt is not None
            and terminal_dt < start_dt
        ):
            issues.append("turn_link_lifecycle_order_invalid")
    return issues


def derive_turns(events, window_start=None, window_end=None):
    latest_input = {}
    legacy_pending = defaultdict(deque)
    linked_turns = {}
    turns = []

    def new_turn(event, turn_link_id=""):
        return {
            "provider": event["provider"],
            "surface": event["surface"],
            "raw_key": event["canonical_key_raw"],
            "turn_link_id_raw": turn_link_id,
            "input_event": None,
            "submit_event": None,
            "response_started_event": None,
            "response_event": None,
            "outcome": "",
            "first_event_dt": event["occurred_dt"],
        }

    for event in events:
        raw_key = event["canonical_key_raw"]
        if not raw_key or event["event_type"] in SOURCE_EVENT_TYPES:
            continue
        key = (event["provider"], raw_key)
        event_type = event["event_type"]
        if event_type == "input_started":
            latest_input[key] = event
            continue

        turn_link_id = event.get("turn_link_id_raw", "")
        if (
            event["source_schema_version"] == TURN_LINK_SOURCE_SCHEMA_VERSION
            and event_type in TURN_LINK_EVENT_TYPES
            and turn_link_id
        ):
            turn = linked_turns.get(turn_link_id)
            if turn is None:
                turn = new_turn(event, turn_link_id)
                linked_turns[turn_link_id] = turn
            if event_type == "prompt_submitted":
                if turn["submit_event"] is None:
                    turn["input_event"] = latest_input.pop(key, None)
                    turn["submit_event"] = event
                continue
            if event_type == "assistant_response_started":
                if turn["response_started_event"] is None:
                    turn["response_started_event"] = event
                continue
            if event_type in RESPONSE_TERMINAL_EVENTS:
                if turn["response_event"] is None:
                    turn["response_event"] = event
                continue

        if event_type == "prompt_submitted":
            input_event = latest_input.pop(key, None)
            legacy_pending[key].append(
                {
                    "provider": event["provider"],
                    "surface": event["surface"],
                    "raw_key": raw_key,
                    "input_event": input_event,
                    "submit_event": event,
                    "response_started_event": None,
                    "response_event": None,
                    "outcome": "",
                    "turn_link_id_raw": "",
                    "first_event_dt": event["occurred_dt"],
                }
            )
            continue
        if event_type == "assistant_response_started" and legacy_pending[key]:
            if legacy_pending[key][0]["response_started_event"] is None:
                legacy_pending[key][0]["response_started_event"] = event
            continue
        if event_type in RESPONSE_TERMINAL_EVENTS:
            if legacy_pending[key]:
                turn = legacy_pending[key].popleft()
            else:
                turn = new_turn(event)
                turn["window_boundary_status"] = (
                    "left_censored" if window_start is not None else "inside"
                )
            turn["response_event"] = event
            outcome = RESPONSE_TERMINAL_EVENTS[event_type]
            if turn["submit_event"]:
                turn["outcome"] = outcome
                turn.setdefault("window_boundary_status", "inside")
            elif window_start is not None:
                turn["outcome"] = "left_censored_" + outcome
            else:
                turn["outcome"] = "orphan_" + outcome
            turns.append(turn)

    for turn in linked_turns.values():
        submit = turn["submit_event"]
        response = turn["response_event"]
        if response is not None:
            outcome = RESPONSE_TERMINAL_EVENTS[response["event_type"]]
            if submit is not None:
                turn["outcome"] = outcome
                turn["window_boundary_status"] = "inside"
            else:
                # A schema-1.1 start without a prompt is emitted only as an
                # explicit left-censored lifecycle; preserve that evidence.
                turn["outcome"] = "left_censored_" + outcome
                turn["window_boundary_status"] = "left_censored"
        elif submit is not None:
            if window_end is not None:
                turn["outcome"] = "right_censored"
                turn["window_boundary_status"] = "right_censored"
            else:
                turn["outcome"] = "missing_response"
                turn["window_boundary_status"] = "inside"
        else:
            turn["outcome"] = "left_censored_missing_response"
            turn["window_boundary_status"] = (
                "both_censored" if window_end is not None else "left_censored"
            )
        turns.append(turn)

    for queue in legacy_pending.values():
        while queue:
            turn = queue.popleft()
            if window_end is not None:
                turn["outcome"] = "right_censored"
                turn["window_boundary_status"] = "right_censored"
            else:
                turn["outcome"] = "missing_response"
                turn["window_boundary_status"] = "inside"
            turns.append(turn)

    rows = []
    for turn in turns:
        submit = turn["submit_event"]
        response = turn["response_event"]
        input_event = turn["input_event"]
        response_started = turn["response_started_event"]
        anchor = submit or response or input_event
        submitted_dt = submit["occurred_dt"] if submit else None
        response_dt = response["occurred_dt"] if response else None
        latency = ""
        if submitted_dt and response_dt:
            latency = "%.3f" % max(0.0, (response_dt - submitted_dt).total_seconds())
        safe_key = safe_hash("conv", turn["provider"], turn["raw_key"])
        anchor_id = (
            turn.get("turn_link_id_raw")
            or (anchor["source_event_id_raw"] if anchor else turn["outcome"])
        )
        rows.append(
            {
                "turn_id": safe_hash("turn", turn["provider"], turn["raw_key"], anchor_id),
                "conversation_key": safe_key,
                "provider": turn["provider"],
                "surface": turn["surface"],
                "input_started_at": iso(input_event["occurred_dt"]) if input_event else "",
                "submitted_at": iso(submitted_dt) if submitted_dt else "",
                "response_started_at": (
                    iso(response_started["occurred_dt"]) if response_started else ""
                ),
                "response_ended_at": iso(response_dt) if response_dt else "",
                "outcome": turn["outcome"],
                "window_boundary_status": turn.get(
                    "window_boundary_status", "inside"
                ),
                "latency_sec": latency,
                "submit_event_id": (
                    safe_hash("evt", submit["source_event_id_raw"]) if submit else ""
                ),
                "response_event_id": (
                    safe_hash("evt", response["source_event_id_raw"]) if response else ""
                ),
                "identity_status": (
                    "exact"
                    if any(
                        item and item["identity_status"] == "exact"
                        for item in (input_event, submit, response_started, response)
                    )
                    else (anchor["identity_status"] if anchor else "")
                ),
                "confidence": anchor["confidence"] if anchor else "",
                "_sort_dt": submitted_dt or response_dt or datetime.max.replace(tzinfo=timezone.utc),
            }
        )
    rows.sort(key=lambda row: (row["_sort_dt"], row["turn_id"]))
    return rows


def build_conversations(safe_events, visits, turns, locator_keys):
    grouped = {}
    for outer in safe_events:
        data = outer["data"]
        key = data.get("conversation_key")
        if not key:
            continue
        row = grouped.setdefault(
            key,
            {
                "conversation_key": key,
                "provider": data["provider"],
                "surfaces": set(),
                "identity_status": data["identity_status"],
                "first_seen_at": data["occurred_at"],
                "last_seen_at": data["occurred_at"],
                "event_count": 0,
                "event_types": defaultdict(int),
            },
        )
        row["surfaces"].add(data["surface"])
        row["event_count"] += 1
        row["event_types"][data["event_type"]] += 1
        row["first_seen_at"] = min(row["first_seen_at"], data["occurred_at"])
        row["last_seen_at"] = max(row["last_seen_at"], data["occurred_at"])
        if data["identity_status"] == "exact":
            row["identity_status"] = "exact"
    visit_counts = defaultdict(int)
    turn_counts = defaultdict(int)
    outcomes = defaultdict(lambda: defaultdict(int))
    for visit in visits:
        visit_counts[visit["conversation_key"]] += 1
    for turn in turns:
        turn_counts[turn["conversation_key"]] += 1
        outcomes[turn["conversation_key"]][turn["outcome"]] += 1
    rows = []
    for key, row in grouped.items():
        event_types = row.pop("event_types")
        row["surfaces"] = ";".join(sorted(row["surfaces"]))
        row["visit_count"] = visit_counts[key]
        row["turn_count"] = turn_counts[key]
        row["response_completed_count"] = event_types["assistant_response_completed"]
        row["notification_suppressed_count"] = event_types[
            "tracker_notification_suppressed"
        ]
        row["notification_attempted_count"] = event_types[
            "tracker_notification_attempted"
        ]
        row["notification_created_count"] = event_types[
            "tracker_notification_created"
        ]
        row["notification_failed_count"] = event_types[
            "tracker_notification_failed"
        ]
        row["notification_clicked_count"] = event_types[
            "tracker_notification_clicked"
        ]
        row["notification_auto_cleared_count"] = event_types[
            "tracker_notification_auto_cleared"
        ]
        row["notification_focus_succeeded_count"] = sum(
            1
            for outer in safe_events
            if outer["data"].get("conversation_key") == key
            and outer["data"].get("event_type") == "tracker_notification_clicked"
            and outer["data"].get("metadata", {}).get("focus_succeeded") is True
        )
        row["legacy_notification_shown_count"] = event_types[
            "tracker_notification_shown"
        ]
        # Preserve the historical column exactly; it is legacy-only and is not
        # evidence that macOS actually displayed a banner.
        row["notification_count"] = row["legacy_notification_shown_count"]
        row["return_count"] = event_types["user_returned"]
        row["engaged_count"] = event_types["user_engaged"]
        row["failed_turn_count"] = outcomes[key]["failed"] + outcomes[key]["orphan_failed"]
        row["cancelled_turn_count"] = (
            outcomes[key]["cancelled"] + outcomes[key]["orphan_cancelled"]
        )
        row["missing_response_count"] = outcomes[key]["missing_response"]
        row["left_censored_turn_count"] = sum(
            count
            for outcome, count in outcomes[key].items()
            if outcome.startswith("left_censored_")
        )
        row["right_censored_turn_count"] = outcomes[key]["right_censored"]
        row["private_locator_available"] = "TRUE" if key in locator_keys else "FALSE"
        rows.append(row)
    rows.sort(key=lambda row: (row["first_seen_at"], row["conversation_key"]))
    return rows


def build_private_locators(events, locator_sidecar=None):
    """Build private artifacts without confusing identity with actuation.

    A sidecar semantic group is provider + exact conversation key + actuator.
    The actuator fixes the surface, so one safe conversation may have one Web
    locator and one native-App locator.  Each group must contain exactly one
    unique handle/namespace signature (identical duplicate rows are idempotent)
    and match the latest exact event on its derived surface.  Any semantic
    issue in one group fails the whole provider/key closed, preventing a valid
    sibling surface from hiding a conflicting locator.  Historical raw URL/ID
    values are never projected into rows and never enter ``locator_keys``.
    """
    candidate_rows = {}
    issue_records = set()
    failed_keys = set()

    sidecar_rows = locator_sidecar or []
    if sidecar_rows:
        # Reopen authority is tied to the latest exact observation for the
        # surface fixed by the actuator.  We deliberately do not infer it
        # through title/time/content or from a provisional alias.
        latest_exact = {}
        for event in events:
            target = (
                event["provider"],
                event["conversation_key_raw"],
                event["surface"],
            )
            if (
                event["identity_status"] != "exact"
                or not EXACT_CONVERSATION_KEY_PATTERN.fullmatch(
                    event["conversation_key_raw"]
                )
                or event["canonical_key_raw"] != event["conversation_key_raw"]
            ):
                continue
            previous = latest_exact.get(target)
            if previous is None or (
                event["observed_dt"], event["source_event_id_raw"]
            ) > (previous["observed_dt"], previous["source_event_id_raw"]):
                latest_exact[target] = event

        entries_by_group = defaultdict(set)
        handle_owners = defaultdict(set)
        canonical_entries = {}
        for entry in sidecar_rows:
            group = (
                entry["provider"],
                entry["conversation_key"],
                entry.get("actuator_kind", ""),
            )
            signature = (
                entry["locator_handle"],
                entry["namespace_generation"],
                entry["namespace_fingerprint"],
            )
            entries_by_group[group].add(signature)
            handle_owners[entry["locator_handle"]].add(group)
            canonical_entries[(group, signature)] = entry

        conflicting_groups = {
            group
            for group, signatures in entries_by_group.items()
            if len(signatures) != 1
        }
        for owners in handle_owners.values():
            if len(owners) > 1:
                conflicting_groups.update(owners)
        for group in conflicting_groups:
            logical_key = group[:2]
            failed_keys.add(logical_key)
            issue_records.add(
                (logical_key, "private_locator_sidecar_conflict")
            )

        for group, signatures in entries_by_group.items():
            logical_key = group[:2]
            if group in conflicting_groups:
                continue
            signature = next(iter(signatures))
            entry = canonical_entries[(group, signature)]
            surface = PRIVATE_LOCATOR_SURFACE_BY_ACTUATOR.get(group[2])
            expected_actuator = PRIVATE_LOCATOR_ACTUATOR_CONTRACT.get(
                (group[0], surface)
            )
            if surface is None:
                failed_keys.add(logical_key)
                issue_records.add(
                    (logical_key, "private_locator_sidecar_surface_unsupported")
                )
                continue
            if group[2] != expected_actuator:
                failed_keys.add(logical_key)
                issue_records.add(
                    (logical_key, "private_locator_sidecar_actuator_mismatch")
                )
                continue

            event = latest_exact.get((group[0], group[1], surface))
            if event is None:
                failed_keys.add(logical_key)
                issue_records.add(
                    (logical_key, "private_locator_sidecar_event_mismatch")
                )
                continue
            if (
                not event["namespace_generation_present"]
                or not event["namespace_fingerprint_present"]
                or event["namespace_generation"]
                != entry["namespace_generation"]
                or event["namespace_fingerprint"]
                != entry["namespace_fingerprint"]
            ):
                failed_keys.add(logical_key)
                issue_records.add(
                    (logical_key, "private_locator_sidecar_namespace_mismatch")
                )
                continue

            safe_key = safe_hash(
                "conv", event["provider"], event["canonical_key_raw"]
            )
            locator_tuple = (
                "opaque_sidecar_v1",
                safe_key,
                entry["locator_handle"],
                entry["namespace_generation"],
                entry["namespace_fingerprint"],
                entry["actuator_kind"],
            )
            candidate_rows[(logical_key, locator_tuple)] = {
                "conversation_key": safe_key,
                "provider": event["provider"],
                "surface": surface,
                "locator_handle": entry["locator_handle"],
                "reopen_url": build_reopen_url(entry["locator_handle"]),
                "namespace_generation": entry["namespace_generation"],
                "namespace_fingerprint": entry["namespace_fingerprint"],
                "actuator_kind": entry["actuator_kind"],
                "locator_provenance": "opaque_sidecar_v1",
                "identity_status": "exact",
                "last_observed_at": iso(event["observed_dt"]),
                "artifact_class": "development_pilot_private",
            }

    rows_by_tuple = {
        locator_tuple: row
        for (logical_key, locator_tuple), row in candidate_rows.items()
        if logical_key not in failed_keys
    }
    locator_keys = {row["conversation_key"] for row in rows_by_tuple.values()}

    rows = sorted(
        rows_by_tuple.values(),
        key=lambda row: (
            row["provider"],
            row["conversation_key"],
            row["locator_provenance"],
            row["surface"],
            row["last_observed_at"],
        ),
    )
    issues = sorted(code for _, code in issue_records)
    return rows, locator_keys, issues


def summarize_legacy_raw_observations(events):
    """Return content-free counts; never project a historical raw value."""
    raw_events = [
        event
        for event in events
        if event["full_url_raw"] or event["provider_conversation_id_raw"]
    ]
    conversations = {
        (event["provider"], event["canonical_key_raw"])
        for event in raw_events
        if event["canonical_key_raw"]
    }
    return {
        "legacy_raw_provenance": (
            "legacy_activitywatch_raw_observed" if raw_events else "none"
        ),
        "legacy_raw_event_count": len(raw_events),
        "legacy_raw_conversation_count": len(conversations),
        "legacy_raw_issue_codes": (
            ["legacy_activitywatch_raw_not_exported"] if raw_events else []
        ),
    }


def build_coverage(events):
    grouped = defaultdict(list)
    for event in events:
        if event["event_type"] in SOURCE_EVENT_TYPES:
            continue
        grouped[(event["provider"], event["surface"])].append(event)
    rows = []
    for (provider, surface), items in sorted(grouped.items()):
        conversations = {
            safe_hash("conv", provider, item["canonical_key_raw"])
            for item in items
            if item["canonical_key_raw"]
        }
        event_types = defaultdict(int)
        for item in items:
            event_types[item["event_type"]] += 1
        rows.append(
            {
                "provider": provider,
                "surface": surface,
                "first_observed_at": iso(min(item["observed_dt"] for item in items)),
                "last_observed_at": iso(max(item["observed_dt"] for item in items)),
                "normalized_event_count": len(items),
                "conversation_count": len(conversations),
                "event_types": ";".join(
                    "%s=%d" % pair for pair in sorted(event_types.items())
                ),
            }
        )
    return rows


def assess_health(
    source_present,
    source_event_count,
    events,
    invalid_messages,
    sanitization_issues,
    duplicate_count,
    conflict_count,
    alias_issues,
    turn_link_issues,
    observation_end,
    observation_end_source,
    max_gap_sec,
):
    gaps = []
    warnings = []
    liveness = sorted(
        event["observed_dt"]
        for event in events
        if event["event_type"] in SOURCE_EVENT_TYPES
    )
    adapter_state = {}
    for event in events:
        if event["event_type"] == "adapter_unhealthy":
            adapter_state[(event["provider"], event["surface"])] = "unhealthy"
        elif event["event_type"] == "adapter_recovered":
            adapter_state[(event["provider"], event["surface"])] = "recovered"
    unrecovered_adapters = sum(
        1 for state in adapter_state.values() if state == "unhealthy"
    )
    latest_source = max((event["observed_dt"] for event in events), default=None)
    max_internal_gap = 0.0
    for previous, current in zip(liveness, liveness[1:]):
        max_internal_gap = max(max_internal_gap, (current - previous).total_seconds())

    if not source_present:
        status = "missing"
        gaps.append("ai_conversation_source_missing")
    elif source_event_count == 0:
        status = "empty"
        gaps.append("ai_conversation_source_empty")
    elif not events:
        status = "invalid"
        gaps.append("no_valid_ai_conversation_events")
    elif observation_end is None:
        status = "unverifiable"
        gaps.append("observation_end_unavailable")
    else:
        status = "healthy"
        if not liveness:
            warnings.append(
                "explicit_liveness_events_missing_using_external_observation_end"
            )
        if latest_source and observation_end < latest_source:
            status = "degraded"
            gaps.append("observation_end_precedes_latest_source")
        elif latest_source:
            trailing_gap = max(0.0, (observation_end - latest_source).total_seconds())
            if trailing_gap > max_gap_sec:
                status = "stale"
                gaps.append("tracker_trailing_gap_exceeds_threshold")
        if max_internal_gap > max_gap_sec:
            if status == "healthy":
                status = "degraded"
            gaps.append("tracker_internal_gap_exceeds_threshold")
        if invalid_messages or conflict_count or alias_issues or turn_link_issues:
            if status == "healthy":
                status = "degraded"
            gaps.append("invalid_or_conflicting_events_present")
        if unrecovered_adapters:
            if status == "healthy":
                status = "degraded"
            gaps.append("adapter_unhealthy_without_recovery")
    if sanitization_issues:
        if status == "healthy":
            status = "degraded"
        gaps.append("metadata_sanitization_issue")

    notification_counts = {
        event_type: sum(
            1 for event in events if event["event_type"] == event_type
        )
        for event_type in (
            "tracker_notification_suppressed",
            "tracker_notification_attempted",
            "tracker_notification_created",
            "tracker_notification_failed",
            "tracker_notification_clicked",
            "tracker_notification_auto_cleared",
            "tracker_notification_shown",
        )
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "status": status,
        "source_present": source_present,
        "source_event_count": source_event_count,
        "normalized_event_count": len(events),
        "invalid_event_count": len(invalid_messages),
        "metadata_sanitization_issue_count": len(sanitization_issues),
        "duplicate_event_count": duplicate_count,
        "conflicting_duplicate_count": conflict_count,
        "alias_issue_count": len(alias_issues),
        "turn_link_issue_count": len(turn_link_issues),
        "liveness_event_count": len(liveness),
        "unrecovered_adapter_count": unrecovered_adapters,
        "latest_source_observed_at": iso(latest_source) if latest_source else None,
        "observation_end_at": iso(observation_end) if observation_end else None,
        "observation_end_source": observation_end_source,
        # Backward-compatible name; no longer derived from the AI stream itself.
        "reference_latest_at": iso(observation_end) if observation_end else None,
        "max_internal_liveness_gap_sec": round(max_internal_gap, 3),
        "max_allowed_source_gap_sec": max_gap_sec,
        "health_gaps": sorted(set(gaps)),
        "warnings": sorted(set(warnings)),
        "validation_issue_codes": sorted(
            set(
                invalid_messages
                + alias_issues
                + turn_link_issues
                + sanitization_issues
            )
        ),
        "privacy": {
            "regular_outputs_contain_full_urls": False,
            "private_locator_requires_explicit_flag": True,
        },
        "notification_observability": {
            "suppressed_count": notification_counts[
                "tracker_notification_suppressed"
            ],
            "attempted_count": notification_counts[
                "tracker_notification_attempted"
            ],
            "api_created_count": notification_counts[
                "tracker_notification_created"
            ],
            "failed_count": notification_counts[
                "tracker_notification_failed"
            ],
            "clicked_count": notification_counts[
                "tracker_notification_clicked"
            ],
            "auto_cleared_count": notification_counts[
                "tracker_notification_auto_cleared"
            ],
            "legacy_shown_count": notification_counts[
                "tracker_notification_shown"
            ],
            "api_created_confirms_system_display": False,
        },
    }


def strip_internal(rows):
    return [
        {key: value for key, value in row.items() if not key.startswith("_")}
        for row in rows
    ]


def write_outputs(
    out_dir,
    events,
    health,
    include_private,
    private_out_dir,
    locator_sidecar=None,
    window_start=None,
    window_end=None,
):
    os.makedirs(out_dir, exist_ok=True)
    visits = derive_visits(
        events, window_start=window_start, window_end=window_end
    )
    turns = derive_turns(
        events, window_start=window_start, window_end=window_end
    )
    private_rows, locator_keys, locator_issues = build_private_locators(
        events, locator_sidecar=locator_sidecar
    )
    legacy_raw_summary = summarize_legacy_raw_observations(events)

    safe_events = [
        {
            "timestamp": iso(event["outer_dt"]),
            "duration": event["duration"],
            "data": make_safe_data(event),
        }
        for event in events
    ]
    safe_events.extend(derive_return_events(events, visits))
    safe_events.sort(
        key=lambda outer: (
            outer["data"]["occurred_at"],
            outer["data"]["observed_at"],
            outer["data"]["source_event_id"],
        )
    )
    conversations = build_conversations(safe_events, visits, turns, locator_keys)
    coverage = build_coverage(events)

    jsonl = "".join(
        json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n"
        for event in safe_events
    )
    atomic_write_text(os.path.join(out_dir, "ai_conversation_events.jsonl"), jsonl)
    write_csv(
        os.path.join(out_dir, "ai_conversations.csv"),
        [
            "conversation_key",
            "provider",
            "surfaces",
            "identity_status",
            "first_seen_at",
            "last_seen_at",
            "event_count",
            "visit_count",
            "turn_count",
            "response_completed_count",
            "notification_suppressed_count",
            "notification_attempted_count",
            "notification_created_count",
            "notification_failed_count",
            "notification_clicked_count",
            "notification_auto_cleared_count",
            "notification_focus_succeeded_count",
            "legacy_notification_shown_count",
            "notification_count",
            "return_count",
            "engaged_count",
            "failed_turn_count",
            "cancelled_turn_count",
            "missing_response_count",
            "left_censored_turn_count",
            "right_censored_turn_count",
            "private_locator_available",
        ],
        conversations,
    )
    write_csv(
        os.path.join(out_dir, "ai_visits.csv"),
        [
            "visit_id",
            "conversation_key",
            "provider",
            "surface",
            "started_at",
            "ended_at",
            "duration_sec",
            "start_event_type",
            "end_reason",
            "window_boundary_status",
            "revisit_index",
            "event_count",
            "identity_status",
            "confidence",
        ],
        strip_internal(visits),
    )
    write_csv(
        os.path.join(out_dir, "ai_turns.csv"),
        [
            "turn_id",
            "conversation_key",
            "provider",
            "surface",
            "input_started_at",
            "submitted_at",
            "response_started_at",
            "response_ended_at",
            "outcome",
            "window_boundary_status",
            "latency_sec",
            "submit_event_id",
            "response_event_id",
            "identity_status",
            "confidence",
        ],
        strip_internal(turns),
    )
    atomic_write_text(
        os.path.join(out_dir, "ai_source_health.json"),
        json.dumps(health, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
    write_csv(
        os.path.join(out_dir, "ai_coverage.csv"),
        [
            "provider",
            "surface",
            "first_observed_at",
            "last_observed_at",
            "normalized_event_count",
            "conversation_count",
            "event_types",
        ],
        coverage,
    )

    if include_private:
        private_out_dir = private_out_dir or (os.path.abspath(out_dir) + "_private")
        os.makedirs(private_out_dir, mode=0o700, exist_ok=True)
        try:
            os.chmod(private_out_dir, 0o700)
        except OSError:
            pass
        write_csv(
            os.path.join(private_out_dir, "ai_conversation_locators_private.csv"),
            [
                "conversation_key",
                "provider",
                "surface",
                "locator_handle",
                "reopen_url",
                "namespace_generation",
                "namespace_fingerprint",
                "actuator_kind",
                "locator_provenance",
                "identity_status",
                "last_observed_at",
                "artifact_class",
            ],
            private_rows,
            mode=0o600,
        )
        opaque_count = sum(
            row["locator_provenance"] == "opaque_sidecar_v1"
            for row in private_rows
        )
        manifest = {
            "artifact_class": "development_pilot_private",
            "contains_raw_conversation_urls": False,
            "contains_provider_conversation_ids": False,
            "contains_adapter_conversation_keys": False,
            "research_return_bundle": False,
            "handling": (
                "参与者本机私有定位产物；只允许 opaque_sidecar_v1。"
                "历史 ActivityWatch raw 值绝不导出，只保留 content-free 计数。"
                "不得放入常规去标识回传包。"
            ),
            "locator_count": len(private_rows),
            "opaque_locator_count": opaque_count,
            "reopen_link_count": opaque_count,
            "available_conversation_count": len(locator_keys),
            "locator_issue_count": len(locator_issues),
            "locator_issue_codes": sorted(set(locator_issues)),
            **legacy_raw_summary,
        }
        atomic_write_text(
            os.path.join(private_out_dir, "private_artifact_manifest.json"),
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            mode=0o600,
        )
    return {
        "events": len(safe_events),
        "conversations": len(conversations),
        "visits": len(visits),
        "turns": len(turns),
        "locators": len(private_rows) if include_private else 0,
        "locator_issues": locator_issues,
        "private_out_dir": private_out_dir if include_private else None,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="ActivityWatch AI conversation event ledger（去标识事件、visit、turn）。"
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", "-i", help="ActivityWatch JSON 导出或合成 JSON/JSONL fixture。")
    source.add_argument("--rest", action="store_true", help="从本机 ActivityWatch REST 读取。")
    parser.add_argument("--host", default="http://localhost:5600")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--since", help="只保留 occurred_at >= ISO 时间。")
    parser.add_argument("--until", help="排他终点；只保留 occurred_at < ISO 时间（[start,end)）。")
    parser.add_argument(
        "--timezone",
        help="deprecated --since/--until 为无 offset 精确时间时所需的 IANA timezone。",
    )
    parser.add_argument("--start-utc", help="capture window 起点（带 offset ISO）。")
    parser.add_argument("--end-utc", help="capture window 终点（带 offset ISO，排他）。")
    parser.add_argument(
        "--capture-window-json",
        help="runner 生成的 capture_window.json；用于写入可审计 window provenance。",
    )
    parser.add_argument(
        "--observation-end",
        help=(
            "外部 capture/查询观测终点 ISO 时间；离线 strict 必须显式提供，"
            "或由带可信 provenance 的 capture_metadata 提供。"
        ),
    )
    parser.add_argument(
        "--max-source-gap-sec",
        type=float,
        default=180.0,
        help="心跳允许的最大内部/尾部间隙（默认 180 秒）。",
    )
    parser.add_argument(
        "--strict-health",
        action="store_true",
        help="source 缺失、空、无法验证、断流或降级时返回非零。",
    )
    parser.add_argument(
        "--include-private-locators",
        action="store_true",
        help=(
            "显式生成 pilot 私有 locator 与 chi27-ai-reopen 本机链接；"
            "只接受 opaque sidecar，绝不导出 raw。链接仅在已安装且有效签名的 Host 可用，"
            "是否成功仍由 Host reopen postcondition 判定。"
        ),
    )
    parser.add_argument(
        "--include-private-ai-urls",
        action="store_true",
        help="已停用；调用即固定拒绝且不生成输出。",
    )
    parser.add_argument(
        "--private-locator-sidecar",
        help=(
            "closed-schema opaque locator JSON；actuator_kind 必填且按 provider/surface "
            "closed enum 校验；semantic conflict 固定 rc=5 且不生成输出。"
            "仅与 --include-private-locators 一起使用。"
        ),
    )
    parser.add_argument(
        "--private-out-dir",
        help="私有 locator 独立目录；默认 <out-dir>_private。",
    )
    args = parser.parse_args(argv)

    if args.include_private_ai_urls:
        sys.stderr.write(DEPRECATED_PRIVATE_URL_FLAG_MESSAGE)
        return 2
    if args.max_source_gap_sec <= 0:
        parser.error("--max-source-gap-sec 必须 > 0")
    if bool(args.start_utc) != bool(args.end_utc):
        parser.error("--start-utc 与 --end-utc 必须成对提供")
    if bool(args.since) != bool(args.until):
        parser.error("deprecated --since/--until 在 finalized window 中必须成对提供")
    window_sources = sum(
        (
            bool(args.capture_window_json),
            bool(args.start_utc),
            bool(args.since),
        )
    )
    if window_sources > 1:
        parser.error(
            "--capture-window-json、--start-utc/--end-utc、--since/--until 互斥"
        )
    capture_window_obj = None
    capture_window_payload = None
    try:
        if args.capture_window_json:
            capture_window_obj = read_capture_window(args.capture_window_json)
        elif args.start_utc:
            start = parse_aware_datetime(args.start_utc, "--start-utc")
            end = parse_aware_datetime(args.end_utc, "--end-utc")
            capture_window_obj = CaptureWindow(
                session_id="standalone_window",
                start_utc=start,
                end_utc=end,
                timezone="UTC",
                source="standalone_start_end",
            ).validate()
        elif args.since:
            sys.stderr.write(
                "DEPRECATION: --since/--until 将在下一版本移除；"
                "请改用 --start-utc/--end-utc 或 --capture-window-json。\n"
            )
            capture_window_obj = CaptureWindow.legacy(
                args.since, args.until, timezone_name=args.timezone
            )
    except (CaptureWindowError, OSError, ValueError) as exc:
        parser.error(str(exc))
    since = (
        capture_window_obj.effective_start_utc if capture_window_obj else None
    )
    until = capture_window_obj.effective_end_utc if capture_window_obj else None
    if capture_window_obj:
        capture_window_payload = capture_window_obj.to_dict()
    explicit_observation_end = (
        parse_time(args.observation_end) if args.observation_end else None
    )
    if args.observation_end and explicit_observation_end is None:
        parser.error("--observation-end 不是有效 ISO 时间")
    if (
        capture_window_obj
        and explicit_observation_end
        and explicit_observation_end != capture_window_obj.effective_end_utc
    ):
        parser.error("--observation-end 必须等于 capture window 的 end")

    regular_out_dir = os.path.abspath(args.out_dir)
    if os.path.exists(regular_out_dir) and not os.path.isdir(regular_out_dir):
        sys.stderr.write("regular output 路径存在但不是目录。\n")
        return 2
    private_out_dir = None
    if args.private_out_dir and not args.include_private_locators:
        sys.stderr.write(
            "--private-out-dir 只能与 --include-private-locators 一起使用。\n"
        )
        return 2
    if args.private_locator_sidecar and not args.include_private_locators:
        sys.stderr.write(
            "--private-locator-sidecar 只能与 --include-private-locators 一起使用。\n"
        )
        return 2
    locator_sidecar = []
    if args.private_locator_sidecar:
        try:
            locator_sidecar = load_private_locator_sidecar(
                os.path.abspath(args.private_locator_sidecar)
            )
        except PrivateLocatorSemanticError as exc:
            sys.stderr.write("private locator sidecar semantic conflict: %s\n" % exc)
            return 5
        except ValueError as exc:
            sys.stderr.write("private locator sidecar 拒绝: %s\n" % exc)
            return 2
    if args.include_private_locators:
        private_out_dir = os.path.abspath(
            args.private_out_dir or (regular_out_dir + "_private")
        )
        if os.path.exists(private_out_dir) and not os.path.isdir(private_out_dir):
            sys.stderr.write("private output 路径存在但不是目录。\n")
            return 2
        if real_paths_overlap(regular_out_dir, private_out_dir):
            sys.stderr.write(
                "拒绝 private 输出：private 与 regular 目录相等或存在父子/符号链接重合。\n"
            )
            return 2
        private_unknown = unknown_entries(private_out_dir, PRIVATE_OUTPUT_ALLOWLIST)
        if private_unknown:
            sys.stderr.write(
                "拒绝复用含未知条目的 private 目录；未删除任何文件：%s\n"
                % ", ".join(private_unknown)
            )
            return 3
    regular_unknown = unknown_entries(regular_out_dir, REGULAR_OUTPUT_ALLOWLIST)
    if regular_unknown:
        sys.stderr.write(
            "拒绝复用含未知条目的 regular/send 目录；未删除任何文件：%s\n"
            % ", ".join(regular_unknown)
        )
        return 3

    try:
        buckets = (
            load_buckets_from_rest(
                args.host, start_utc=since, end_utc=until
            )
            if args.rest
            else load_buckets_from_file(args.input)
        )
    except Exception as exc:
        sys.stderr.write("AI ledger 输入读取失败: %s\n" % exc)
        return 2

    if capture_window_obj is not None:
        observation_end = capture_window_obj.effective_end_utc
        observation_end_source = "capture_window_end"
    elif explicit_observation_end is not None:
        observation_end = explicit_observation_end
        observation_end_source = "explicit_argument"
    elif args.rest:
        observation_end = datetime.now(timezone.utc)
        observation_end_source = "rest_current_utc"
    else:
        observation_end, observation_end_source = load_embedded_observation_end(
            args.input
        )
    candidate_buckets = {
        bucket_id: bucket
        for bucket_id, bucket in buckets.items()
        if bucket_is_candidate(bucket_id, bucket)
    }
    source_present = bool(candidate_buckets)
    raw_events = []
    for bucket in candidate_buckets.values():
        raw_events.extend(bucket.get("events") or [])
    if capture_window_obj is not None:
        # REST query bounds reduce transfer, then this local half-open pass is
        # authoritative for both REST and offline exports.  Invalid events with
        # a valid outer timestamp outside the window are discarded before
        # validation, so historical corruption cannot pollute this session.
        raw_events = [
            outer
            for outer in raw_events
            if point_in_window(outer, since, until, keep_invalid=True)
        ]
    source_event_count = len(raw_events)

    normalized = []
    invalid_messages = []
    sanitization_issues = []
    duplicate_count = 0
    conflict_count = 0
    seen = {}
    for index, outer in enumerate(raw_events, 1):
        event, issue = normalize_event(outer, index)
        if issue:
            invalid_messages.append(issue)
            continue
        sanitization_issues.extend(event["metadata_sanitization_issues"])
        if since and not (since <= event["occurred_dt"] < until):
            continue
        event_id = event["source_event_id_raw"]
        fingerprint = event_fingerprint(event)
        if event_id in seen:
            duplicate_count += 1
            if seen[event_id] != fingerprint:
                conflict_count += 1
            continue
        seen[event_id] = fingerprint
        normalized.append(event)
    normalized.sort(
        key=lambda event: (
            event["occurred_dt"],
            event["observed_dt"],
            event["source_event_id_raw"],
        )
    )
    alias_issues = resolve_aliases(normalized)
    turn_link_issues = validate_turn_links(normalized)
    health = assess_health(
        source_present,
        source_event_count,
        normalized,
        invalid_messages,
        sanitization_issues,
        duplicate_count,
        conflict_count,
        alias_issues,
        turn_link_issues,
        observation_end,
        observation_end_source,
        args.max_source_gap_sec,
    )
    if capture_window_payload is not None:
        health["capture_window"] = {
            "session_id": capture_window_payload["session_id"],
            "start_utc": capture_window_payload["start_utc"],
            "end_utc": capture_window_payload["end_utc"],
            "timezone": capture_window_payload["timezone"],
            "boundary": BOUNDARY,
            "source": capture_window_payload["source"],
            "counts": {
                "source_events_in_window": source_event_count,
                "normalized_events_in_window": len(normalized),
                "invalid_events_in_window": len(invalid_messages),
            },
        }
    if args.private_locator_sidecar:
        _, _, preflight_locator_issues = build_private_locators(
            normalized, locator_sidecar=locator_sidecar
        )
        if preflight_locator_issues:
            sys.stderr.write(
                "private locator semantic conflict: %s\n"
                % ", ".join(sorted(set(preflight_locator_issues)))
            )
            return 5
    summary = write_outputs(
        regular_out_dir,
        normalized,
        health,
        args.include_private_locators,
        private_out_dir,
        locator_sidecar=locator_sidecar,
        window_start=since,
        window_end=until,
    )

    sys.stdout.write("AI conversation ledger: %s\n" % health["status"])
    sys.stdout.write(
        "events=%d conversations=%d visits=%d turns=%d\n"
        % (
            summary["events"],
            summary["conversations"],
            summary["visits"],
            summary["turns"],
        )
    )
    sys.stdout.write("regular output: %s\n" % regular_out_dir)
    if summary["private_out_dir"]:
        sys.stdout.write(
            "PRIVATE pilot locator (do not return to researcher): %s\n"
            % summary["private_out_dir"]
        )
    if summary["locator_issues"]:
        sys.stderr.write(
            "private locator issues: %s\n"
            % ", ".join(sorted(set(summary["locator_issues"])))
        )
    if health["health_gaps"]:
        sys.stderr.write("health gaps: %s\n" % ", ".join(health["health_gaps"]))
    if args.strict_health and health["status"] != "healthy":
        return 4
    if args.private_locator_sidecar and summary["locator_issues"]:
        return 5
    return 0


if __name__ == "__main__":
    sys.exit(main())
