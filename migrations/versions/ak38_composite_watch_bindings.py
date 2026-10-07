"""Add fixed input bindings for the four existing strategy kinds."""

import sqlalchemy as sa
from alembic import op

revision = "ak38_composite_watch_bindings"
down_revision = "aj37_composite_revision_changes"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("market_composite_watch_bindings",
        sa.Column("watch_id", sa.String(36), sa.ForeignKey("watches.id"), primary_key=True),
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), nullable=False),
        sa.Column("history_version_id", sa.String(36), sa.ForeignKey("market_history_versions.id"), nullable=False),
        sa.Column("market_identity", sa.JSON(), nullable=False),
        sa.Column("use_history", sa.Boolean(), nullable=False),
        sa.Column("health", sa.String(16), nullable=False),
        sa.Column("health_reason", sa.String(250)),
        sa.Column("runtime", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False))
    for column in ("revision_id", "history_version_id", "updated_at"):
        op.create_index("ix_market_composite_watch_bindings_" + column,
                        "market_composite_watch_bindings", [column])
    op.create_table("market_composite_watch_judgments",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("watch_id", sa.String(36), sa.ForeignKey("watches.id"), nullable=False),
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), nullable=False),
        sa.Column("history_version_id", sa.String(36), sa.ForeignKey("market_history_versions.id"), nullable=False),
        sa.Column("input_revision", sa.BigInteger(), nullable=False),
        sa.Column("event_time", sa.BigInteger(), nullable=False),
        sa.Column("outcome", sa.String(32), nullable=False),
        sa.Column("signal_id", sa.String(36), sa.ForeignKey("signals.id")),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False))
    for column in ("watch_id", "revision_id"):
        op.create_index("ix_market_composite_watch_judgments_" + column,
                        "market_composite_watch_judgments", [column])


def downgrade():
    for table in ("market_composite_watch_bindings", "market_composite_watch_judgments"):
        if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM " + table)):
            raise RuntimeError("Fixed strategy bindings exist; restore a verified backup")
    op.drop_table("market_composite_watch_judgments")
    op.drop_table("market_composite_watch_bindings")
