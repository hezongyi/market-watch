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


class Bar(Base):
    __tablename__ = "candles"
    __table_args__ = (UniqueConstraint("instrument_id", "timeframe", "start"),)
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


class SignalRow(Base):
    __tablename__ = "signals"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    watch_id: Mapped[str] = mapped_column(ForeignKey("watches.id"), unique=True)
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


class LoginSession(Base):
    __tablename__ = "sessions"
    token_hash: Mapped[str] = mapped_column(primary_key=True)
    csrf: Mapped[str]
    expires: Mapped[int] = mapped_column(BigInteger)


class Replay(Base):
    __tablename__ = "replays"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    instrument_id: Mapped[str]
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
    engine = create_engine(
        url, connect_args={"check_same_thread": False} if url.startswith("sqlite") else {}
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
    }


def candle_from(d):
    return Candle(
        instant(d["start"]),
        instant(d["end"]),
        *(Decimal(d[k]) for k in ["open", "high", "low", "close"]),
        d.get("complete", True),
        d.get("revision", 1),
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
