"""Associate legacy derived identities with immutable source M1 identities.

Only known explicit channels are mapped. No instrument, candle, snapshot,
replay, provider cache or published manifest is rewritten.
"""

import hashlib
import json

from alembic import op
from alerts.storage import DatasetSource, MarketDataset, SourceSeries
from sqlalchemy import select, text

revision = "y26_source_series"
down_revision = "x25_dataset_asset_class"
branch_labels = None
depends_on = None


def legacy_source(old):
    """Freeze y26 normalization; future adapters must not change this migration."""
    signature = tuple(old.get(key) for key in ("source", "channel", "environment", "basis"))
    parameters = {
        ("dukascopy", "python", "historical", "bid"): {"granularity": "M1", "offer_side": "BID"},
        ("oanda", "v20", "practice", "bid"): {"granularity": "M1", "price": "B", "smooth": False},
        ("binance", "rest", "public", "last"): {"interval": "1m", "market": "spot"},
    }.get(signature)
    keys = ("source", "channel", "environment", "account_scope", "provider_symbol", "basis")
    if parameters is None or not all(old.get(key) for key in keys):
        return None
    identity = {**{key: old[key] for key in keys}, "parameters": parameters}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return key, identity


def upgrade():
    bind = op.get_bind()
    SourceSeries.__table__.create(bind, checkfirst=True)
    DatasetSource.__table__.create(bind, checkfirst=True)
    from sqlalchemy.dialects.postgresql import insert as postgres_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    insert = postgres_insert if bind.dialect.name == "postgresql" else sqlite_insert
    rows = bind.execute(select(MarketDataset.id, MarketDataset.identity))
    for dataset_id, old in rows:
        source = legacy_source(old)
        if source is None:
            continue
        key, identity = source
        bind.execute(insert(SourceSeries).values(id=key, identity=identity)
                     .on_conflict_do_nothing(index_elements=["id"]))
        bind.execute(insert(DatasetSource).values(dataset_id=dataset_id, source_id=key)
                     .on_conflict_do_nothing(index_elements=["dataset_id"]))


def downgrade():
    if op.get_bind().scalar(text("SELECT COUNT(*) FROM market_dataset_sources")):
        raise RuntimeError("Source bindings exist; restore the verified pre-migration backup")
    op.drop_table("market_dataset_sources")
    op.drop_table("market_source_series")
