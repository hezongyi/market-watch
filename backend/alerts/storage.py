import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    ForeignKey,
    Index,
    LargeBinary,
    Numeric,
    String,
    UniqueConstraint,
    create_engine,
    event,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.orm import Session as ORMSession

from .config import settings
from .domain import Candle, Rule, State


def now_ms():
    return int(datetime.now(UTC).timestamp() * 1000)


def ms(value: datetime):
    return int(value.timestamp() * 1000)


def instant(value: int):
    return datetime.fromtimestamp(value / 1000, UTC)


def uid():
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class Instrument(Base):
    __tablename__ = "instruments"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    label: Mapped[str]
    source: Mapped[str] = mapped_column(default="dukascopy")
    symbol: Mapped[str]
    basis: Mapped[str] = mapped_column(default="bid")
    calendar: Mapped[str]
    calendar_profile: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    precision: Mapped[int]
    quality: Mapped[str] = mapped_column(default="waiting")
    last_received: Mapped[int | None] = mapped_column(BigInteger)
    error: Mapped[str | None]
    enabled: Mapped[bool] = mapped_column(default=True, server_default="true")


class MarketDataset(Base):
    __tablename__ = "market_datasets"
    asset_class: Mapped[str] = mapped_column(String(16), default="unspecified", server_default="unspecified")
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), unique=True)
    logical_symbol: Mapped[str] = mapped_column(String(10))
    identity: Mapped[dict] = mapped_column(JSON)
    volume_kind: Mapped[str] = mapped_column(String(20))
    volume_unit: Mapped[str | None] = mapped_column(String(40))


class HistoryVersion(Base):
    __tablename__ = "market_history_versions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("market_datasets.id"), index=True)
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    cursor: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    published_at: Mapped[int | None] = mapped_column(BigInteger)
    manifest: Mapped[dict] = mapped_column(JSON, default=dict)
    lease_token: Mapped[str | None] = mapped_column(String(36))
    lease_until: Mapped[int] = mapped_column(BigInteger, default=0)
    attempts: Mapped[int] = mapped_column(default=0)
    next_at: Mapped[int] = mapped_column(BigInteger, default=0)
    error: Mapped[str | None] = mapped_column(String(40))


