"""Versioned, read-only market-session rules used by quote presentation.

The registry deliberately stays conservative. A missing or out-of-scope rule
is ``unknown``; it never becomes ``scheduled_open`` merely because a provider
request succeeded.
"""

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

CALENDAR_RULES = (
    {
        "source": "dukascopy",
        "version": "dukascopy-spot-v1",
        "scope": "XAU/USD and EUR/USD in the provider catalog",
        "timezone": "America/New_York",
        "regular_hours": "周日 17:00 至周五 17:00（纽约时间）；XAU/USD 每日 17:00-18:00 暂停",
        "status": "verified",
        "checked_at": "2026-10-10",
        "review_due_at": "2026-11-10",
        "valid_from": "2026-01-01",
        "valid_until": "2027-03-31",
        "evidence": [
            "https://www.dukascopy.com/swiss/english/forex/forex-trading-accounts/link/",
            "https://www.dukascopy.com/swiss/english/marketwatch/trading-breaks-calendar/",
            "https://www.dukascopy.com/swiss/english/forex/forex-trading-accounts/overnight/",
        ],
        "mappings": ("XAU/USD", "EUR/USD"),
        "exceptions": (),
    },
    {
        "source": "oanda",
        "version": "oanda-account-scope-pending-v1",
        "scope": "实际账户实体、通道和产品映射待核实",
        "timezone": "America/New_York",
        "regular_hours": "未发布通用规则；按账户产品核实",
        "status": "unverified",
        "checked_at": "2026-10-10",
        "review_due_at": "2026-11-10",
        "valid_from": None,
        "valid_until": None,
        "evidence": ["https://developer.oanda.com/rest-live-v20/instrument-ep/"],
        "mappings": ("EUR_USD", "XAU_USD"),
        "exceptions": (
            {"date": "2026-04-03", "reason": "Good Friday", "hours": "US energies and metals closed",
             "source": "https://www.oanda.com/sg-en/trading/holiday-trading-hours/"},
            {"date": "2026-05-25", "reason": "Memorial Day", "hours": "US energies and metals close 14:29; gold reopens 18:05 ET",
             "source": "https://www.oanda.com/sg-en/trading/holiday-trading-hours/"},
            {"date": "2026-07-03", "reason": "Independence Day observed", "hours": "US energies and metals close 12:59 ET",
             "source": "https://www.oanda.com/sg-en/trading/holiday-trading-hours/"},
            {"date": "2026-09-07", "reason": "Labor Day", "hours": "US energies and metals close 14:29 ET; reopen 18:01 ET",
             "source": "https://www.oanda.com/sg-en/trading/holiday-trading-hours/"},
        ),
    },
    {
        "source": "binance",
        "version": "binance-spot-hours-pending-v1",
        "scope": "Binance Spot BTCUSDT；常规交易时段及交易对状态待官方证据核实",
        "timezone": "Etc/UTC",
        "regular_hours": "全天候候选尚未认证；临时维护和交易对状态单独核实",
        "status": "unverified",
        "checked_at": None,
        "review_due_at": "2026-11-10",
        "valid_from": None,
        "valid_until": None,
        "evidence": ["https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-endpoints"],
        "mappings": ("BTCUSDT",),
        "exceptions": (),
    },
    {
        "source": "yahoo",
        "version": "yahoo-exchange-mapping-pending-v1",
        "scope": "必须按 Yahoo 返回的交易所和资产类别逐项核实",
        "timezone": "exchange",
        "regular_hours": "未核实；不能把外汇、加密和证券共用一个时段",
        "status": "unverified",
        "checked_at": "2026-10-10",
        "review_due_at": "2026-11-10",
        "valid_from": None,
        "valid_until": None,
        "evidence": ["https://finance.yahoo.com/"],
        "mappings": (),
        "exceptions": (),
    },
    {
        "source": "akshare", "version": "akshare-source-date-pending-v1",
        "scope": "按具体市场、上游和品种保留来源交易日；市场会话尚未核实",
        "timezone": "exchange", "regular_hours": "未核实；不推断夜盘交易日或节假日闭市",
        "status": "unverified", "checked_at": None, "review_due_at": None,
        "valid_from": None, "valid_until": None, "evidence": [], "mappings": (), "exceptions": (),
    },
)

