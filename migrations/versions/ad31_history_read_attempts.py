"""Durable safe request evidence, without rewriting old version manifests."""

import sqlalchemy as sa
from alembic import op

revision = "ad31_history_read_attempts"
down_revision = "ac30_history_reclamation"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("market_history_read_attempts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("version_id", sa.String(36), sa.ForeignKey("market_history_versions.id"), nullable=False),
        sa.Column("start", sa.BigInteger(), nullable=False),
        sa.Column("end", sa.BigInteger(), nullable=False),
        sa.Column("started_at", sa.BigInteger(), nullable=False),
        sa.Column("finished_at", sa.BigInteger()),
        sa.Column("read_kind", sa.String(24), nullable=False),
        sa.Column("result", sa.String(40), nullable=False),
        sa.Column("checkpoint", sa.BigInteger()),
        sa.Column("observed_at", sa.BigInteger()),
        sa.Column("observations", sa.Integer()),
        sa.Column("accepted", sa.Boolean(), nullable=False))
    op.create_index("ix_market_history_read_attempts_version_id", "market_history_read_attempts", ["version_id"])


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_history_read_attempts")):
        raise RuntimeError("History request evidence exists; restore a verified backup")
    op.drop_table("market_history_read_attempts")
