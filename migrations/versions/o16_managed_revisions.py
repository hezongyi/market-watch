"""Durable managed publication corrections and published-row revision checks."""

import sqlalchemy as sa
from alembic import op

revision = "o16_managed_revisions"
down_revision = "n15_provider_revisions"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("chart_published_bars", sa.Column(
        "revision", sa.Integer(), nullable=False, server_default="1"
    ))
    op.create_table("chart_publication_jobs",
        sa.Column("instrument_id", sa.String(40), sa.ForeignKey("instruments.id"), primary_key=True),
        sa.Column("timeframe", sa.String(8), primary_key=True),
        sa.Column("start", sa.BigInteger(), primary_key=True),
        sa.Column("end", sa.BigInteger(), nullable=False))
    # Existing snapshots may already have missed a correction in v1.3.0.
    # Seed every published bucket once; the publisher reconciles bounded pages.
    op.execute('INSERT INTO chart_publication_jobs (instrument_id, timeframe, start, "end") '
               'SELECT instrument_id, timeframe, start, "end" FROM chart_published_bars')


def downgrade():
    op.drop_table("chart_publication_jobs")
    op.drop_column("chart_published_bars", "revision")
