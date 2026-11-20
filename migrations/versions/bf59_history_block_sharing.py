"""Reuse immutable period payloads across fixed history versions."""

import sqlalchemy as sa
from alembic import op

revision = "bf59_history_block_sharing"
down_revision = "be58_market_briefings"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("market_history_artifact_blocks") as batch:
        batch.add_column(sa.Column("source_block_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("input_count", sa.BigInteger(), nullable=True))
        batch.add_column(sa.Column("complete_count", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_artifact_block_source",
            "market_history_artifact_blocks",
            ["source_block_id"],
            ["id"],
        )
        batch.create_index("ix_market_history_artifact_blocks_source_block_id", ["source_block_id"])


def downgrade():
    if op.get_bind().scalar(
        sa.text(
            "SELECT 1 FROM market_history_artifact_blocks WHERE source_block_id IS NOT NULL LIMIT 1"
        )
    ):
        raise RuntimeError(
            "Shared period payloads exist; retain the shared-block reader and disable new sharing writes"
        )
    with op.batch_alter_table("market_history_artifact_blocks") as batch:
        batch.drop_index("ix_market_history_artifact_blocks_source_block_id")
        batch.drop_constraint("fk_artifact_block_source", type_="foreignkey")
        batch.drop_column("complete_count")
        batch.drop_column("input_count")
        batch.drop_column("source_block_id")