_RULE_BY_SOURCE = {item["source"]: item for item in CALENDAR_RULES}


def observation_identity(source: str, symbol: str, metadata: dict | None = None):
    """Actual adapter/data identity, never an identity copied from a rule."""
    metadata = metadata or {}
    explicit = metadata.get("source_identity") or metadata.get("native_identity") or metadata.get("native_period_identity")
    if isinstance(explicit, dict):
        return {key: explicit.get(key) for key in (
            "source", "channel", "environment", "provider_symbol", "account_scope")}
    if source == "oanda":
        from .history_catalog import account_scope

        return {"source": source, "channel": "v20", "environment": "practice",
                "provider_symbol": symbol, "account_scope": account_scope()}
    if source == "fxcm":
        from .fxcm_history import account_scope, configured
        return {"source": source, "channel": "forexconnect", "environment": "demo",
                "provider_symbol": symbol, "account_scope": account_scope() if configured() else "unconfigured"}
    channel, environment = {
        "dukascopy": ("json3", "historical"), "binance": ("rest", "public"),
        "yahoo": ("yfinance", "public"), "akshare": ("python", "public"),
    }.get(source, (None, None))
    return {"source": source, "channel": channel, "environment": environment,
            "provider_symbol": symbol, "account_scope": "public"}


def canonical_symbol(source: str, symbol: str) -> str:
    """Normalize provider and managed catalog spellings before rule lookup."""
    value = str(symbol or "").strip().upper().replace("_", "/")
    if source == "dukascopy":
        compact = value.replace("/", "")
        return {"XAUUSD": "XAU/USD", "EURUSD": "EUR/USD"}.get(compact, value)
    return value


def rule_for(source: str, symbol: str | None = None):
    rule = _RULE_BY_SOURCE.get(source)
    if not rule:
        return None
    if rule["mappings"] and symbol and symbol not in rule["mappings"]:
        return None
    if rule["mappings"] and not symbol:
        return None
    return rule


def _local_minute(stamp: int, timezone: str):
    return datetime.fromtimestamp(stamp / 1000, UTC).astimezone(ZoneInfo(timezone))


def _unknown(version=None):
    return {"market_session": "unknown", "session_reason": None,
            "calendar_verified": False, "calendar_version": version}


def effective_rule_status(rule: dict, *, as_of: datetime | None = None) -> str:
    """Return the read-time state of a versioned registry row.

    ``review_due_at`` is a maintenance signal, while ``valid_until`` is a
    hard applicability boundary. Both are evaluated at read time so a stale
    registry cannot silently continue to certify an open session.
    """
    if rule.get("status") != "verified":
        return "unverified"
    moment = as_of or datetime.now(UTC)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    current = moment.astimezone(UTC).date()
    if rule.get("valid_from") and current < date.fromisoformat(rule["valid_from"]):
        return "not_yet_valid"
    if rule.get("valid_until") and current > date.fromisoformat(rule["valid_until"]):
        return "expired"
    if rule.get("review_due_at") and current > date.fromisoformat(rule["review_due_at"]):
        return "review_due"
    return "verified"


