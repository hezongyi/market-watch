"""User-level native chart templates and preferences."""

import sqlalchemy as sa
from alembic import op

revision = "h9_chart_preferences"
down_revision = "g8_market_history"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "advanced_chart_preferences",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("name", sa.String(250), nullable=False),
        sa.Column("tool", sa.String(100), nullable=False),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )
    op.create_index("ix_advanced_chart_preferences_kind", "advanced_chart_preferences", ["kind"])


def downgrade():
    op.drop_table("advanced_chart_preferences")
