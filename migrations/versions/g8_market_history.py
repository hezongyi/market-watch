"""Market coverage, provider catalog, and chart activity leases."""

import sqlalchemy as sa
from alembic import op

revision = "g8_market_history"
down_revision = "f7_advanced_workspaces"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index(
        "ix_candles_revision_lookup", "candles", ["instrument_id", "timeframe", "received_at"]
    )
    op.create_table(
        "market_data_coverage",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("instrument_id", sa.String(40), sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("basis", sa.String(16), nullable=False),
        sa.Column("start", sa.BigInteger(), nullable=False),
        sa.Column("end", sa.BigInteger(), nullable=False),
        sa.Column("observed", sa.Integer(), nullable=False),
        sa.Column("queried_at", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("instrument_id", "source", "basis", "start", "end"),
    )
    op.create_index(
        "ix_market_coverage_interval", "market_data_coverage", ["instrument_id", "start", "end"]
    )
    op.create_table(
        "market_instrument_catalog",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("symbol", sa.String(64), nullable=False),
        sa.Column("label", sa.String(200), nullable=False),
        sa.Column("asset_type", sa.String(32), nullable=False),
        sa.Column("precision", sa.Integer(), nullable=False),
        sa.Column("calendar", sa.String(32)),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column("available", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "market_data_demand",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("instrument_id", sa.String(40), sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("expires", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )
    op.create_index("ix_market_data_demand_instrument_id", "market_data_demand", ["instrument_id"])
    op.create_index("ix_market_data_demand_expires", "market_data_demand", ["expires"])


def downgrade():
    op.drop_table("market_data_demand")
    op.drop_table("market_instrument_catalog")
    op.drop_table("market_data_coverage")
    op.drop_index("ix_candles_revision_lookup", table_name="candles")
