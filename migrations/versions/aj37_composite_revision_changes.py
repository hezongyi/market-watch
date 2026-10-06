"""Explicit composite revision requests and atomic activation evidence."""

import sqlalchemy as sa
from alembic import op

revision = "aj37_composite_revision_changes"
down_revision = "ai36_composite_alerts"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("market_composite_revision_changes",
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), primary_key=True),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("reason", sa.String(1000), nullable=False),
        sa.Column("manifest", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False))
    op.create_table("market_composite_activations",
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), primary_key=True),
        sa.Column("previous_revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), nullable=False),
        sa.Column("request_id", sa.String(100), nullable=False),
        sa.Column("input_revision", sa.BigInteger(), nullable=False),
        sa.Column("event_boundary", sa.BigInteger(), nullable=False),
        sa.Column("at", sa.BigInteger(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False))


def downgrade():
    for table in ("market_composite_revision_changes", "market_composite_activations"):
        if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM " + table)):
            raise RuntimeError("Composite revision change evidence exists; restore a verified backup")
    op.drop_table("market_composite_activations")
    op.drop_table("market_composite_revision_changes")
