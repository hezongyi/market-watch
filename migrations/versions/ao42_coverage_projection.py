"""Add proof projection and restartable migration; leave compatibility data intact."""

import sqlalchemy as sa
from alembic import op

revision = "ao42_coverage_projection"
down_revision = "an41_publication_state"
branch_labels = None
depends_on = None


def identity():
    return [sa.Column("instrument_id", sa.String(40), sa.ForeignKey("instruments.id"), primary_key=True),
            sa.Column("source", sa.String(32), primary_key=True),
            sa.Column("basis", sa.String(16), primary_key=True)]


def upgrade():
    existing = sa.inspect(op.get_bind()).get_table_names()
    if "market_coverage_checkpoints" not in existing:
        op.create_table("market_coverage_checkpoints", *identity(),
            sa.Column("phase", sa.String(20), nullable=False, server_default="structured"),
            sa.Column("structured_cursor", sa.String(40), nullable=False, server_default=""),
            sa.Column("audit_cursor", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("complete", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("version", sa.BigInteger(), nullable=False, server_default="0"))
    if "market_coverage_projection" not in existing:
        op.create_table("market_coverage_projection", *identity(),
            sa.Column("start", sa.BigInteger(), primary_key=True),
            sa.Column("end", sa.BigInteger(), nullable=False))
    if "market_coverage_quarantine" not in existing:
        op.create_table("market_coverage_quarantine", *identity(),
            sa.Column("record_id", sa.String(50), primary_key=True),
            sa.Column("reason", sa.String(40), nullable=False))


def downgrade():
    # Runtime rollback should preserve projections and proof provenance. This
    # explicit schema downgrade is safe because raw compatibility data is intact.
    for name in ("market_coverage_quarantine", "market_coverage_projection", "market_coverage_checkpoints"):
        op.drop_table(name)
