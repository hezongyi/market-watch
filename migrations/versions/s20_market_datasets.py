"""Add explicit managed identities without reinterpreting any legacy history."""

import sqlalchemy as sa
from alembic import op

revision = "s20_market_datasets"
down_revision = "r19_native_history_loads"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "market_datasets",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("instrument_id", sa.String(40), sa.ForeignKey("instruments.id"),
                  nullable=False, unique=True),
        sa.Column("logical_symbol", sa.String(10), nullable=False),
        sa.Column("identity", sa.JSON(), nullable=False),
        sa.Column("volume_kind", sa.String(20), nullable=False),
        sa.Column("volume_unit", sa.String(40)),
    )


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_datasets")):
        raise RuntimeError("Stop writers and restore the pre-migration backup before rollback "
                           "of a database with explicit dataset bindings")
    op.drop_table("market_datasets")
