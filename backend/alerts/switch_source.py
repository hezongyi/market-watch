"""Source capability boundary for a revision switch.

A candidate may only take over as the running revision when its live source
keeps the account scope, environment, instrument, price basis, precision,
confirmed-minute semantics and freshness of the running revision.  Any other
difference stays a rejected candidate: the switch never translates a price
basis gap into a real crossing.

The fixture block at the bottom is explicitly labelled: it exercises independent
source identity and a rejected switch, and no real standby provider is wired.
"""

from dataclasses import asdict, dataclass

from .history_catalog import account_scope
from .source_registry import capabilities as source_capabilities
from .storage import HistoryVersion, Instrument, MarketDataset, RealtimeMapping

# composite_alerts fences a sample older than this; a candidate that cannot
# deliver inside it would keep every rule permanently stale.
REQUIRED_FRESHNESS_MS = 15000
# Declared live delivery latency of a provider family/channel, in milliseconds.
DELIVERY_MS = {("oanda", "v20"): 5000}
FIELDS = (("account_scope", "账户范围"), ("environment", "环境"), ("instrument", "品种"),
          ("basis", "价格口径"), ("confirmation", "确认语义"),
          ("precision", "精度"), ("freshness_ms", "新鲜度"))


class SourceIncompatible(ValueError):
    """A candidate source cannot serve the running revision contract."""

    def __init__(self, report):
        self.report = report
        super().__init__("候选来源不兼容：" + "；".join(report["reasons"]))


@dataclass(frozen=True)
class SourceCapability:
    """Declared capability of one live source, never a credential or a price."""

    identity: str
    source: str
    channel: str
    environment: str
    account_scope: str
    instrument: str
    provider_symbol: str
    basis: str
    precision: int
    calendar_version: str
    confirmation: str
    freshness_ms: int | None

    def record(self):
        return asdict(self)


def capabilities(db, revision):
    """Read the live source a revision is bound to; no supplier request."""
    version = db.get(HistoryVersion, revision.history_version_id)
    history = db.get(MarketDataset, version.dataset_id)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    live, base = dict(target.identity), dict(history.identity)
    live_instrument = db.get(Instrument, target.instrument_id)
    history_instrument = db.get(Instrument, history.instrument_id)
    try:
        declared = source_capabilities(live["source"])
    except ValueError:
        declared = {}
    # A provider without a stream or a confirmed M1 path cannot serve a rule.
    confirmed = bool(declared.get("confirmation_m1"))
    return SourceCapability(
        identity=target.id, source=live["source"],
        channel=live["channel"], environment=live["environment"],
        account_scope=live["account_scope"], instrument=history.logical_symbol,
        provider_symbol=live["provider_symbol"], basis=live.get("basis") or live_instrument.basis,
        precision=max(history_instrument.precision, live_instrument.precision),
        calendar_version=base["calendar_version"],
        confirmation="confirmed_minutes" if confirmed else "unconfirmed",
        freshness_ms=DELIVERY_MS.get((live["source"], live["channel"]),
                                    5000 if declared.get("stream") else None))


def compare(previous, candidate, *, account=None):
    """Return every declared difference; the candidate is only a candidate."""
    account = account_scope() if account is None else account
    accepted = {
        "account_scope": previous.account_scope == candidate.account_scope
        and candidate.account_scope == account,
        "environment": previous.environment == candidate.environment,
        "instrument": previous.instrument == candidate.instrument,
        "basis": previous.basis == candidate.basis,
        # A price basis or symbol change is a different product, not a switch.
        "confirmation": previous.confirmation == candidate.confirmation
        and candidate.confirmation == "confirmed_minutes",
        # A finer source is acceptable; a coarser one rounds away crossings.
        "precision": candidate.precision >= previous.precision,
        # Freshness is a contract, not an identity: any value inside it serves.
        "freshness_ms": candidate.freshness_ms is not None
        and candidate.freshness_ms <= REQUIRED_FRESHNESS_MS,
    }
    checks, failures = [], []
    for field, label in FIELDS:
        before, after = getattr(previous, field), getattr(candidate, field)
        checks.append({"field": field, "label": label, "previous": before,
                       "candidate": after, "ok": bool(accepted[field])})
        if not accepted[field]:
            failures.append({"field": field, "label": label, "previous": before,
                             "candidate": after,
                             "reason": f"{label}不一致：当前 {before}，候选 {after}"})
    reasons = [failure["reason"] for failure in failures]
    return {"compatible": not reasons, "reasons": reasons, "failures": failures,
            "checks": checks,
            "switch": candidate.identity != previous.identity,
            "previous": previous.record(), "candidate": candidate.record(),
            "required_freshness_ms": REQUIRED_FRESHNESS_MS}


def validate(previous, candidate, *, account=None):
    """A switch is only legal on a fully compatible candidate capability."""
    result = compare(previous, candidate, account=account)
    if result["reasons"]:
        raise SourceIncompatible(result)
    return result


def check(db, previous, candidate):
    """Capability report used by activation; raises on an incompatible candidate."""
    return validate(capabilities(db, previous), capabilities(db, candidate))


# --- Fixtures: two labelled different sources, no real provider attached ------
FIXTURE = "fixture"
FIXTURES = {
    # Independent source identities of the same reviewed account and instrument.
    "fixture-primary": {"source": "fixture-primary", "channel": "python",
                        "environment": "practice", "provider_symbol": "EUR/USD",
                        "basis": "bid", "precision": 5, "freshness_ms": 5000},
    "fixture-standby": {"source": "fixture-standby", "channel": "rest",
                        "environment": "practice", "provider_symbol": "EUR/USD",
                        "basis": "bid", "precision": 5, "freshness_ms": 4000},
    # Ask-side and coarser: a rejected candidate, never a silent price shift.
    "fixture-incompatible": {"source": "fixture-incompatible", "channel": "rest",
                             "environment": "practice", "provider_symbol": "EUR/USD",
                             "basis": "ask", "precision": 3, "freshness_ms": 60000},
}


def fixture(name, *, account=None, instrument="EURUSD"):
    """A labelled fixture capability; it is not a dataset and never connects."""
    spec = FIXTURES[name]
    return SourceCapability(identity=f"fixture:{name}:{spec['basis']}", source=spec["source"],
        channel=spec["channel"], environment=spec["environment"],
        account_scope=account_scope() if account is None else account,
        instrument=instrument, provider_symbol=spec["provider_symbol"],
        basis=spec["basis"], precision=spec["precision"], calendar_version="fixture-ny17-v1",
        confirmation="confirmed_minutes", freshness_ms=spec["freshness_ms"])


def fixture_switch(previous="fixture-primary", candidate="fixture-standby", *, account=None):
    """Fixture-only proof of independent identity and of a rejected switch."""
    output = validate(fixture(previous, account=account), fixture(candidate, account=account))
    return {**output, FIXTURE: True, "labelled": "fixture sources; no standby provider is wired"}
