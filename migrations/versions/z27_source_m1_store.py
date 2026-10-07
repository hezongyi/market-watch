"""Share immutable source M1 content without rewriting existing snapshots."""

from alembic import op
from alerts.storage import SourceBlob, SourceFetch
from sqlalchemy import Column, String, inspect, text

revision = "z27_source_m1_store"
down_revision = "y26_source_series"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    SourceBlob.__table__.create(bind, checkfirst=True)
    SourceFetch.__table__.create(bind, checkfirst=True)
    if "content_id" not in {c["name"] for c in inspect(bind).get_columns("market_history_chunks")}:
        op.add_column("market_history_chunks", Column("content_id", String(64), nullable=True))
    if "ix_market_history_chunks_content_id" not in {
            i["name"] for i in inspect(bind).get_indexes("market_history_chunks")}:
        op.create_index("ix_market_history_chunks_content_id", "market_history_chunks", ["content_id"])


def downgrade():
    if op.get_bind().scalar(text("SELECT COUNT(*) FROM market_source_blobs")):
        raise RuntimeError("Shared source content exists; restore the verified pre-migration backup")
    op.drop_table("market_source_fetches")
    op.drop_table("market_source_blobs")
    with op.batch_alter_table("market_history_chunks") as batch:
        batch.drop_index("ix_market_history_chunks_content_id")
        batch.drop_column("content_id")