class HistoryChunk(Base):
    __tablename__ = "market_history_chunks"
    __table_args__ = (UniqueConstraint("version_id", "start"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    version_id: Mapped[str] = mapped_column(ForeignKey("market_history_versions.id"), index=True)
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    observed_at: Mapped[int] = mapped_column(BigInteger)
    count: Mapped[int]
    checksum: Mapped[str] = mapped_column(String(64))
    content: Mapped[bytes] = mapped_column(LargeBinary)
    result: Mapped[str] = mapped_column(String(20))
    unknown: Mapped[list] = mapped_column(JSON, default=list)


class PricingOwner(Base):
    __tablename__ = "market_pricing_owners"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    token: Mapped[str | None] = mapped_column(String(36))
    expires: Mapped[int] = mapped_column(BigInteger, default=0)
    epoch: Mapped[int] = mapped_column(default=0)
    connected_at: Mapped[int] = mapped_column(BigInteger, default=0)
    next_at: Mapped[int] = mapped_column(BigInteger, default=0)
    failures: Mapped[int] = mapped_column(default=0)
    error: Mapped[str | None] = mapped_column(String(32))


class LiveState(Base):
    __tablename__ = "market_live_states"
    dataset_id: Mapped[str] = mapped_column(ForeignKey("market_datasets.id"), primary_key=True)
    epoch: Mapped[int] = mapped_column(default=0)
    revision: Mapped[int] = mapped_column(BigInteger, default=0)
    connection: Mapped[str] = mapped_column(String(20), default="disconnected")
    heartbeat_at: Mapped[int] = mapped_column(BigInteger, default=0)
    quote: Mapped[dict] = mapped_column(JSON, default=dict)
    forming: Mapped[dict] = mapped_column(JSON, default=dict)
    confirmed_end: Mapped[int] = mapped_column(BigInteger, default=0)
    recovery_cursor: Mapped[int] = mapped_column(BigInteger, default=0)
    recovery_started: Mapped[int] = mapped_column(BigInteger, default=0)
    ready: Mapped[bool] = mapped_column(default=False)
    next_confirm_at: Mapped[int] = mapped_column(BigInteger, default=0)
    attempts: Mapped[int] = mapped_column(default=0)
    error: Mapped[str | None] = mapped_column(String(32))
    received_at: Mapped[int] = mapped_column(BigInteger, default=0)


class LiveMinute(Base):
    __tablename__ = "market_live_minutes"
    __table_args__ = (UniqueConstraint("dataset_id", "start"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("market_datasets.id"), index=True)
    start: Mapped[int] = mapped_column(BigInteger, index=True)
    expected: Mapped[bool | None]
    expectation: Mapped[str] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(default=0)
    failures: Mapped[int] = mapped_column(default=0)
    last_result: Mapped[str] = mapped_column(String(32), default="pending")
    confirmed_at: Mapped[int | None] = mapped_column(BigInteger)
    first_attempt: Mapped[int] = mapped_column(BigInteger)
    last_attempt: Mapped[int] = mapped_column(BigInteger)
    quote_count: Mapped[int] = mapped_column(default=0)
    age_histogram: Mapped[dict] = mapped_column(JSON, default=dict)
    max_interarrival: Mapped[int] = mapped_column(BigInteger, default=0)


@event.listens_for(ORMSession, "before_flush")
def immutable_dataset_identity(db, flush_context, instances):
    from sqlalchemy import inspect, select

    for row in db.deleted:
        if isinstance(row, (HistoryChunk, HistoryVersion)):
            raise ValueError("Historical snapshots cannot be deleted by runtime writers")
        if isinstance(row, MarketDataset):
            raise ValueError("Explicit dataset bindings cannot be removed by runtime writers")
        if isinstance(row, Instrument) and db.scalar(
                select(MarketDataset.id).where(MarketDataset.instrument_id == row.id)):
            raise ValueError("Bound dataset instruments cannot be removed by runtime writers")
    for row in db.dirty:
        state = inspect(row)
        if isinstance(row, HistoryChunk) and any(attr.history.has_changes() for attr in state.attrs):
            raise ValueError("Historical snapshot chunks are immutable")
        if isinstance(row, HistoryVersion):
            old = state.attrs.status.history.deleted
            if (row.status == "published" and not state.attrs.status.history.has_changes()
                    or "published" in old):
                if any(attr.history.has_changes() for attr in state.attrs):
                    raise ValueError("Published historical versions are immutable")
        if isinstance(row, MarketDataset) and any(
            attr.history.has_changes() for attr in state.attrs
        ):
            raise ValueError("Dataset identity is immutable")
        if isinstance(row, Instrument) and any(state.attrs[key].history.has_changes()
                for key in ("id", "source", "symbol", "basis", "calendar", "precision", "calendar_profile")):
            previous_ids = state.attrs.id.history.deleted or [row.id]
            if db.scalar(select(MarketDataset.id).where(
                    MarketDataset.instrument_id.in_(previous_ids))):
                raise ValueError("Bound dataset metadata is immutable; register a new version")


class Bar(Base):
    __tablename__ = "candles"
    __table_args__ = (
        UniqueConstraint("instrument_id", "timeframe", "start"),
        Index("ix_candles_revision_lookup", "instrument_id", "timeframe", "received_at"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    timeframe: Mapped[str] = mapped_column(String(8))
    start: Mapped[int] = mapped_column(BigInteger, index=True)
    end: Mapped[int] = mapped_column(BigInteger, index=True)
    open: Mapped[Decimal] = mapped_column(Numeric(24, 10))
    high: Mapped[Decimal] = mapped_column(Numeric(24, 10))
    low: Mapped[Decimal] = mapped_column(Numeric(24, 10))
    close: Mapped[Decimal] = mapped_column(Numeric(24, 10))
    complete: Mapped[bool] = mapped_column(Boolean, default=False)
    revision: Mapped[int] = mapped_column(default=1)
    received_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    observed_at: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    volume: Mapped[Decimal | None] = mapped_column(Numeric(38, 18))
    volume_complete: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    volume_received_at: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    volume_revision: Mapped[int] = mapped_column(default=0, server_default="0")

    def candle(self):
        return Candle(
            instant(self.start),
            instant(self.end),
            self.open,
            self.high,
            self.low,
            self.close,
            self.complete,
            self.revision,
            self.volume,
            self.volume_complete,
            True,
        )


class Quote(Base):
    __tablename__ = "quotes"
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    at: Mapped[int] = mapped_column(BigInteger)
    bid: Mapped[Decimal] = mapped_column(Numeric(24, 10))
    ask: Mapped[Decimal] = mapped_column(Numeric(24, 10))
    received_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class Watch(Base):
    __tablename__ = "watches"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"))
    name: Mapped[str]
    rule: Mapped[dict] = mapped_column(JSON)
    state: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(default="active", index=True)
    armed_at: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    paused_reason: Mapped[str | None]
    warmup_start: Mapped[int | None] = mapped_column(BigInteger)


class ChartAlert(Base):
    """Durable alert owner; browser interests never own this lifecycle."""
    __tablename__ = "chart_alerts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    request_id: Mapped[str] = mapped_column(String(100), unique=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    health: Mapped[str] = mapped_column(String(16), default="warming")
    health_reason: Mapped[str | None] = mapped_column(String(250))
    version: Mapped[int] = mapped_column(default=1)
    control_revision: Mapped[int] = mapped_column(default=1, server_default="1")
    run: Mapped[int] = mapped_column(default=1)
    count: Mapped[int] = mapped_column(default=0)
    max_triggers: Mapped[int] = mapped_column(default=1)
    effective_at: Mapped[int] = mapped_column(BigInteger)
    expires_at: Mapped[int | None] = mapped_column(BigInteger)
    state: Mapped[dict] = mapped_column(JSON, default=dict)
    runtime: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class ChartAlertAction(Base):
    """Committed lifecycle request identities; retries never repeat transitions."""
    __tablename__ = "chart_alert_actions"
    alert_id: Mapped[str] = mapped_column(ForeignKey("chart_alerts.id"), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class ChartAlertVersion(Base):
    """Immutable configuration and normalized source identity for each revision."""
    __tablename__ = "chart_alert_versions"
    __table_args__ = (UniqueConstraint("alert_id", "version"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    alert_id: Mapped[str] = mapped_column(ForeignKey("chart_alerts.id"), index=True)
    version: Mapped[int]
    config: Mapped[dict] = mapped_column(JSON)
    market_identity: Mapped[dict] = mapped_column(JSON)
    dataset_id: Mapped[str | None] = mapped_column(String(64), index=True)
    effective_at: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


@event.listens_for(ChartAlertVersion, "before_update")
@event.listens_for(ChartAlertVersion, "before_delete")
def immutable_chart_alert_version(mapper, connection, target):
    raise ValueError("告警规则版本不可变；请生成新版本并保留历史证据")


class SignalRow(Base):
    __tablename__ = "signals"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    watch_id: Mapped[str | None] = mapped_column(ForeignKey("watches.id"), index=True)
    chart_alert_id: Mapped[str | None] = mapped_column(ForeignKey("chart_alerts.id"), index=True)
    event_key: Mapped[str] = mapped_column(String(100), unique=True, default=uid)
    instrument_id: Mapped[str]
    occurred_at: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    direction: Mapped[str]
    price: Mapped[Decimal] = mapped_column(Numeric(24, 10))
    threshold: Mapped[Decimal] = mapped_column(Numeric(24, 10))
    reason: Mapped[str]
    evidence: Mapped[dict] = mapped_column(JSON)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    signal_id: Mapped[str] = mapped_column(ForeignKey("signals.id"), unique=True)
    status: Mapped[str] = mapped_column(default="pending")
    ack_at: Mapped[int | None] = mapped_column(BigInteger)
    ack_hash: Mapped[str | None]
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class Outbox(Base):
    __tablename__ = "outbox"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    notification_id: Mapped[str] = mapped_column(ForeignKey("notifications.id"), unique=True)
    status: Mapped[str] = mapped_column(default="pending", index=True)
    attempts: Mapped[int] = mapped_column(default=0)
    next_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    lease_until: Mapped[int | None] = mapped_column(BigInteger)
    error: Mapped[str | None]
    provider_id: Mapped[str | None]


class Audit(Base):
    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_events_kind_at", "kind", "at"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str]
    at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    details: Mapped[dict] = mapped_column(JSON)


class Preference(Base):
    __tablename__ = "preferences"
    key: Mapped[str] = mapped_column(primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)


class DeliveryAttempt(Base):
    __tablename__ = "delivery_attempts"
    id: Mapped[int] = mapped_column(primary_key=True)
    notification_id: Mapped[str] = mapped_column(ForeignKey("notifications.id"))
    at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    status: Mapped[str]
    details: Mapped[dict] = mapped_column(JSON)


class AckGrant(Base):
    __tablename__ = "ack_grants"
    token_hash: Mapped[str] = mapped_column(primary_key=True)
    notification_id: Mapped[str] = mapped_column(ForeignKey("notifications.id"), index=True)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str]
    token_hash: Mapped[str] = mapped_column(unique=True)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    last_seen: Mapped[int | None] = mapped_column(BigInteger)
    revoked: Mapped[bool] = mapped_column(default=False)


class DeviceReceipt(Base):
    __tablename__ = "device_receipts"
    __table_args__ = (UniqueConstraint("device_id", "notification_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    notification_id: Mapped[str] = mapped_column(ForeignKey("notifications.id"))
    received_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class ImportJob(Base):
    __tablename__ = "import_jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"))
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    cursor: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(default="pending")
    error: Mapped[str | None]
    next_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    attempts: Mapped[int] = mapped_column(default=0)
    lease_until: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    # Lower values run first: recovery=0, manual=10, initial history=50.
    priority: Mapped[int] = mapped_column(default=10, server_default="10")
    chart_plan: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")


class LoginSession(Base):
    __tablename__ = "sessions"
    token_hash: Mapped[str] = mapped_column(primary_key=True)
    csrf: Mapped[str]
    expires: Mapped[int] = mapped_column(BigInteger)


class Replay(Base):
    __tablename__ = "replays"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    instrument_id: Mapped[str]
    dataset_version: Mapped[str | None] = mapped_column(String(36))
    input_manifest: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    calendar_profile: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    timeframe: Mapped[str]
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    cursor: Mapped[int] = mapped_column(BigInteger)
    # Warmup is compressed and deferred: stepping does not repeatedly load historical context.
    warmup_snapshot: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)
    warmup_count: Mapped[int] = mapped_column(default=0, server_default="0")
    bars: Mapped[list] = mapped_column(JSON)
    days: Mapped[list] = mapped_column(JSON)
    watches: Mapped[list] = mapped_column(JSON, default=list)
    signals: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


def make_engine(url):
    if url.startswith("sqlite"):
        engine = create_engine(url, connect_args={"check_same_thread": False})
    else:
        engine = create_engine(
            url,
            pool_size=settings.database_pool_size,
            max_overflow=settings.database_max_overflow,
            pool_timeout=settings.database_pool_timeout,
            pool_pre_ping=True,
            connect_args={"application_name": settings.database_application_name},
        )
    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def setup(dbapi, _):
            dbapi.execute("PRAGMA foreign_keys=ON")
            dbapi.execute("PRAGMA busy_timeout=5000")

    return engine


engine = make_engine(settings.database_url)
Session = sessionmaker(engine, expire_on_commit=False)


@contextmanager
def transaction():
    with Session.begin() as session:
        yield session


def bootstrap(db_engine=engine):
    # Serialize first start across the API and both workers on PostgreSQL.
    with db_engine.begin() as connection:
        if db_engine.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(8675309)"))
        Base.metadata.create_all(connection)
        with sessionmaker(bind=connection).begin() as db:
            if not db.get(Preference, "auth.admin"):
                db.add(Preference(key="auth.admin", value={}))
            for name, label, calendar, precision in [
                ("EURUSD", "欧元 / 美元", "ny17", 5),
                ("XAUUSD", "黄金 / 美元", "ny17", 2),
                ("BTCUSD", "比特币 / 美元", "utc0", 2),
                ("BTCUSDT", "比特币 / USDT", "utc0", 2),
            ]:
                if not db.get(Instrument, name):
                    oanda = name in {"EURUSD", "XAUUSD"} and settings.fx_source == "oanda"
                    db.add(
                        Instrument(
                            id=name,
                            label=label,
                            symbol={"EURUSD": "EUR_USD", "XAUUSD": "XAU_USD"}[name]
                            if oanda
                            else name
                            if name == "BTCUSDT"
                            else name.lower(),
                            source="oanda"
                            if oanda
                            else "binance"
                            if name == "BTCUSDT"
                            else "dukascopy",
                            basis="last" if name == "BTCUSDT" else "bid",
                            enabled=name != "BTCUSD",
                            calendar=calendar,
                            precision=precision,
                        )
                    )


def candle_dict(c):
    return {
        "start": ms(c.start),
        "end": ms(c.end),
        "open": str(c.open),
        "high": str(c.high),
        "low": str(c.low),
        "close": str(c.close),
        "complete": c.complete,
        "revision": c.revision,
        "volume": format(c.volume, "f") if c.volume is not None else None,
        "volume_complete": bool(c.volume_complete),
    }


def candle_from(d):
    return Candle(
        instant(d["start"]),
        instant(d["end"]),
        *(Decimal(d[k]) for k in ["open", "high", "low", "close"]),
        d.get("complete", True),
        d.get("revision", 1),
        Decimal(d["volume"]) if d.get("volume") is not None else None,
        d.get("volume_complete", False),
        "volume" in d,
    )


def state_dict(state):
    return {
        "previous": candle_dict(state.previous) if state.previous else None,
        "last_event": ms(state.last_event) if state.last_event else None,
        "indicator_closes": list(state.indicator_closes),
        "indicator_reading": state.indicator_reading,
        **{
            key: getattr(state, key)
            for key in ["down_count", "up_count", "buy_ready", "sell_ready"]
        },
    }


def state_from(d):
    values = dict(d)
    values["previous"] = candle_from(d["previous"]) if d.get("previous") else None
    values["last_event"] = instant(d["last_event"]) if d.get("last_event") else None
    return State(**values)


def rule_from(d):
    try:
        return Rule(**{**d, "level": Decimal(d["level"]) if d.get("level") is not None else None})
    except InvalidOperation:
        raise ValueError("价格格式不正确")


class ChartWorkspace(Base):
    __tablename__ = "chart_workspaces"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(100))
    document: Mapped[dict] = mapped_column(JSON, default=dict)
    revision: Mapped[int] = mapped_column(default=1)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class ChartTemplate(Base):
    __tablename__ = "chart_indicator_templates"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(100))
    indicators: Mapped[list] = mapped_column(JSON, default=list)


class AdvancedWorkspace(Base):
    __tablename__ = "advanced_chart_workspaces"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(100))
    document: Mapped[dict] = mapped_column(JSON, default=dict)
    revision: Mapped[int] = mapped_column(default=1)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class MarketCoverage(Base):
    __tablename__ = "market_data_coverage"
    __table_args__ = (
        UniqueConstraint("instrument_id", "source", "basis", "start", "end"),
        Index("ix_market_coverage_interval", "instrument_id", "start", "end"),
    )
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=uid)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"))
    source: Mapped[str] = mapped_column(String(32))
    basis: Mapped[str] = mapped_column(String(16))
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    observed: Mapped[int] = mapped_column(default=0)
    queried_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class MarketCatalog(Base):
    __tablename__ = "market_instrument_catalog"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    source: Mapped[str] = mapped_column(String(32))
    symbol: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(200))
    asset_type: Mapped[str] = mapped_column(String(32))
    precision: Mapped[int]
    calendar: Mapped[str | None] = mapped_column(String(32))
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    available: Mapped[bool] = mapped_column(default=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")


class MarketDemand(Base):
    __tablename__ = "market_data_demand"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    expires: Mapped[int] = mapped_column(BigInteger, index=True)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class WeeklyHistoryRequest(Base):
    __tablename__ = "weekly_history_requests"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    before: Mapped[int] = mapped_column(BigInteger)
    cursor: Mapped[int] = mapped_column(BigInteger)
    remaining: Mapped[int]
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    next_at: Mapped[int] = mapped_column(BigInteger, index=True)


class AdvancedPreference(Base):
    __tablename__ = "advanced_chart_preferences"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), index=True)
    name: Mapped[str] = mapped_column(String(250))
    tool: Mapped[str] = mapped_column(String(100), default="")
    content: Mapped[dict] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(default=1)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class ChartHistoryPlan(Base):
    """User-approved history start; target_end is a fixed initialization watermark."""
    __tablename__ = "chart_history_plans"
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    target_start: Mapped[int] = mapped_column(BigInteger)
    target_end: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    cursor: Mapped[int | None] = mapped_column(BigInteger)
    realtime_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    realtime_end: Mapped[int] = mapped_column(BigInteger, default=0)


