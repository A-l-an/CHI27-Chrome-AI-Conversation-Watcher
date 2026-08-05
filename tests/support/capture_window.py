#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared, fail-closed capture-window handling for the Version-C pipeline.

All finalized exports use one bounded, half-open UTC interval: ``[start, end)``.
This module intentionally reads only ActivityWatch timestamps and study-session
marker metadata.  It never inspects window titles, full URLs, prompts, or replies.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


BOUNDARY = "[start,end)"
REQUIRED_IANA_ZONES = (
    "America/New_York",
    "Asia/Shanghai",
    "Europe/London",
)
SESSION_BUCKET_PREFIX = "aw-watcher-study-sessions"
SESSION_BUCKET_TYPES = {
    "study.session.event",
    "study.session.events",
}
SESSION_SCHEMA_VERSION = "1.0"
SESSION_EVENT_STATES = {
    "study_session_started": "started",
    "study_session_stopped": "stopped",
    "study_session_cancelled": "cancelled",
}
SESSION_SOURCE = "toolbar_popup"
SESSION_CANCEL_REASON = "participant_cancelled"
SESSION_REQUIRED_OUTER_KEYS = frozenset({"timestamp", "duration", "data"})
SESSION_OUTER_KEYS = SESSION_REQUIRED_OUTER_KEYS | {"id"}
SESSION_BASE_DATA_KEYS = frozenset(
    {
        "schema_version",
        "event_type",
        "session_id",
        "occurred_at",
        "timezone",
        "utc_offset_minutes",
        "source",
        "start_utc",
    }
)
SESSION_DATA_KEYS = {
    "study_session_started": SESSION_BASE_DATA_KEYS,
    "study_session_stopped": SESSION_BASE_DATA_KEYS | {"end_utc"},
    "study_session_cancelled": (
        SESSION_BASE_DATA_KEYS | {"end_utc", "reason_code"}
    ),
}
UUID_V4_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
MARKER_UTC_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
)
CAPTURE_UTC_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$"
)
MANUAL_SESSION_ID_PATTERN = re.compile(r"^manual_[0-9a-f]{12}$")
FIXED_OFFSET_TIMEZONE_PATTERN = re.compile(
    r"^UTC(?:[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))?$"
)
CAPTURE_ID_RULES = {
    SESSION_SOURCE: UUID_V4_PATTERN,
    "manual_range": MANUAL_SESSION_ID_PATTERN,
    "legacy_since_until": MANUAL_SESSION_ID_PATTERN,
    "standalone_start_end": re.compile(r"^standalone_window$"),
}
CAPTURE_WINDOW_KEYS = frozenset(
    {
        "schema_version",
        "session_id",
        "start_utc",
        "end_utc",
        "timezone",
        "boundary",
        "source",
        "status",
        "original_window",
        "effective_window",
        "counts",
    }
)
CAPTURE_RANGE_KEYS = frozenset({"start_utc", "end_utc"})
CAPTURE_COUNT_KEYS = frozenset(
    {
        "timeline_rows",
        "web_domain_rows",
        "ai_event_rows",
        "ai_visit_rows",
        "ai_turn_rows",
        "terminal_event_rows",
        "terminal_turn_rows",
        "combined_timeline_rows",
    }
)


class CaptureWindowError(ValueError):
    """Raised when a requested export window cannot be finalized safely."""


def canonical_token(value):
    text = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    while "__" in text:
        text = text.replace("__", "_")
    return text


def parse_aware_datetime(value, field_name="time"):
    """Parse an ISO datetime and reject date-only or offset-naive values."""
    if not isinstance(value, str) or not value.strip():
        raise CaptureWindowError("%s 不能为空" % field_name)
    text = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise CaptureWindowError("%s 必须是精确 datetime，不能只有日期" % field_name)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise CaptureWindowError("%s 不是有效 ISO datetime" % field_name) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise CaptureWindowError(
            "%s 没有 UTC offset；请提供 --timezone 或带 offset 的时间" % field_name
        )
    return parsed.astimezone(timezone.utc)


def parse_event_time(value):
    """Best-effort ISO parser for source events; returns UTC or ``None``."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def format_utc(value):
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _format_marker_utc(value):
    """Match JavaScript ``Date#toISOString`` (always millisecond precision)."""
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _load_zone(timezone_name):
    if not timezone_name:
        raise CaptureWindowError("精确本地时间必须显式提供 IANA --timezone")
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise CaptureWindowError(
            "缺少或不认识 IANA timezone；Windows 内置 runtime 必须包含 tzdata"
        ) from exc


