"""Keep aggregation target turns independent of the size and age of a backlog."""

import sqlalchemy as sa
from alembic import op

revision = 'aq44_aggregation_service_order'
down_revision = 'ap43_publication_service_order'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if not sa.inspect(bind).has_table('chart_aggregation_state'):
        op.create_table('chart_aggregation_state',
            sa.Column('instrument_id', sa.String(40), sa.ForeignKey('instruments.id'), primary_key=True),
            sa.Column('timeframe', sa.String(8), primary_key=True),
            sa.Column('last_service_seq', sa.BigInteger(), nullable=False, server_default='0'))
    if bind.dialect.name == 'postgresql':
        sa.Sequence('chart_aggregation_service_seq').create(bind, checkfirst=True)
    indexes = {row['name'] for row in sa.inspect(bind).get_indexes('chart_aggregation_jobs')}
    if 'ix_aggregation_jobs_ready' not in indexes:
        op.create_index('ix_aggregation_jobs_ready', 'chart_aggregation_jobs',
                        ['next_at', 'instrument_id', 'timeframe'])


def downgrade():
    op.drop_index('ix_aggregation_jobs_ready', table_name='chart_aggregation_jobs')
    op.drop_table('chart_aggregation_state')
    if op.get_bind().dialect.name == 'postgresql':
        sa.Sequence('chart_aggregation_service_seq').drop(op.get_bind(), checkfirst=True)
