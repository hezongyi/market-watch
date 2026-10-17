"""Expiring shared indicator priority with a durable maintenance service share.

Additive: old workers continue reading existing runs and ignore these tables.
Rollback stops new demand writers, then drops only disposable priority state.
Immutable results/checkpoints remain in their original tables.
"""

import sqlalchemy as sa
from alembic import op

revision = "av49_indicator_demands"
down_revision = "au48_display_indicator_tasks"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("market_indicator_demands"):
        op.create_table(
            "market_indicator_demands",
            sa.Column("id", sa.String(64), primary_key=True),
            sa.Column("client", sa.String(64), nullable=False),
            sa.Column("consumer", sa.String(100), nullable=False),
            sa.Column(
                "run_id",
                sa.String(64),
                sa.ForeignKey("market_fixed_indicator_runs.id", ondelete="CASCADE"),
            ),
            sa.Column(
                "snapshot_id",
                sa.String(64),
                sa.ForeignKey("market_display_snapshots.id", ondelete="CASCADE"),
            ),
            sa.Column("start", sa.BigInteger(), nullable=False),
            sa.Column("end", sa.BigInteger(), nullable=False),
            sa.Column("purpose", sa.String(12), nullable=False),
            sa.Column("expires", sa.BigInteger(), nullable=False),
        )
        op.add_column(
            "market_indicator_demands", sa.Column("generation", sa.BigInteger(), nullable=False)
        )
        op.add_column(
            "market_indicator_demands", sa.Column("released", sa.Boolean(), nullable=False)
        )
        for column in ("client", "run_id", "expires"):
            op.create_index(
                "ix_market_indicator_demands_" + column, "market_indicator_demands", [column]
            )
    if not sa.inspect(bind).has_table("market_indicator_schedule"):
        op.create_table(
            "market_indicator_schedule",
            sa.Column("kind", sa.String(12), primary_key=True),
            sa.Column("turn", sa.BigInteger(), nullable=False),
        )


def downgrade():
    op.drop_table("market_indicator_demands")
    op.drop_table("market_indicator_schedule")
