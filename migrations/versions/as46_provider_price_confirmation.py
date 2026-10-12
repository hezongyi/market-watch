"""Keep price confirmation independent of provider metadata refreshes."""

from alembic import op
from sqlalchemy import BigInteger, Column, inspect

revision = "as46_provider_price_confirmation"
down_revision = "ar45_market_stream"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if "price_confirmed_at" not in {c["name"] for c in inspect(bind).get_columns("provider_bars")}:
        # Legacy metadata changes cannot be distinguished retrospectively.
        # NULL preserves the conservative changed_at/observed_at fallback.
        op.add_column("provider_bars", Column("price_confirmed_at", BigInteger(), nullable=True))


def downgrade():
    with op.batch_alter_table("provider_bars") as batch:
        batch.drop_column("price_confirmed_at")