class ChartPublication(Base):
    """Atomically published continuous coverage, independently for each period."""
    __tablename__ = "chart_publications"
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    timeframe: Mapped[str] = mapped_column(String(8), primary_key=True)
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    complete_count: Mapped[int] = mapped_column(default=0)
    revision: Mapped[int] = mapped_column(default=1)
    initialized: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class ChartPublishedBar(Base):
    """Visible candle snapshot, separate from acquisition/aggregation staging."""
    __tablename__ = "chart_published_bars"
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    timeframe: Mapped[str] = mapped_column(String(8), primary_key=True)
    start: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    end: Mapped[int] = mapped_column(BigInteger)
    complete: Mapped[bool] = mapped_column(Boolean)
    payload: Mapped[dict] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(default=1, server_default="1")


class ChartPublicationJob(Base):
    """Durable dirty buckets, committed with staging changes and cleared on publication."""
    __tablename__ = "chart_publication_jobs"
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    timeframe: Mapped[str] = mapped_column(String(8), primary_key=True)
    start: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    end: Mapped[int] = mapped_column(BigInteger)


class ProviderDataset(Base):
    """Native provider cache identity and proven ranges, never managed coverage."""
    __tablename__ = "provider_datasets"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source: Mapped[str] = mapped_column(String(32))
    symbol: Mapped[str] = mapped_column(String(64))
    timeframe: Mapped[str] = mapped_column(String(8))
    metadata_json: Mapped[dict] = mapped_column(JSON)
    coverage: Mapped[list] = mapped_column(JSON, default=list)
    earliest: Mapped[bool] = mapped_column(Boolean, default=False)
    revision: Mapped[int] = mapped_column(default=0)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=0)
    latest_at: Mapped[int] = mapped_column(BigInteger, default=0)
    accessed_at: Mapped[int] = mapped_column(BigInteger, default=now_ms, index=True)
    lease_token: Mapped[str | None] = mapped_column(String(36))
    lease_until: Mapped[int] = mapped_column(BigInteger, default=0)
    generation: Mapped[int] = mapped_column(default=0)


