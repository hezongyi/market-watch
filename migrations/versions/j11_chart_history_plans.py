"""Persistent shared chart history plans and ephemeral viewport priorities."""
import sqlalchemy as sa
from alembic import op

revision = "j11_chart_history_plans"
down_revision = "i10_weekly_history_requests"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("import_jobs", sa.Column("chart_plan", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_table("chart_history_plans",
        sa.Column("instrument_id", sa.String(40), sa.ForeignKey("instruments.id"), primary_key=True),
        sa.Column("target_start", sa.BigInteger(), nullable=False),
        sa.Column("target_end", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False))
    op.create_table("chart_viewport_demands",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("instrument_id", sa.String(40), sa.ForeignKey("instruments.id"), nullable=False),
        sa.Column("timeframe", sa.String(8), nullable=False),
        sa.Column("start", sa.BigInteger(), nullable=False),
        sa.Column("end", sa.BigInteger(), nullable=False),
        sa.Column("warm_start", sa.BigInteger(), nullable=False),
        sa.Column("focused", sa.Boolean(), nullable=False),
        sa.Column("expires", sa.BigInteger(), nullable=False))
    for column in ("instrument_id", "expires"):
        op.create_index(f"ix_chart_viewport_demands_{column}", "chart_viewport_demands", [column])


def downgrade():
    op.drop_column("import_jobs", "chart_plan")
    op.drop_table("chart_viewport_demands")
    op.drop_table("chart_history_plans")
