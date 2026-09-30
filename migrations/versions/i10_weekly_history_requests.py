"""Durable low-priority weekly history requests."""

import sqlalchemy as sa
from alembic import op

revision = "i10_weekly_history_requests"
down_revision = "h9_chart_preferences"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "weekly_history_requests",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("instrument_id", sa.String(40), sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("before", sa.BigInteger(), nullable=False),
        sa.Column("cursor", sa.BigInteger(), nullable=False),
        sa.Column("remaining", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("next_at", sa.BigInteger(), nullable=False),
    )
    for column in ("instrument_id", "status", "next_at"):
        op.create_index(f"ix_weekly_history_requests_{column}", "weekly_history_requests", [column])


def downgrade():
    op.drop_table("weekly_history_requests")
