"""Index persistent provider directories for local-first paging."""

import sqlalchemy as sa
from alembic import op

revision = "bb55_provider_catalog_indexes"
down_revision = "ba54_market_switch_runs"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    names = {item["name"] for item in inspector.get_indexes("market_instrument_catalog")}
    if "ix_market_instrument_catalog_source_symbol" not in names:
        op.create_index("ix_market_instrument_catalog_source_symbol", "market_instrument_catalog", ["source", "symbol"])
    if "ix_market_instrument_catalog_source_available" not in names:
        op.create_index("ix_market_instrument_catalog_source_available", "market_instrument_catalog", ["source", "available"])
    if op.get_bind().dialect.name == "postgresql":
        op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
        expression = " || ' ' || ".join("coalesce(" + field + ", '')" for field in (
            "symbol", "label", "metadata_json->>'name_zh'", "metadata_json->>'exchange'",
            "metadata_json->>'english_name'", "source", "asset_type"))
        op.execute("CREATE INDEX IF NOT EXISTS ix_provider_directory_search ON market_instrument_catalog "
            "USING gin ((" + expression + ") public.gin_trgm_ops)")
        op.execute("CREATE INDEX IF NOT EXISTS ix_provider_directory_compact_search ON market_instrument_catalog "
            "USING gin ((replace(replace(replace(" + expression + ", '_', ''), '/', ''), '-', '')) public.gin_trgm_ops)")


def downgrade():
    if op.get_bind().dialect.name == "postgresql":
        op.execute("DROP INDEX IF EXISTS ix_provider_directory_compact_search")
        op.execute("DROP INDEX IF EXISTS ix_provider_directory_search")
    op.drop_index("ix_market_instrument_catalog_source_available", table_name="market_instrument_catalog")
    op.drop_index("ix_market_instrument_catalog_source_symbol", table_name="market_instrument_catalog")