class ProviderBar(Base):
    __tablename__ = "provider_bars"
    __table_args__ = (Index("ix_provider_bars_range", "dataset_id", "chart_time"),)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("provider_datasets.id"), primary_key=True)
    start: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    chart_time: Mapped[int] = mapped_column(BigInteger)
    complete: Mapped[bool] = mapped_column(Boolean)
    payload: Mapped[dict] = mapped_column(JSON)
    observed_at: Mapped[int] = mapped_column(BigInteger)
    changed_at: Mapped[int] = mapped_column(BigInteger, default=0)
    revision: Mapped[int] = mapped_column(default=1)


class NativeHistoryLoad(Base):
    """One owner's cancellable historical demand; pages remain dataset-shared."""
    __tablename__ = "native_history_loads"
    __table_args__ = (UniqueConstraint("owner", "request_id"),
                      Index("ix_native_history_loads_work", "state", "lease_until", "created_at"))
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(String(64), index=True)
    request_id: Mapped[str] = mapped_column(String(100))
    query_json: Mapped[dict] = mapped_column(JSON)
    state: Mapped[str] = mapped_column(String(16), default="waiting")
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    deadline: Mapped[int] = mapped_column(BigInteger)
    consumer_until: Mapped[int] = mapped_column(BigInteger)
    lease_until: Mapped[int] = mapped_column(BigInteger, default=0)
    generation: Mapped[int] = mapped_column(default=0)
    pages: Mapped[int] = mapped_column(default=0)
    stalls: Mapped[int] = mapped_column(default=0)
    error_json: Mapped[dict | None] = mapped_column(JSON)


