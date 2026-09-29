"""Isolated licensed chart workspace storage."""

import sqlalchemy as sa
from alembic import op

revision = "f7_advanced_workspaces"
down_revision = "e6_chart_workspaces"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "advanced_chart_workspaces",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )


def downgrade():
    op.drop_table("advanced_chart_workspaces")
