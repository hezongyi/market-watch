"""Separate actual bar revisions from unchanged observations."""

import sqlalchemy as sa
from alembic import op

revision = "n15_provider_revisions"
down_revision = "m14_provider_cache"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "provider_bars",
        sa.Column("changed_at", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.execute("UPDATE provider_bars SET changed_at = observed_at")


def downgrade():
    op.drop_column("provider_bars", "changed_at")