def _reviewed_profile_status(source: str, symbol: str, stamp: int, metadata: dict):
    """Use an account-bound finite profile when one was actually reviewed.

    The generic registry is intentionally unable to certify an account-specific
    session. Profiles produced by the existing source-calendar workflow carry
    their identity in ``source_session``; delegating to ``live_session`` keeps
    its DST, boundary-minute and expiry rules as the single authority.
    """
    from .live_session import effective_profile
    from .live_session import session_status as reviewed_status

    identity = observation_identity(source, metadata.get("symbol") or symbol, metadata)
    original = metadata.get("calendar_profile")
    profile = effective_profile(identity, original)
    source_session = profile.get("source_session") if isinstance(profile, dict) else None
    if not isinstance(source_session, dict) or source_session.get("source") != source:
        return None
    if profile is original and metadata.get("calendar_verified") is False:
        return _unknown(profile.get("revision"))
    if canonical_symbol(source, source_session.get("provider_symbol")) != symbol:
        return _unknown(profile.get("revision"))
    version = profile.get("revision") or metadata.get("calendar_version")
    if identity.get("source") != source or canonical_symbol(source, identity.get("provider_symbol")) != symbol:
        return _unknown(version)
    try:
        state = reviewed_status(identity, profile, stamp)
        if not state.get("calendar_verified"):
            return _unknown(version)
        local = _local_minute(stamp, source_session["timezone"])
        moment = datetime.fromtimestamp(stamp / 1000, UTC)
        reason = None
        for closure in profile.get("closures", ()):
            start = datetime.fromisoformat(str(closure["start"]).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(closure["end"]).replace("Z", "+00:00"))
            if start <= moment < end:
                reason = closure.get("reason")
                break
        if state["market_session"] == "closed" and reason is None:
            reason = "周末" if local.weekday() in (5, 6) else "每日暂停"
        return {**state, "session_reason": reason, "calendar_version": version}
    except (KeyError, TypeError, ValueError, OverflowError):
        # A malformed, incomplete, or expired account profile must not turn a
        # provider response into an asserted open session.
        return _unknown(version)


def _builtin_status(source: str, symbol: str, stamp: int):
    """Evaluate only the versioned built-in registry, without profiles."""
    if source == "dukascopy" and symbol in ("XAU/USD", "EUR/USD"):
        rule = rule_for(source, symbol)
        moment = datetime.fromtimestamp(stamp / 1000, UTC)
        if effective_rule_status(rule, as_of=moment) not in ("verified", "review_due"):
            return _unknown(rule["version"])
        local = _local_minute(stamp, rule["timezone"])
        weekday, minute = local.weekday(), local.hour * 60 + local.minute
        if weekday == 5 or (weekday == 4 and minute >= 17 * 60) or (weekday == 6 and minute < 17 * 60):
            return {"market_session": "closed", "session_reason": "周末", "calendar_verified": True,
                    "calendar_version": rule["version"]}
        if symbol == "XAU/USD" and minute >= 17 * 60 and minute < 18 * 60:
            return {"market_session": "closed", "session_reason": "每日暂停", "calendar_verified": True,
                    "calendar_version": rule["version"]}
        return {"market_session": "scheduled_open", "session_reason": None, "calendar_verified": True,
                "calendar_version": rule["version"]}
    if source == "binance" and symbol == "BTCUSDT":
        rule = rule_for(source, symbol)
        moment = datetime.fromtimestamp(stamp / 1000, UTC)
        if effective_rule_status(rule, as_of=moment) not in ("verified", "review_due"):
            return _unknown(rule["version"])
        return {"market_session": "scheduled_open", "session_reason": None, "calendar_verified": True,
                "calendar_version": rule["version"]}
    return _unknown()


def _profile_closure_status(source: str, symbol: str, stamp: int, metadata: dict, base: dict):
    """Overlay explicit source-backed closures without certifying open time.

    A profile with ``source_session`` is handled by the identity-bound live
    session path above. Closure-only profiles can still prove a closed minute;
    outside those closures an unknown base remains unknown.
    """
    profile = metadata.get("calendar_profile")
    if not isinstance(profile, dict) or profile.get("source_session") is not None:
        return base
    if metadata.get("calendar_verified") is False:
        return base
    if not profile.get("closures"):
        return base
    try:
        from .calendar_profile import closures_from

        moment = datetime.fromtimestamp(stamp / 1000, UTC)
        for closure in closures_from(profile):
            if closure.start <= moment < closure.end:
                return {"market_session": "closed", "session_reason": closure.reason,
                        "calendar_verified": True,
                        "calendar_version": profile.get("revision") or base.get("calendar_version")}
    except (TypeError, ValueError, KeyError, OverflowError):
        return _unknown(profile.get("revision"))
    return base


