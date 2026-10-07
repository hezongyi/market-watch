"""Durable composite period tasks and immutable changed-bucket versions."""

import sqlalchemy as sa
from alembic import op

revision = "ag34_composite_aggregates"
down_revision = "af33_composite_inputs"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("market_composite_aggregate_tasks",
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), primary_key=True),
        sa.Column("timeframe", sa.String(4), primary_key=True),
        sa.Column("applied_input_revision", sa.BigInteger(), nullable=False),
        sa.Column("offset", sa.Integer(), nullable=False),
        sa.Column("lease_token", sa.String(36)),
        sa.Column("lease_until", sa.BigInteger(), nullable=False),
        sa.Column("next_at", sa.BigInteger(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("error", sa.String(40)),
        sa.Column("updated_at", sa.BigInteger(), nullable=False))
    op.create_table("market_composite_aggregate_bars",
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), primary_key=True),
        sa.Column("timeframe", sa.String(4), primary_key=True),
        sa.Column("start", sa.BigInteger(), primary_key=True),
        sa.Column("input_revision", sa.BigInteger(), primary_key=True),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False))


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_composite_aggregate_bars")):
        raise RuntimeError("Composite period snapshots exist; restore a verified backup")
    op.drop_table("market_composite_aggregate_bars")
    op.drop_table("market_composite_aggregate_tasks")
