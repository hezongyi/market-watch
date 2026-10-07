"""Retain immutable version identities when unreferenced payloads are reclaimed."""

import sqlalchemy as sa
from alembic import op

revision = "ac30_history_reclamation"
down_revision = "ab29_history_artifacts"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("market_history_reclamations",
        sa.Column("version_id", sa.String(36), sa.ForeignKey("market_history_versions.id"), primary_key=True),
        sa.Column("request_id", sa.String(100), nullable=False),
        sa.Column("reclaimed_at", sa.BigInteger(), nullable=False))
    op.create_table("market_dataset_reclamations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("dataset_id", sa.String(64), sa.ForeignKey("market_datasets.id"), nullable=False),
        sa.Column("request_id", sa.String(100), nullable=False),
        sa.Column("reclaimed_at", sa.BigInteger(), nullable=False),
        sa.Column("summary", sa.JSON(), nullable=False),
        sa.UniqueConstraint("dataset_id", "request_id"))
    op.create_index("ix_market_dataset_reclamations_dataset_id", "market_dataset_reclamations", ["dataset_id"])


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_dataset_reclamations")):
        raise RuntimeError("Reclaimed versions exist; restore a verified backup")
    op.drop_table("market_dataset_reclamations")
    op.drop_table("market_history_reclamations")
