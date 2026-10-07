"""Shared stream ownership, source snapshots and M1 measurement denominators."""

from alembic import op
from alerts.storage import LiveMinute, LiveState, PricingOwner
from sqlalchemy import text

revision = "v23_live_pricing"
down_revision = "u22_replay_dataset_version"
branch_labels = None
depends_on = None


def upgrade():
    for table in (PricingOwner, LiveState, LiveMinute):
        table.__table__.create(op.get_bind())


def downgrade():
    connection = op.get_bind()
    if any(connection.execute(text(f"SELECT 1 FROM {table} LIMIT 1")).first()
           for table in ("market_live_minutes", "market_live_states", "market_pricing_owners")):
        raise RuntimeError("Live acceptance evidence exists; restore this instance's pre-migration backup")
    for name in ("market_live_minutes", "market_live_states", "market_pricing_owners"):
        op.drop_table(name)
