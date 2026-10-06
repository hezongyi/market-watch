"""Explicit mappings and fixed-history composite revisions, additive identities."""

import sqlalchemy as sa
from alembic import op

revision = "ae32_composite_definitions"
down_revision = "ad31_history_read_attempts"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("market_realtime_mappings",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("dataset_id", sa.String(64), sa.ForeignKey("market_datasets.id"), nullable=False),
        sa.Column("target_dataset_id", sa.String(64), sa.ForeignKey("market_datasets.id"), nullable=False),
        sa.Column("permission_scope", sa.String(80), nullable=False),
        sa.Column("match", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False))
    op.create_index("ix_market_realtime_mappings_dataset_id", "market_realtime_mappings", ["dataset_id"])
    op.create_table("market_composites",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("instrument_id", sa.String(40), sa.ForeignKey("instruments.id"), nullable=False, unique=True),
        sa.Column("dataset_id", sa.String(64), sa.ForeignKey("market_datasets.id"), nullable=False),
        sa.Column("mapping_id", sa.String(64), sa.ForeignKey("market_realtime_mappings.id"), nullable=False),
        sa.Column("permission_scope", sa.String(80), nullable=False),
        sa.Column("rules", sa.JSON(), nullable=False),
        sa.Column("active_revision_id", sa.String(36)),
        sa.Column("created_at", sa.BigInteger(), nullable=False))
    op.create_index("ix_market_composites_dataset_id", "market_composites", ["dataset_id"])
    op.create_table("market_composite_revisions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("composite_id", sa.String(64), sa.ForeignKey("market_composites.id"), nullable=False),
        sa.Column("history_version_id", sa.String(36), sa.ForeignKey("market_history_versions.id"), nullable=False),
        sa.Column("mapping_id", sa.String(64), sa.ForeignKey("market_realtime_mappings.id"), nullable=False),
        sa.Column("parent_revision_id", sa.String(36)),
        sa.Column("seam", sa.BigInteger(), nullable=False),
        sa.Column("rules", sa.JSON(), nullable=False),
        sa.Column("request_id", sa.String(100), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("activated_at", sa.BigInteger()),
        sa.UniqueConstraint("composite_id", "request_id"))
    op.create_index("ix_market_composite_revisions_composite_id", "market_composite_revisions", ["composite_id"])
    op.create_table("market_composite_preparations",
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), primary_key=True),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("cursor", sa.BigInteger(), nullable=False),
        sa.Column("cutoff", sa.BigInteger(), nullable=False),
        sa.Column("confirmed_end", sa.BigInteger(), nullable=False),
        sa.Column("input_revision", sa.BigInteger(), nullable=False),
        sa.Column("lease_token", sa.String(36)),
        sa.Column("lease_until", sa.BigInteger(), nullable=False),
        sa.Column("next_at", sa.BigInteger(), nullable=False),
        sa.Column("error", sa.String(40)),
        sa.Column("state", sa.JSON(), nullable=False))


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_realtime_mappings")):
        raise RuntimeError("Explicit market mappings exist; restore a verified backup")
    for table in ("market_composite_preparations", "market_composite_revisions", "market_composites", "market_realtime_mappings"):
        op.drop_table(table)
