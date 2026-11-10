"""Bounded transactional price alert observations.

Revision ID: bc56_price_alert_inputs
Revises: bb55_provider_catalog_indexes
"""

import sqlalchemy as sa
from alembic import op

revision = "bc56_price_alert_inputs"
down_revision = "bb55_provider_catalog_indexes"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("price_alert_streams",
        sa.Column("dataset_id", sa.String(64), sa.ForeignKey("market_datasets.id"), primary_key=True),
        sa.Column("sequence", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("trimmed_through", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("trimmed_start", sa.BigInteger()),
        sa.Column("trimmed_end", sa.BigInteger()),
        sa.Column("registered_at", sa.BigInteger(), nullable=False),
        sa.Column("last_event_key", sa.String(128)),
        sa.Column("last_mode", sa.String(24)),
        sa.Column("last_epoch", sa.BigInteger()),
        sa.Column("last_received_at", sa.BigInteger()),
        sa.Column("interrupted", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_table("price_alert_inputs",
        sa.Column("dataset_id", sa.String(64), sa.ForeignKey("price_alert_streams.dataset_id"), primary_key=True),
        sa.Column("sequence", sa.BigInteger(), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("price", sa.String(100)),
        sa.Column("occurred_at", sa.BigInteger(), nullable=False),
        sa.Column("received_at", sa.BigInteger(), nullable=False),
        sa.Column("mode", sa.String(24), nullable=False),
        sa.Column("epoch", sa.BigInteger(), nullable=False),
        sa.Column("event_key", sa.String(128), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False))
    op.create_index("ix_price_alert_inputs_received", "price_alert_inputs", ["received_at", "dataset_id"])


def downgrade():
    raise RuntimeError("Price observations are evidence; pause price-v2 writers before code rollback. Do not delete the log.")
