"""Add source metadata without changing managed history or workspace schemas."""

import sqlalchemy as sa
from alembic import op

revision = "q18_yahoo_catalog"
down_revision = "p17_volume"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "market_instrument_catalog",
        sa.Column("metadata_json", sa.JSON(), nullable=False, server_default="{}"),
    )


def downgrade():
    op.drop_column("market_instrument_catalog", "metadata_json")
