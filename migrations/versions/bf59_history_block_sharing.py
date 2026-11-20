"""Reuse immutable period payloads across fixed history versions."""

import sqlalchemy as sa
from alembic import op

revision = "bf59_history_block_sharing"
down_revision = "be58_market_briefings"
branch_labels = None
depends_on = None


def upgrade():
    # Earlier bootstrap revisions import the current ORM on a fresh database.
    # Existing deployed databases still need the additive columns; fresh ones
    # can already have this exact shape before reaching this revision.
    inspector = sa.inspect(op.get_bind())
    table = "market_history_artifact_blocks"
    columns = {column["name"] for column in inspector.get_columns(table)}
    foreign_keys = inspector.get_foreign_keys(table)
    indexes = {index["name"] for index in inspector.get_indexes(table)}
    with op.batch_alter_table("market_history_artifact_blocks") as batch:
        for name, kind in (
            ("source_block_id", sa.String(36)),
            ("input_count", sa.BigInteger()),
            ("complete_count", sa.Integer()),
        ):
            if name not in columns:
                batch.add_column(sa.Column(name, kind, nullable=True))
        if not any(key["constrained_columns"] == ["source_block_id"] for key in foreign_keys):
            batch.create_foreign_key(
                "fk_artifact_block_source",
                table,
                ["source_block_id"],
                ["id"],
            )
        if "ix_market_history_artifact_blocks_source_block_id" not in indexes:
            batch.create_index(
                "ix_market_history_artifact_blocks_source_block_id", ["source_block_id"]
            )


def downgrade():
    if op.get_bind().scalar(
        sa.text(
            "SELECT 1 FROM market_history_artifact_blocks WHERE source_block_id IS NOT NULL LIMIT 1"
        )
    ):
        raise RuntimeError(
            "Shared period payloads exist; retain the shared-block reader and disable new sharing writes"
        )
    foreign_key = next(
        key
        for key in sa.inspect(op.get_bind()).get_foreign_keys("market_history_artifact_blocks")
        if key["constrained_columns"] == ["source_block_id"]
    )
    # SQLite's additive bootstrap can have an anonymous inline FK. Assign a
    # reflection name so batch downgrade can drop that same constraint safely.
    constraint_name = foreign_key["name"] or "fk_artifact_block_source_block_id"
    with op.batch_alter_table(
        "market_history_artifact_blocks",
        naming_convention={"fk": "fk_artifact_block_%(column_0_name)s"},
    ) as batch:
        batch.drop_index("ix_market_history_artifact_blocks_source_block_id")
        batch.drop_constraint(constraint_name, type_="foreignkey")
        batch.drop_column("complete_count")
        batch.drop_column("input_count")
        batch.drop_column("source_block_id")
