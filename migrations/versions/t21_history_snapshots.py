"""Immutable historical chunks and durable fixed-window imports."""

import sqlalchemy as sa
from alembic import op
from alerts.storage import HistoryChunk, HistoryVersion

revision = "t21_history_snapshots"
down_revision = "s20_market_datasets"
branch_labels = None
depends_on = None


def upgrade():
    HistoryVersion.__table__.create(op.get_bind())
    HistoryChunk.__table__.create(op.get_bind())


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_history_versions")):
        raise RuntimeError("Restore the pre-migration backup before discarding historical versions")
    op.drop_table("market_history_chunks")
    op.drop_table("market_history_versions")