class ProviderInterest(Base):
    """Session-owned finite targets; dataset data/leases are shared globally."""
    __tablename__ = "provider_interests"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    client: Mapped[str] = mapped_column(String(64), index=True)
    listener: Mapped[str] = mapped_column(String(100))
    dataset_id: Mapped[str] = mapped_column(ForeignKey("provider_datasets.id"), index=True)
    subscribed: Mapped[bool] = mapped_column(Boolean, default=False)
    expires: Mapped[int] = mapped_column(BigInteger, index=True)
    accessed_at: Mapped[int] = mapped_column(BigInteger)
    targets: Mapped[list] = mapped_column(JSON, default=list)
    indicators: Mapped[list] = mapped_column(JSON, default=list)
    cursor: Mapped[int] = mapped_column(BigInteger, default=0)
    revision: Mapped[int] = mapped_column(default=0)
    next_poll: Mapped[int] = mapped_column(BigInteger, default=0)
    error: Mapped[str | None] = mapped_column(String(200))


class ChartViewportDemand(Base):
    """Expiring interaction priority; expiry never deletes the durable plan."""
    __tablename__ = "chart_viewport_demands"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    timeframe: Mapped[str] = mapped_column(String(8))
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    warm_start: Mapped[int] = mapped_column(BigInteger)
    focused: Mapped[bool] = mapped_column(Boolean)
    expires: Mapped[int] = mapped_column(BigInteger, index=True)


