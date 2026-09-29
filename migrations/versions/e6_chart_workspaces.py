"""Independent chart workspaces and indicator templates."""

import sqlalchemy as sa
from alembic import op

revision = "e6_chart_workspaces"
down_revision = "d5f9da861104"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "chart_workspaces",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )
    op.create_table(
        "chart_indicator_templates",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("indicators", sa.JSON(), nullable=False),
    )


def downgrade():
    op.drop_table("chart_indicator_templates")
    op.drop_table("chart_workspaces")