def load_iana_zone(timezone_name):
    """Public timezone resolver shared by capture and participant summaries."""
    return _load_zone(timezone_name)


def ensure_timezone_database(required_zones=REQUIRED_IANA_ZONES):
    """Fail before capture/output when the runtime lacks cross-platform tzdata."""
    missing = []
    for name in required_zones:
        try:
            ZoneInfo(name)
        except ZoneInfoNotFoundError:
            missing.append(name)
    if missing:
        raise CaptureWindowError(
            "IANA 时区数据库不完整（缺少 %s）；Windows 请使用包内 runtime，"
            "研究者环境请安装 tzdata。" % ", ".join(missing)
        )
    return True


def _windows_account_name():
    """Resolve the actual Windows token account without trusting env aliases."""
    result = subprocess.run(
        ["whoami"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
        check=False,
    )
    account = (result.stdout or "").strip()
    if (
        result.returncode != 0
        or not account
        or len(account) > 260
        or any(character in account for character in "\r\n\0")
    ):
        raise CaptureWindowError(
            "无法确认当前 Windows 账户，不能证明输出目录为私有"
        )
    return account


def _apply_windows_private_acl(path):
    """Protect one new path with a non-inherited current-user-only DACL.

    ``chmod`` mode bits are not an ACL guarantee on Windows.  ``icacls`` is a
    Windows system component; both mutation and read-back must succeed.
    """
    account = _windows_account_name()
    permission = "%s:%s" % (
        account,
        "(OI)(CI)F" if os.path.isdir(path) else "F",
    )
    result = subprocess.run(
        ["icacls", os.path.abspath(path), "/inheritance:r", "/grant:r", permission],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise CaptureWindowError(
            "Windows ACL 设置失败；不能把 chmod 当作隐私证明"
        )
    probe = subprocess.run(
        ["icacls", os.path.abspath(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
        check=False,
    )
    if probe.returncode != 0 or account.casefold() not in (probe.stdout or "").casefold():
        raise CaptureWindowError(
            "Windows ACL 回读验证失败；已停止生成可发送文件"
        )


def secure_private_path(path, mode=None):
    """Apply an OS-native privacy boundary or fail closed."""
    if os.path.islink(path):
        raise CaptureWindowError("拒绝为符号链接设置私有权限")
    if os.name == "nt":
        _apply_windows_private_acl(path)
        return
    expected = mode if mode is not None else (0o700 if os.path.isdir(path) else 0o600)
    os.chmod(path, expected)


def _is_iana_timezone(value):
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 64
        or ("/" not in value and value != "UTC")
    ):
        return False
    try:
        _load_zone(value)
    except CaptureWindowError:
        return False
    return True


def _parse_canonical_marker_utc(value):
    """Parse the exact ISO form produced by the Chrome session controller."""
    if not isinstance(value, str) or not MARKER_UTC_PATTERN.fullmatch(value):
        return None
    parsed = parse_event_time(value)
    if parsed is None or _format_marker_utc(parsed) != value:
        return None
    return parsed


def _parse_canonical_capture_utc(value):
    """Parse safe current/legacy capture-manifest UTC forms.

    Current manifests retain six microsecond digits.  Three-digit files from
    the immediately preceding bounded-capture implementation remain readable;
    both forms are canonical UTC and contain no free-form metadata.
    """
    if not isinstance(value, str) or not CAPTURE_UTC_PATTERN.fullmatch(value):
        raise CaptureWindowError("capture window 时间格式无效")
    parsed = parse_event_time(value)
    if parsed is None:
        raise CaptureWindowError("capture window 时间格式无效")
    if len(value.rsplit(".", 1)[1][:-1]) == 3:
        if _format_marker_utc(parsed) != value:
            raise CaptureWindowError("capture window 时间格式无效")
    elif format_utc(parsed) != value:
        raise CaptureWindowError("capture window 时间格式无效")
    return parsed


def _localize_strict(naive, timezone_name, field_name):
    """Attach an IANA zone while rejecting ambiguous/non-existent DST times."""
    zone = _load_zone(timezone_name)
    candidates = [
        naive.replace(tzinfo=zone, fold=fold)
        for fold in (0, 1)
    ]
    valid = []
    for candidate in candidates:
        roundtrip = (
            candidate.astimezone(timezone.utc)
            .astimezone(zone)
            .replace(tzinfo=None)
        )
        if roundtrip == naive:
            valid.append(candidate)
    if not valid:
        raise CaptureWindowError(
            "%s 落在 DST 跳时形成的不存在本地时间内" % field_name
        )
    offsets = {candidate.utcoffset() for candidate in valid}
    if len(offsets) > 1:
        raise CaptureWindowError(
            "%s 是 DST 回拨形成的歧义本地时间；请改用带 offset 的 ISO 时间" % field_name
        )
    return valid[0]


def parse_local_datetime(value, timezone_name, field_name):
    """Parse a local datetime under an explicit IANA timezone.

    Values carrying an offset remain authoritative but are still converted
    through the requested zone for a consistent provenance label.
    """
    if not isinstance(value, str) or not value.strip():
        raise CaptureWindowError("%s 不能为空" % field_name)
    text = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise CaptureWindowError("%s 必须包含具体时分秒" % field_name)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise CaptureWindowError("%s 不是有效 ISO datetime" % field_name) from exc
    zone = _load_zone(timezone_name)
    if parsed.tzinfo is None:
        parsed = _localize_strict(parsed, timezone_name, field_name)
    else:
        parsed = parsed.astimezone(zone)
    return parsed.astimezone(timezone.utc)


def _fixed_offset_label(offset):
    if offset is None:
        raise CaptureWindowError("legacy 时间缺少 UTC offset")
    total_seconds = offset.total_seconds()
    if total_seconds % 60:
        raise CaptureWindowError("legacy UTC offset 必须为整分钟")
    total_minutes = int(total_seconds // 60)
    if not -840 <= total_minutes <= 840:
        raise CaptureWindowError("legacy UTC offset 超出安全范围")
    if total_minutes == 0:
        return "UTC"
    sign = "+" if total_minutes > 0 else "-"
    total_minutes = abs(total_minutes)
    return "UTC%s%02d:%02d" % (
        sign,
        total_minutes // 60,
        total_minutes % 60,
    )


def _parse_legacy_endpoint(value, timezone_name, is_end, field_name):
    """Parse one deprecated --since/--until endpoint.

    Date-only endpoints require an explicit IANA timezone.
    ``until=YYYY-MM-DD`` becomes the next local midnight, preserving the new
    half-open boundary exactly.
    """
    if not isinstance(value, str) or not value.strip():
        raise CaptureWindowError("%s 不能为空" % field_name)
    text = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        parsed_date = date.fromisoformat(text)
        if is_end:
            parsed_date += timedelta(days=1)
        naive = datetime.combine(parsed_date, time.min)
        if timezone_name:
            aware = _localize_strict(naive, timezone_name, field_name)
            return aware.astimezone(timezone.utc), timezone_name
        raise CaptureWindowError(
            "deprecated date-only --since/--until 必须显式提供 IANA --timezone"
        )

    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise CaptureWindowError("%s 不是有效 ISO datetime" % field_name) from exc
    if parsed.tzinfo is None:
        if not timezone_name:
            raise CaptureWindowError(
                "%s 是无 offset 的精确时间；必须显式提供 --timezone" % field_name
            )
        parsed = _localize_strict(parsed, timezone_name, field_name)
        label = timezone_name
    else:
        if timezone_name:
            zone_offset = parsed.astimezone(
                _load_zone(timezone_name)
            ).utcoffset()
            if zone_offset != parsed.utcoffset():
                raise CaptureWindowError(
                    "legacy datetime offset 与 IANA --timezone 不一致"
                )
        label = timezone_name or _fixed_offset_label(parsed.utcoffset())
    return parsed.astimezone(timezone.utc), label


def _manual_session_id(start_utc, end_utc):
    digest = hashlib.sha256(
        ("%s|%s" % (format_utc(start_utc), format_utc(end_utc))).encode("utf-8")
    ).hexdigest()[:12]
    return "manual_%s" % digest


@dataclass(frozen=True)
class CaptureWindow:
    session_id: str
    start_utc: datetime
    end_utc: datetime
    timezone: str
    source: str
    status: str = "completed"
    boundary: str = BOUNDARY
    original_start_utc: Optional[datetime] = None
    original_end_utc: Optional[datetime] = None

    def _validate_contract(self):
        if self.start_utc.tzinfo is None or self.end_utc.tzinfo is None:
            raise CaptureWindowError("capture window 必须使用 aware datetime")
        if self.end_utc <= self.start_utc:
            raise CaptureWindowError("capture window 的 end 必须晚于 start")
        if self.status != "completed":
            raise CaptureWindowError("capture window status 必须是 completed")
        if self.boundary != BOUNDARY:
            raise CaptureWindowError("capture window boundary 必须是 %s" % BOUNDARY)
        id_rule = (
            CAPTURE_ID_RULES.get(self.source)
            if isinstance(self.source, str)
            else None
        )
        if (
            id_rule is None
            or not isinstance(self.session_id, str)
            or not id_rule.fullmatch(self.session_id)
        ):
            raise CaptureWindowError("capture window source/session_id 不符合契约")
        timezone_valid = _is_iana_timezone(self.timezone)
        if (
            self.source == "legacy_since_until"
            and isinstance(self.timezone, str)
            and FIXED_OFFSET_TIMEZONE_PATTERN.fullmatch(self.timezone)
        ):
            timezone_valid = True
        if self.source == "standalone_start_end":
            timezone_valid = self.timezone == "UTC"
        if not timezone_valid:
            raise CaptureWindowError("capture window timezone 不符合安全契约")
        original_start = self.original_start_utc or self.start_utc
        original_end = self.original_end_utc or self.end_utc
        if (
            original_start.tzinfo is None
            or original_end.tzinfo is None
            or original_end <= original_start
            or original_start > self.start_utc
            or original_end < self.end_utc
        ):
            raise CaptureWindowError("capture window original_window 无效")
        return self

    def validate(self, now=None):
        self._validate_contract()
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if self.end_utc > now:
            raise CaptureWindowError("capture window 的 end 位于未来，拒绝 finalized export")
        return self

    @property
    def effective_start_utc(self):
        return self.start_utc.astimezone(timezone.utc)

    @property
    def effective_end_utc(self):
        return self.end_utc.astimezone(timezone.utc)

    @property
    def short_session_id(self):
        self._validate_contract()
        if self.source == SESSION_SOURCE:
            return self.session_id.split("-", 1)[0].lower()
        if self.source in {"manual_range", "legacy_since_until"}:
            return self.session_id.replace("_", "")
        return "standalone"

    @property
    def output_slug(self):
        stamp = self.effective_start_utc.strftime("%Y-%m-%dT%H%M%SZ")
        return "%s_%s" % (stamp, self.short_session_id)

    def to_dict(self, counts=None):
        self._validate_contract()
        safe_counts = {}
        for key, value in dict(counts or {}).items():
            if (
                key not in CAPTURE_COUNT_KEYS
                or isinstance(value, bool)
                or not isinstance(value, int)
                or value < 0
            ):
                raise CaptureWindowError("capture window counts 不符合契约")
            safe_counts[key] = value
        original_start = self.original_start_utc or self.start_utc
        original_end = self.original_end_utc or self.end_utc
        return {
            "schema_version": "1.0",
            "session_id": self.session_id,
            "start_utc": format_utc(self.effective_start_utc),
            "end_utc": format_utc(self.effective_end_utc),
            "timezone": self.timezone,
            "boundary": self.boundary,
            "source": self.source,
            "status": "completed",
            "original_window": {
                "start_utc": format_utc(original_start),
                "end_utc": format_utc(original_end),
            },
            "effective_window": {
                "start_utc": format_utc(self.effective_start_utc),
                "end_utc": format_utc(self.effective_end_utc),
            },
            "counts": safe_counts,
        }

    @classmethod
    def manual(cls, start_local, end_local, timezone_name, now=None):
        start = parse_local_datetime(start_local, timezone_name, "--start-local")
        end = parse_local_datetime(end_local, timezone_name, "--end-local")
        return cls(
            session_id=_manual_session_id(start, end),
            start_utc=start,
            end_utc=end,
            timezone=timezone_name,
            source="manual_range",
        ).validate(now=now)

    @classmethod
    def legacy(cls, since, until, timezone_name=None, now=None):
        if not since or not until:
            raise CaptureWindowError(
                "deprecated --since/--until 在 finalized export 中必须成对提供"
            )
        start, start_zone = _parse_legacy_endpoint(
            since, timezone_name, False, "--since"
        )
        end, end_zone = _parse_legacy_endpoint(
            until, timezone_name, True, "--until"
        )
        if not timezone_name and start_zone != end_zone:
            raise CaptureWindowError(
                "legacy endpoints 的 UTC offset 不一致；请显式提供 IANA --timezone"
            )
        zone_label = timezone_name or start_zone
        return cls(
            session_id=_manual_session_id(start, end),
            start_utc=start,
            end_utc=end,
            timezone=zone_label,
            source="legacy_since_until",
        ).validate(now=now)


@dataclass(frozen=True)
class StudySession:
    session_id: str
    start_utc: Optional[datetime]
    end_utc: Optional[datetime]
    timezone: str
    source: str
    status: str
    original_start_utc: Optional[datetime] = None
    original_end_utc: Optional[datetime] = None

    def to_window(self, now=None):
        if self.status == "active":
            raise CaptureWindowError("session %s 尚未停止" % self.session_id)
        if self.status == "cancelled":
            raise CaptureWindowError("session %s 已取消" % self.session_id)
        if self.status != "completed" or not self.start_utc or not self.end_utc:
            raise CaptureWindowError("session %s 不完整" % self.session_id)
        return CaptureWindow(
            session_id=self.session_id,
            start_utc=self.start_utc,
            end_utc=self.end_utc,
            timezone=self.timezone or "UTC",
            source=self.source or "session_marker",
            status="completed",
            original_start_utc=self.original_start_utc or self.start_utc,
            original_end_utc=self.original_end_utc or self.end_utc,
        ).validate(now=now)


def is_session_bucket(bucket_id, bucket):
    bid = str(bucket_id or "").lower()
    btype = canonical_token((bucket or {}).get("type", ""))
    return bid.startswith(SESSION_BUCKET_PREFIX) or btype in {
        canonical_token(item) for item in SESSION_BUCKET_TYPES
    }


def coerce_buckets(payload):
    if not isinstance(payload, dict):
        raise CaptureWindowError("ActivityWatch export 顶层必须是对象")
    if isinstance(payload.get("buckets"), dict):
        source = payload["buckets"]
    elif isinstance(payload.get("events"), list):
        source = {str(payload.get("id") or "unknown_bucket"): payload}
    else:
        source = payload
    buckets = {}
    for bucket_id, bucket in source.items():
        if not isinstance(bucket, dict) or not isinstance(bucket.get("events"), list):
            continue
        buckets[str(bucket_id)] = {
            "type": bucket.get("type", ""),
            "events": bucket.get("events") or [],
        }
    return buckets


def _safe_marker_identity(outer):
    """Return only non-sensitive grouping/order fields from an invalid marker."""
    if not isinstance(outer, dict):
        return None, None
    data = outer.get("data")
    raw_session_id = data.get("session_id") if isinstance(data, dict) else None
    session_id = (
        raw_session_id.lower()
        if isinstance(raw_session_id, str)
        and UUID_V4_PATTERN.fullmatch(raw_session_id)
        else None
    )
    try:
        occurred = parse_aware_datetime(
            outer.get("timestamp"), "session marker timestamp"
        )
    except CaptureWindowError:
        occurred = None
    return session_id, occurred


def _validate_session_marker(outer):
    """Validate and project one current 08 session marker.

    The projection intentionally contains no unknown input fields.  Callers get
    a safe UUID/time hint on rejection so the whole affected session can be
    poisoned without retaining a canary from the rejected marker.
    """
    poison_id, poison_time = _safe_marker_identity(outer)
    if not isinstance(outer, dict):
        return None, poison_id, poison_time
    keys = frozenset(outer)
    if (
        not SESSION_REQUIRED_OUTER_KEYS.issubset(keys)
        or not keys.issubset(SESSION_OUTER_KEYS)
    ):
        return None, poison_id, poison_time
    if "id" in outer and (
        isinstance(outer["id"], bool)
        or not isinstance(outer["id"], int)
        or outer["id"] < 0
    ):
        return None, poison_id, poison_time
    if (
        isinstance(outer.get("duration"), bool)
        or not isinstance(outer.get("duration"), (int, float))
        or outer.get("duration") != 0
    ):
        return None, poison_id, poison_time
    data = outer.get("data")
    if not isinstance(data, dict):
        return None, poison_id, poison_time
    event_type = data.get("event_type")
    required_data_keys = SESSION_DATA_KEYS.get(event_type)
    if required_data_keys is None or frozenset(data) != required_data_keys:
        return None, poison_id, poison_time
    raw_session_id = data.get("session_id")
    if (
        data.get("schema_version") != SESSION_SCHEMA_VERSION
        or not isinstance(raw_session_id, str)
        or not UUID_V4_PATTERN.fullmatch(raw_session_id)
        or data.get("source") != SESSION_SOURCE
        or not _is_iana_timezone(data.get("timezone"))
        or isinstance(data.get("utc_offset_minutes"), bool)
        or not isinstance(data.get("utc_offset_minutes"), int)
        or not -840 <= data["utc_offset_minutes"] <= 840
    ):
        return None, poison_id, poison_time

    occurred = _parse_canonical_marker_utc(data.get("occurred_at"))
    start = _parse_canonical_marker_utc(data.get("start_utc"))
    try:
        outer_time = parse_aware_datetime(
            outer.get("timestamp"), "session marker timestamp"
        )
    except CaptureWindowError:
        outer_time = None
    if (
        occurred is None
        or start is None
        or outer_time is None
        or abs((outer_time - occurred).total_seconds()) > 0.001
    ):
        return None, poison_id, poison_time

    end = None
    if event_type == "study_session_started":
        if start != occurred:
            return None, poison_id, poison_time
    else:
        end = _parse_canonical_marker_utc(data.get("end_utc"))
        if end is None or end != occurred or end < start:
            return None, poison_id, poison_time
        if (
            event_type == "study_session_cancelled"
            and data.get("reason_code") != SESSION_CANCEL_REASON
        ):
            return None, poison_id, poison_time

    return (
        {
            "session_id": raw_session_id.lower(),
            "event_type": event_type,
            "state": SESSION_EVENT_STATES[event_type],
            "occurred_at": occurred,
            "start_utc": start,
            "end_utc": end,
            "timezone": data["timezone"],
            "utc_offset_minutes": data["utc_offset_minutes"],
            "source": SESSION_SOURCE,
        },
        poison_id,
        poison_time,
    )


def _looks_like_session_marker(outer):
    if not isinstance(outer, dict):
        return False
    data = outer.get("data")
    if not isinstance(data, dict):
        return False
    event_type = data.get("event_type")
    if isinstance(event_type, str) and event_type.startswith("study_session_"):
        return True
    return bool(
        {
            "schema_version",
            "session_id",
            "occurred_at",
            "start_utc",
            "end_utc",
            "utc_offset_minutes",
        }
        & set(data)
    )


def _invalid_study_session(session_id, occurred):
    return StudySession(
        session_id=session_id or "",
        start_utc=occurred,
        end_utc=None,
        timezone="UTC",
        source=SESSION_SOURCE,
        status="invalid",
    )


def reconstruct_sessions(buckets):
    """Reconstruct session state from append-only marker events."""
    grouped = {}
    poisoned = {}
    anonymous_invalid = []
    for bucket_id, bucket in buckets.items():
        if not is_session_bucket(bucket_id, bucket):
            continue
        for outer in bucket.get("events") or []:
            if not _looks_like_session_marker(outer):
                continue
            marker, poison_id, poison_time = _validate_session_marker(outer)
            if marker is None:
                if poison_id:
                    previous = poisoned.get(poison_id)
                    if previous is None or (
                        poison_time is not None
                        and (previous is None or poison_time > previous)
                    ):
                        poisoned[poison_id] = poison_time
                else:
                    anonymous_invalid.append(poison_time)
                continue
            grouped.setdefault(marker["session_id"], []).append(marker)

    sessions = []
    all_safe_ids = set(grouped) | set(poisoned)
    for session_id in all_safe_ids:
        markers = grouped.get(session_id, [])
        if session_id in poisoned:
            safe_times = [
                marker["occurred_at"] for marker in markers
            ] + [poisoned[session_id]]
            occurred = max((item for item in safe_times if item is not None), default=None)
            sessions.append(_invalid_study_session(session_id, occurred))
            continue

        # Reliable delivery may repeat an identical marker.  Deduplicate only
        # exact safe projections; conflicting/repeated lifecycle states poison
        # the whole session.
        unique = {}
        for marker in markers:
            key = (
                marker["event_type"],
                marker["occurred_at"],
                marker["start_utc"],
                marker["end_utc"],
                marker["timezone"],
                marker["utc_offset_minutes"],
                marker["source"],
            )
            unique[key] = marker
        markers = sorted(unique.values(), key=lambda item: item["occurred_at"])
        starts = [item for item in markers if item["state"] == "started"]
        terminals = [
            item for item in markers if item["state"] in {"stopped", "cancelled"}
        ]
        invalid = (
            len(starts) != 1
            or len(terminals) > 1
            or any(item["start_utc"] != starts[0]["start_utc"] for item in markers)
            if starts
            else True
        )
        if not invalid and any(
            item["timezone"] != starts[0]["timezone"]
            or item["source"] != SESSION_SOURCE
            for item in markers
        ):
            invalid = True
        if invalid:
            occurred = max(
                (item["occurred_at"] for item in markers),
                default=None,
            )
            sessions.append(_invalid_study_session(session_id, occurred))
            continue

        start_marker = starts[0]
        start = start_marker["start_utc"]
        terminal = terminals[0] if terminals else None
        end = terminal["end_utc"] if terminal else None
        status = (
            "active"
            if terminal is None
            else "completed"
            if terminal["state"] == "stopped"
            else "cancelled"
        )
        sessions.append(
            StudySession(
                session_id=session_id,
                start_utc=start,
                end_utc=end,
                timezone=start_marker["timezone"],
                source=SESSION_SOURCE,
                status=status,
                original_start_utc=start,
                original_end_utc=end,
            )
        )
    for occurred in anonymous_invalid:
        sessions.append(_invalid_study_session("", occurred))
    sessions.sort(
        key=lambda item: (
            item.start_utc
            or item.end_utc
            or datetime.max.replace(tzinfo=timezone.utc),
            item.session_id,
        ),
        reverse=True,
    )
    return sessions


def select_session(sessions, session_id=None, latest=False, now=None):
    if session_id:
        matches = [item for item in sessions if item.session_id == session_id]
        if not matches:
            raise CaptureWindowError("找不到指定 session_id")
        return matches[0].to_window(now=now)
    if not latest:
        raise CaptureWindowError("必须指定 session_id 或 latest session")
    if not sessions:
        raise CaptureWindowError("没有可导出的 session")
    newest = max(
        sessions,
        key=lambda item: (
            item.start_utc
            or item.end_utc
            or datetime.max.replace(tzinfo=timezone.utc),
            item.session_id,
        ),
    )
    if newest.status != "completed":
        raise CaptureWindowError(
            "最新 session 状态为 %s；拒绝静默回退到更早场次"
            % newest.status
        )
    return newest.to_window(now=now)


def load_sessions_from_export(path):
    with open(path, "r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    return reconstruct_sessions(coerce_buckets(payload))


def build_events_url(host, bucket_id, start_utc=None, end_utc=None):
    endpoint = "%s/api/0/buckets/%s/events" % (
        host.rstrip("/"),
        quote(str(bucket_id), safe=""),
    )
    params = {}
    if start_utc is not None:
        params["start"] = format_utc(start_utc)
    if end_utc is not None:
        params["end"] = format_utc(end_utc)
    return endpoint + (("?" + urlencode(params)) if params else "")


def load_sessions_from_rest(host, get_json=None):
    """Read only the content-free study-session marker bucket."""
    if get_json is None:
        import urllib.error
        import urllib.request

        def get_json(url):
            request = urllib.request.Request(
                url, headers={"Accept": "application/json"}
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.URLError as exc:
                raise RuntimeError("无法连接 ActivityWatch: %s" % exc)

    listing = get_json(host.rstrip("/") + "/api/0/buckets/")
    if not isinstance(listing, dict):
        raise CaptureWindowError("ActivityWatch buckets API 返回格式异常")
    buckets = {}
    for bucket_id, metadata in listing.items():
        bucket = metadata if isinstance(metadata, dict) else {}
        probe = {"type": bucket.get("type", ""), "events": []}
        if not is_session_bucket(bucket_id, probe):
            continue
        events = get_json(build_events_url(host, bucket_id))
        buckets[str(bucket_id)] = {
            "type": bucket.get("type", ""),
            "events": events if isinstance(events, list) else [],
        }
    return reconstruct_sessions(buckets)


def event_point_time(event):
    """Prefer canonical occurred_at, then ActivityWatch outer timestamp."""
    if not isinstance(event, dict):
        return None
    data = event.get("data")
    if isinstance(data, dict):
        occurred = parse_event_time(data.get("occurred_at"))
        if occurred is not None:
            return occurred
    return parse_event_time(event.get("timestamp"))


def point_in_window(event, start_utc, end_utc, keep_invalid=True):
    point = event_point_time(event)
    if point is None:
        return bool(keep_invalid)
    return start_utc <= point < end_utc


def clip_interval_event(event, start_utc, end_utc):
    """Clip one AW interval to the overlap with ``[start,end)``.

    A duration-zero event is treated as a point.  The data object is copied
    without inspecting any of its fields.
    """
    if not isinstance(event, dict):
        return None
    event_start = parse_event_time(event.get("timestamp"))
    if event_start is None:
        return None
    try:
        duration = max(0.0, float(event.get("duration", 0) or 0))
    except (TypeError, ValueError):
        duration = 0.0
    if duration == 0:
        return copy.deepcopy(event) if start_utc <= event_start < end_utc else None
    event_end = event_start + timedelta(seconds=duration)
    clipped_start = max(event_start, start_utc)
    clipped_end = min(event_end, end_utc)
    if clipped_end <= clipped_start:
        return None
    clipped = copy.deepcopy(event)
    clipped["timestamp"] = format_utc(clipped_start)
    clipped["duration"] = (clipped_end - clipped_start).total_seconds()
    return clipped


def clip_bucket_events(buckets, start_utc, end_utc, interval=True):
    """Return a defensive local second-pass windowed copy of bucket events."""
    clipped_buckets = {}
    for bucket_id, bucket in buckets.items():
        events = []
        for event in bucket.get("events") or []:
            if interval:
                clipped = clip_interval_event(event, start_utc, end_utc)
                if clipped is not None:
                    events.append(clipped)
            elif point_in_window(event, start_utc, end_utc, keep_invalid=True):
                events.append(copy.deepcopy(event))
        clipped_buckets[str(bucket_id)] = {
            "type": bucket.get("type", ""),
            "events": events,
        }
    return clipped_buckets


def allocate_unique_path(base_path, mode=0o700):
    """Atomically claim and return a unique directory.

    ``exists`` followed by ``makedirs`` is racy when a launcher is double
    clicked.  The kernel's exclusive directory creation is the allocator; a
    collision advances to ``_r2``, ``_r3``, and so on without reusing data.
    """
    parent = os.path.dirname(os.path.abspath(base_path))
    os.makedirs(parent, exist_ok=True)
    index = 1
    while True:
        candidate = base_path if index == 1 else "%s_r%d" % (base_path, index)
        try:
            os.makedirs(candidate, mode=mode, exist_ok=False)
        except FileExistsError:
            index += 1
            continue
        try:
            secure_private_path(candidate, mode=mode)
            return candidate
        except BaseException:
            try:
                os.rmdir(candidate)
            except OSError:
                pass
            raise


def read_capture_window(path, now=None):
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict) or frozenset(payload) != CAPTURE_WINDOW_KEYS:
        raise CaptureWindowError("capture_window.json 顶层字段不符合契约")
    if (
        payload.get("schema_version") != "1.0"
        or payload.get("boundary") != BOUNDARY
        or payload.get("status") != "completed"
    ):
        raise CaptureWindowError("capture_window.json schema/status/boundary 无效")
    effective = payload.get("effective_window")
    original = payload.get("original_window")
    if (
        not isinstance(effective, dict)
        or frozenset(effective) != CAPTURE_RANGE_KEYS
        or not isinstance(original, dict)
        or frozenset(original) != CAPTURE_RANGE_KEYS
    ):
        raise CaptureWindowError("capture_window.json range 字段不符合契约")
    counts = payload.get("counts")
    if not isinstance(counts, dict):
        raise CaptureWindowError("capture_window.json counts 无效")
    for key, value in counts.items():
        if (
            key not in CAPTURE_COUNT_KEYS
            or isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
        ):
            raise CaptureWindowError("capture_window.json counts 无效")

    start = _parse_canonical_capture_utc(effective.get("start_utc"))
    end = _parse_canonical_capture_utc(effective.get("end_utc"))
    top_start = _parse_canonical_capture_utc(payload.get("start_utc"))
    top_end = _parse_canonical_capture_utc(payload.get("end_utc"))
    original_start = _parse_canonical_capture_utc(original.get("start_utc"))
    original_end = _parse_canonical_capture_utc(original.get("end_utc"))
    if top_start != start or top_end != end:
        raise CaptureWindowError("capture_window.json 顶层与 effective_window 不一致")
    return CaptureWindow(
        session_id=payload.get("session_id"),
        start_utc=start,
        end_utc=end,
        timezone=payload.get("timezone"),
        source=payload.get("source"),
        status=payload.get("status"),
        boundary=payload.get("boundary"),
        original_start_utc=original_start,
        original_end_utc=original_end,
    ).validate(now=now)
