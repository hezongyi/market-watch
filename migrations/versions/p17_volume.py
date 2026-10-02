"""Independent quantities, aggregation kind and fenced bounded volume jobs."""
import sqlalchemy as sa
from alembic import op

revision = 'p17_volume'
down_revision = 'o16_managed_revisions'
branch_labels = None
depends_on = None


def upgrade():
    for column in (
        sa.Column('volume', sa.Numeric(38, 18), nullable=True),
        sa.Column('volume_complete', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('volume_received_at', sa.BigInteger(), nullable=False, server_default='0'),
        sa.Column('volume_revision', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('observed_at', sa.BigInteger(), nullable=False, server_default='0'),
    ):
        op.add_column('candles', column)
    op.add_column('chart_aggregation_jobs', sa.Column('kind', sa.String(8), nullable=False, server_default='price'))
    # Only create these new tables; do not use metadata.create_all for historical tables.
    from alerts.storage import VolumeBackfillJob, VolumeBackfillSegment
    VolumeBackfillJob.__table__.create(op.get_bind())
    VolumeBackfillSegment.__table__.create(op.get_bind())


def downgrade():
    op.drop_table('volume_backfill_segments')
    op.drop_table('volume_backfill_jobs')
    op.drop_column('chart_aggregation_jobs', 'kind')
    for name in ('volume', 'volume_complete', 'volume_received_at', 'volume_revision', 'observed_at'):
        op.drop_column('candles', name)
