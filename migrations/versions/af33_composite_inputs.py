"""Persistent source-confirmed minute revisions and composite input audit."""

import sqlalchemy as sa
from alembic import op

revision = "af33_composite_inputs"
down_revision = "ae32_composite_definitions"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("market_source_minute_revisions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("source_id", sa.String(64), sa.ForeignKey("market_source_series.id"), nullable=False),
        sa.Column("start", sa.BigInteger(), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("observed_at", sa.BigInteger(), nullable=False),
        sa.Column("received_at", sa.BigInteger(), nullable=False))
    op.create_index("ix_market_source_minute_revisions_source_id", "market_source_minute_revisions", ["source_id"])
    op.create_index("ix_market_source_minute_revisions_start", "market_source_minute_revisions", ["start"])
    op.create_table("market_source_minutes",
        sa.Column("source_id", sa.String(64), sa.ForeignKey("market_source_series.id"), primary_key=True),
        sa.Column("start", sa.BigInteger(), primary_key=True),
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_source_minute_revisions.id"), nullable=False),
        sa.Column("last_observed_at", sa.BigInteger(), nullable=False))
    op.create_table("market_composite_input_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), nullable=False),
        sa.Column("input_revision", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("input_manifest", sa.JSON(), nullable=False),
        sa.UniqueConstraint("revision_id", "input_revision"))
    op.create_index("ix_market_composite_input_events_revision_id", "market_composite_input_events", ["revision_id"])
    op.create_table("market_composite_minute_inputs",
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), primary_key=True),
        sa.Column("start", sa.BigInteger(), primary_key=True),
        sa.Column("input_revision", sa.BigInteger(), primary_key=True),
        sa.Column("event_id", sa.String(36), sa.ForeignKey("market_composite_input_events.id"), nullable=False),
        sa.Column("source_revision_id", sa.String(36), sa.ForeignKey("market_source_minute_revisions.id"), nullable=False))
    op.create_index("ix_market_composite_minute_inputs_event_id", "market_composite_minute_inputs", ["event_id"])
    op.create_table("market_composite_minutes",
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), primary_key=True),
        sa.Column("start", sa.BigInteger(), primary_key=True),
        sa.Column("source_revision_id", sa.String(36), sa.ForeignKey("market_source_minute_revisions.id"), nullable=False))
    op.create_table("market_composite_read_attempts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("revision_id", sa.String(36), sa.ForeignKey("market_composite_revisions.id"), nullable=False),
        sa.Column("start", sa.BigInteger(), nullable=False),
        sa.Column("end", sa.BigInteger(), nullable=False),
        sa.Column("started_at", sa.BigInteger(), nullable=False),
        sa.Column("finished_at", sa.BigInteger()),
        sa.Column("result", sa.String(40), nullable=False),
        sa.Column("read_kind", sa.String(24), nullable=False),
        sa.Column("checkpoint", sa.BigInteger()),
        sa.Column("observed_at", sa.BigInteger()),
        sa.Column("observations", sa.Integer()),
        sa.Column("accepted", sa.Boolean(), nullable=False))
    op.create_index("ix_market_composite_read_attempts_revision_id", "market_composite_read_attempts", ["revision_id"])


def downgrade():
    if (op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_source_minute_revisions")) or
            op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_composite_input_events")) or
            op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_composite_read_attempts"))):
        raise RuntimeError("Confirmed minute audit exists; restore a verified backup")
    op.drop_table("market_composite_minutes")
    op.drop_table("market_composite_minute_inputs")
    op.drop_table("market_composite_read_attempts")
    op.drop_table("market_composite_input_events")
    op.drop_table("market_source_minutes")
    op.drop_table("market_source_minute_revisions")
