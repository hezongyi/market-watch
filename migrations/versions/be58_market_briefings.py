"""Add daily briefing plan and immutable reports; existing plans remain disabled."""

import sqlalchemy as sa
from alembic import op

revision = "be58_market_briefings"
down_revision = "bd57_notice_source_poll_index"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "briefing_plans",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("group_ids", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("next_run_at", sa.BigInteger()),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )
    op.create_table(
        "briefing_reports",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("plan_id", sa.String(36), sa.ForeignKey("briefing_plans.id"), nullable=False),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("scheduled_for", sa.BigInteger()),
        sa.Column("cutoff_at", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("body", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("started_at", sa.BigInteger()),
        sa.Column("finished_at", sa.BigInteger()),
        sa.Column("notification_id", sa.String(36), sa.ForeignKey("notifications.id")),
        sa.Column("error", sa.String(500)),
        sa.UniqueConstraint("plan_id", "scheduled_for"),
    )
    op.create_index("ix_briefing_reports_history", "briefing_reports", ["mode", "created_at", "id"])


def downgrade():
    op.drop_table("briefing_reports")
    op.drop_table("briefing_plans")
