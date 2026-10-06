"""Immutable composite rule judgment evidence, preserving existing alert owners."""

import sqlalchemy as sa
from alembic import op

revision = "ai36_composite_alerts"
down_revision = "ah35_fixed_indicators"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("market_composite_judgments",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("alert_version_id", sa.String(36), sa.ForeignKey("chart_alert_versions.id"), nullable=False),
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), nullable=False),
        sa.Column("history_version_id", sa.String(36), sa.ForeignKey("market_history_versions.id"), nullable=False),
        sa.Column("input_revision", sa.BigInteger(), nullable=False),
        sa.Column("event_time", sa.BigInteger(), nullable=False),
        sa.Column("outcome", sa.String(32), nullable=False),
        sa.Column("signal_id", sa.String(36), sa.ForeignKey("signals.id")),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False))
    op.create_index("ix_market_composite_judgments_alert_version_id", "market_composite_judgments", ["alert_version_id"])
    op.create_index("ix_market_composite_judgments_revision_id", "market_composite_judgments", ["revision_id"])


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_composite_judgments")):
        raise RuntimeError("Composite judgments exist; restore a verified backup")
    op.drop_table("market_composite_judgments")