def session_status(source: str, symbol: str, stamp: int, *, metadata: dict | None = None):
    """Return one of closed/scheduled_open/unknown with a reason and version."""
    metadata = metadata or {}
    source = str(source or "").strip().lower()
    metadata = {"symbol": symbol, **metadata}
    symbol = canonical_symbol(source, symbol)
    identity = observation_identity(source, metadata["symbol"], metadata)
    if identity.get("source") != source or canonical_symbol(source, identity.get("provider_symbol")) != symbol:
        return _unknown(metadata.get("calendar_version"))
    reviewed = _reviewed_profile_status(source, symbol, stamp, metadata)
    if reviewed is not None:
        return reviewed
    base = _builtin_status(source, symbol, stamp)
    if base.get("calendar_verified"):
        expected = observation_identity(source, metadata["symbol"])
        if any(identity.get(key) != expected.get(key) for key in ("channel", "environment", "account_scope")):
            return _unknown(base["calendar_version"])
    if base.get("calendar_version") is None and metadata.get("calendar_version"):
        base = {**base, "calendar_version": metadata["calendar_version"]}
    return _profile_closure_status(source, symbol, stamp, metadata, base)


def calendar_rows(*, source: str | None = None, query: str = "", as_of: datetime | None = None, db=None):
    term = query.strip().casefold()
    rows = []
    rules = list(CALENDAR_RULES) if db is None else _runtime_rules(db, as_of or datetime.now(UTC))
    for rule in rules:
        if source and source != rule["source"]:
            continue
        mappings = list(rule["mappings"])
        compact = term.replace("/", "").replace("_", "")
        if term and term not in rule["source"].casefold() and term not in rule["scope"].casefold() and not any(compact in value.casefold().replace("/", "").replace("_", "") for value in mappings):
            continue
        row = {key: list(value) if isinstance(value, tuple) else value for key, value in rule.items()}
        row["status"] = rule.get("runtime_status") or effective_rule_status(rule, as_of=as_of)
        rows.append(row)
    return rows


