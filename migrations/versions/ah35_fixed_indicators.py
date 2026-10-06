"""Fixed-input full indicator initialization, durable state and immutable outputs."""

import sqlalchemy as sa
from alembic import op

revision = "ah35_fixed_indicators"
down_revision = "ag34_composite_aggregates"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("market_fixed_indicator_runs",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("group_key", sa.String(64), nullable=False),
        sa.Column("history_version_id", sa.String(36), sa.ForeignKey("market_history_versions.id"), nullable=False),
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id")),
        sa.Column("timeframe", sa.String(4), nullable=False),
        sa.Column("spec", sa.JSON(), nullable=False),
        sa.Column("algorithm", sa.String(40), nullable=False),
        sa.Column("input_revision", sa.BigInteger(), nullable=False),
        sa.Column("target_end", sa.BigInteger(), nullable=False),
        sa.Column("parent_id", sa.String(64), sa.ForeignKey("market_fixed_indicator_runs.id")),
        sa.Column("prefix_end", sa.BigInteger(), nullable=False),
        sa.Column("cursor", sa.BigInteger(), nullable=False),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("lease_token", sa.String(36)),
        sa.Column("lease_until", sa.BigInteger(), nullable=False),
        sa.Column("next_at", sa.BigInteger(), nullable=False),
        sa.Column("error", sa.String(40)),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False))
    op.create_index("ix_market_fixed_indicator_runs_history_version_id", "market_fixed_indicator_runs", ["history_version_id"])
    op.create_index("ix_market_fixed_indicator_runs_revision_id", "market_fixed_indicator_runs", ["revision_id"])
    op.create_index("ix_market_fixed_indicator_runs_group_key", "market_fixed_indicator_runs", ["group_key"])
    op.create_table("market_fixed_indicator_blocks",
        sa.Column("run_id", sa.String(64), sa.ForeignKey("market_fixed_indicator_runs.id"), primary_key=True),
        sa.Column("start", sa.BigInteger(), primary_key=True),
        sa.Column("end", sa.BigInteger(), nullable=False),
        sa.Column("checkpoint", sa.JSON(), nullable=False),
        sa.Column("checksum", sa.String(64), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False))


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_fixed_indicator_runs")):
        raise RuntimeError("Fixed indicator snapshots exist; restore a verified backup")
    op.drop_table("market_fixed_indicator_blocks")
    op.drop_table("market_fixed_indicator_runs")
