"""Separate explanatory mapping notes without rewriting any runtime identity.

Application rollback retains this additive table, including notes written by v2.
"""

import sqlalchemy as sa
from alembic import op

revision = "ax51_mapping_notes"
down_revision = "aw50_notice_center"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("market_realtime_mapping_notes"):
        op.create_table("market_realtime_mapping_notes",
            sa.Column("id", sa.String(64), primary_key=True),
            sa.Column("mapping_id", sa.String(64), sa.ForeignKey("market_realtime_mappings.id"), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("content", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.BigInteger(), nullable=False),
            sa.UniqueConstraint("mapping_id", "version"))
    if "ix_market_realtime_mapping_notes_mapping_id" not in {
        row["name"] for row in inspector.get_indexes("market_realtime_mapping_notes")
    }:
        op.create_index("ix_market_realtime_mapping_notes_mapping_id", "market_realtime_mapping_notes", ["mapping_id"])


def downgrade():
    raise RuntimeError("Mapping notes are retained for application rollback; restore a verified backup for schema rollback")