class ChartAggregationJob(Base):
    __tablename__ = 'chart_aggregation_jobs'
    kind: Mapped[str] = mapped_column(String(8), default='price', server_default='price')
    __table_args__ = (UniqueConstraint('instrument_id', 'timeframe', 'start', 'end'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    instrument_id: Mapped[str] = mapped_column(String(40), ForeignKey('instruments.id'))
    timeframe: Mapped[str] = mapped_column(String(8))
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    attempts: Mapped[int] = mapped_column(default=0)
    next_at: Mapped[int] = mapped_column(BigInteger, default=0)
    error: Mapped[str | None] = mapped_column(String(200))


class VolumeBackfillJob(Base):
    __tablename__ = "volume_backfill_jobs"
    __table_args__ = (Index("ix_volume_jobs_selection", "status", "next_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    instrument_id: Mapped[str] = mapped_column(String(40), ForeignKey("instruments.id"), index=True)
    source: Mapped[str] = mapped_column(String(32))
    symbol: Mapped[str] = mapped_column(String(64))
    basis: Mapped[str] = mapped_column(String(16))
    calendar: Mapped[str] = mapped_column(String(16))
    calendar_profile: Mapped[dict] = mapped_column(JSON)
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    cursor: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    generation: Mapped[int] = mapped_column(default=0)
    lease_token: Mapped[str | None] = mapped_column(String(36))
    lease_until: Mapped[int] = mapped_column(BigInteger, default=0)
    attempts: Mapped[int] = mapped_column(default=0)
    next_at: Mapped[int] = mapped_column(BigInteger, default=0)
    error: Mapped[str | None] = mapped_column(String(250))
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)


class VolumeBackfillSegment(Base):
    __tablename__ = "volume_backfill_segments"
    __table_args__ = (Index("ix_volume_segments_range", "job_id", "start", "end"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[str] = mapped_column(String(36), ForeignKey("volume_backfill_jobs.id"))
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(24))
    detail: Mapped[str | None] = mapped_column(String(250))


class AgentCredential(Base):
    __tablename__ = "agent_credentials"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    agent_id: Mapped[str] = mapped_column(String(80), index=True)
    scopes: Mapped[list] = mapped_column(JSON)
    expires_at: Mapped[int] = mapped_column(BigInteger)
    revoked_at: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    quota_start: Mapped[int] = mapped_column(BigInteger, default=0)
    quota_count: Mapped[int] = mapped_column(default=0)


class AgentOperation(Base):
    __tablename__ = "agent_operations"
    __table_args__ = (UniqueConstraint("agent_id", "capability", "key"),)
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=uid)
    agent_id: Mapped[str] = mapped_column(String(80))
    capability: Mapped[str] = mapped_column(String(80))
    key: Mapped[str] = mapped_column(String(100))
    intent_hash: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
