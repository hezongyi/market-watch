"""Persist dataset asset class without changing any existing aggregation phase."""

from alembic import op
from sqlalchemy import Column, String, inspect

revision = "x25_dataset_asset_class"
down_revision = "w24_merge_market_data"
branch_labels = None
depends_on = None


def upgrade():
    if "asset_class" not in {c["name"] for c in inspect(op.get_bind()).get_columns("market_datasets")}:
        op.add_column("market_datasets", Column("asset_class", String(16), nullable=False,
                                               server_default="unspecified"))


def downgrade():
    with op.batch_alter_table("market_datasets") as batch:
        batch.drop_column("asset_class")