def _runtime_rules(db, moment):
    """Read configured identities and profiles without refreshing catalogs or providers."""
    import json

    from sqlalchemy import or_, select

    from .calendar_profile import closures_from
    from .config import settings
    from .live_session import effective_profile
    from .storage import Audit, Instrument, MarketCatalog, MarketDataset, ProviderDataset

    enabled = {"dukascopy": True, "binance": True, "yahoo": settings.yahoo_enabled, "akshare": settings.akshare_enabled,
               "oanda": bool(settings.oanda_account_id and settings.oanda_token)}
    stamp = int(moment.timestamp() * 1000)
    rules = []
    for rule in CALENDAR_RULES:
        mappings = rule["mappings"] if rule["status"] == "verified" else (None,)
        for symbol in mappings:
            row = {**rule, "enabled": enabled[rule["source"]], "exceptions_reviewed": False,
                   "coverage_note": "常规计划已记录；未登记的节假日和临时调整仍待核实。"}
            if symbol:
                row.update(mappings=(symbol,), row_id=rule["version"] + ":" + symbol,
                           **session_status(rule["source"], symbol, stamp))
                if symbol == "EUR/USD":
                    row["regular_hours"] = "周日 17:00 至周五 17:00（纽约时间）；无已登记每日暂停"
            rules.append(row)
    instruments = []
    def price_scope(source, meta):
        explicit = meta.get("source_identity") or meta.get("native_identity") or meta.get("native_period_identity") or {}
        basis = explicit.get("basis") or explicit.get("quote_basis") or meta.get("basis")
        parameters = explicit.get("parameters") or meta.get("native_parameters") or {}
        if source == "oanda" and not parameters:
            from .native_series import DEFAULTS

            parameters = {**DEFAULTS, "price": {"ask": "A", "mid": "M"}.get(basis, "B")}
        # Periods share a calendar scope; price and alignment choices do not.
        parameters = {key: value for key, value in parameters.items() if key != "granularity"}
        return basis or {"dukascopy": "bid", "oanda": "bid"}.get(source, "last"), parameters

    def scope_key(source, symbol, meta):
        identity = observation_identity(source, symbol, meta)
        basis, parameters = price_scope(source, meta)
        explicit = meta.get("source_identity") or meta.get("native_identity") or meta.get("native_period_identity") or {}
        return (source, canonical_symbol(source, symbol), identity.get("channel"),
                identity.get("environment"), identity.get("account_scope"),
                basis, json.dumps(parameters, sort_keys=True),
                meta.get("calendar_version") or explicit.get("calendar_version"),
                json.dumps(effective_profile(identity, meta.get("calendar_profile")), sort_keys=True))

    seen_scopes = set()
    # Explicit historical datasets are intentionally disabled for live polling;
    # their immutable calendar identities still belong in this registry.
    for inst in db.scalars(select(Instrument).where(or_(Instrument.enabled.is_(True),
            select(MarketDataset.id).where(MarketDataset.instrument_id == Instrument.id).exists()))):
        dataset = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == inst.id))
        instruments.append((inst.source, inst.symbol, inst.id, {"symbol": inst.symbol, "basis": inst.basis,
            "calendar_profile": inst.calendar_profile, "calendar_verified": bool(inst.calendar_profile),
            "source_identity": dataset.identity if dataset else None}))
        seen_scopes.add(scope_key(inst.source, inst.symbol, instruments[-1][3]))
    for entry in db.scalars(select(MarketCatalog).where(MarketCatalog.available.is_(True))):
        meta = {"symbol": entry.symbol}
        if entry.source == "oanda" and (entry.metadata_json or {}).get("history_account_scope"):
            meta["source_identity"] = {"source": "oanda", "channel": "v20", "environment": "practice",
                "provider_symbol": entry.symbol, "account_scope": entry.metadata_json["history_account_scope"]}
        key = scope_key(entry.source, entry.symbol, meta)
        if key not in seen_scopes:
            instruments.append((entry.source, entry.symbol, "catalog:" + entry.id, meta))
            seen_scopes.add(key)
    cached_scopes = set()
    for cached in db.scalars(select(ProviderDataset)):
        meta = cached.metadata_json
        if not isinstance(meta, dict):
            continue
        key = scope_key(cached.source, cached.symbol, meta)
        if key in cached_scopes or key in seen_scopes:
            continue
        cached_scopes.add(key)
        instruments.append((cached.source, cached.symbol, "provider:" + cached.id, {**meta, "symbol": cached.symbol}))
    for symbol in set(settings.oanda_resident_symbols.split(",")) | set(settings.oanda_live_session_profiles) | set(settings.oanda_calendar_profiles):
        meta = {"symbol": symbol, "calendar_profile": settings.oanda_calendar_profiles.get(symbol),
                "calendar_verified": settings.oanda_calendar_verified}
        if symbol and scope_key("oanda", symbol, meta) not in seen_scopes:
            instruments.append(("oanda", symbol, "configured:" + symbol, meta))
    audits = {}
    candidate_ids = [scope_id for _, _, scope_id, _ in instruments]
    if candidate_ids:
        for audit in db.scalars(select(Audit).where(Audit.kind == "calendar_review",
                Audit.details["instrument"].as_string().in_(candidate_ids))
                .order_by(Audit.at.desc(), Audit.id.desc())):
            details = audit.details
            audits.setdefault((details.get("instrument"), details.get("revision")), audit)
    # Catalog and instrument IDs can coincide while describing distinct price scopes.
    for source, symbol, scope_id, meta in sorted(instruments, key=lambda item: item[:3]):
        base = _RULE_BY_SOURCE.get(source)
        if base is None:
            continue
        identity = observation_identity(source, symbol, meta)
        profile = effective_profile(identity, meta.get("calendar_profile"))
        version = profile.get("revision") if isinstance(profile, dict) else None
        if not isinstance(version, str) or not 0 < len(version) <= 100:
            version = None
        invalid_profile = False
        try:
            if profile is not None and not isinstance(profile, dict):
                raise ValueError("Calendar profile must be an object")
            closures = closures_from(profile)
        except (TypeError, ValueError, KeyError):
            closures = ()
            invalid_profile = True
        session = _unknown(version) if invalid_profile else session_status(source, symbol, stamp, metadata=meta)
        normalized = canonical_symbol(source, symbol)
        basis, parameters = price_scope(source, meta)
        # The configured profile owns the review identity; session evidence may
        # still use a built-in rule outside the profile's explicit closures.
        row = {**base, "version": version or session.get("calendar_version") or base["version"],
               "mappings": (symbol,), "enabled": enabled[source], **session,
               "runtime_status": "verified" if session.get("calendar_verified") else "unverified",
               "checked_at": None, "review_due_at": None, "valid_from": None, "valid_until": None,
               "scope": "当前来源品种 " + symbol + " · " + str(identity.get("channel") or "通道未确认")
                        + " / " + str(identity.get("environment") or "环境未确认") + " · " + basis,
               "price_basis": basis, "native_parameters": parameters,
               "exceptions": (), "exceptions_reviewed": False,
               "coverage_note": "按实际来源身份匹配；无适用证据的部分保持未核实。"}
        scope = identity.get("account_scope")
        row["identity"] = {"channel": identity.get("channel"), "environment": identity.get("environment"),
            "account_scope": "public" if scope == "public" else
                "sha256:" + scope.split(":", 1)[1][:12] if isinstance(scope, str) and scope.startswith("sha256:") else "未记录",
            "provider_symbol": symbol, "price_basis": basis, "calendar_version": row["version"]}
        if not profile and session.get("calendar_version") == base["version"] and session.get("calendar_verified"):
            row.update(runtime_status=effective_rule_status(base, as_of=moment),
                       **{key: base[key] for key in ("checked_at", "review_due_at", "valid_from", "valid_until")})
            if source == "dukascopy" and normalized == "EUR/USD":
                row["regular_hours"] = "周日 17:00 至周五 17:00（纽约时间）；无已登记每日暂停"
        source_session = profile.get("source_session") if isinstance(profile, dict) and not invalid_profile else None
        if isinstance(source_session, dict):
            row.update(timezone=source_session.get("timezone", base["timezone"]),
                       scope=source_session.get("applicability", row["scope"]),
                       valid_from=source_session.get("reviewed_start"), valid_until=source_session.get("reviewed_end"),
                       evidence=[source_session["evidence_url"]] if source_session.get("evidence_url") else [],
                       regular_hours="有限审核范围内的来源会话；开闭边界分钟保留未核实。")
        if isinstance(profile, dict) and profile.get("trading_date"):
            row.update(timezone=profile["trading_date"]["timezone"],
                       regular_hours="按来源交易日标注；市场开闭时段未核实。",
                       coverage_note="已保存来源日期规则；不据此认证节假日、停牌或期货夜盘会话。")
        row["exceptions"] = tuple({"start": c.start.isoformat(), "end": c.end.isoformat(),
            "reason": c.reason, "source": c.source} for c in closures)
        if invalid_profile:
            row["coverage_note"] = "规则格式无效；保留未核实，需重新维护。"
        # Separate rows preserve immutable dataset scopes; different instances
        # may have the same symbol with different rules. No account ID is exposed.
        row["row_id"] = source + ":" + scope_id + ":" + row["version"]
        row["target_id"] = scope_id
        row["target_kind"] = ("catalog" if scope_id.startswith("catalog:") else
            "provider" if scope_id.startswith("provider:") else
            "configured" if scope_id.startswith("configured:") else "registered")
        # Reviews are scoped to this immutable target and revision. A matching
        # display rule never transfers an audit to a different binding.
        row["review_target"] = row["row_id"]
        audit = audits.get((scope_id, version)) if version and not invalid_profile else None
        row["audit"] = ({"reviewed_at": datetime.fromtimestamp(audit.at / 1000, UTC).isoformat(),
            "reviewer": audit.details.get("reviewer"), "method": audit.details.get("method"),
            "evidence_version": audit.details.get("evidence_version"),
            "review_due_at": audit.details.get("review_due_at")} if audit else None)
        if audit:
            row["checked_at"] = row["audit"]["reviewed_at"]
            row["review_due_at"] = row["audit"]["review_due_at"]
            # Applicability was checked by session_status; review deadlines
            # only affect maintenance state and cannot certify unknown minutes.
            if row["runtime_status"] == "verified":
                row["runtime_status"] = effective_rule_status({
                    "status": "verified", "review_due_at": row["review_due_at"]}, as_of=moment)
        rules.append(row)
        for generic in rules[:-1]:
            if generic["source"] == source and not generic.get("row_id"):
                generic["mappings"] = tuple(item for item in generic["mappings"] if canonical_symbol(source, item) != normalized)
    rules = [row for row in rules if row.get("row_id") or row["mappings"] or row["source"] in ("yahoo", "akshare")]
    return rules
