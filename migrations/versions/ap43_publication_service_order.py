"""Separate durable publication order from wall-clock observation timestamps."""

import sqlalchemy as sa
from alembic import op

revision = 'ap43_publication_service_order'
down_revision = 'ao42_coverage_projection'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    columns = {col['name'] for col in sa.inspect(bind).get_columns('chart_publication_state')}
    if 'last_service_seq' not in columns:
        op.add_column('chart_publication_state', sa.Column(
            'last_service_seq', sa.BigInteger(), nullable=False, server_default='0'))
    if bind.dialect.name == 'postgresql':
        sa.Sequence('chart_publication_service_seq').create(bind, checkfirst=True)
    op.drop_index('ix_publication_state_ready', table_name='chart_publication_state')
    op.create_index('ix_publication_state_ready', 'chart_publication_state', ['next_at', 'last_service_seq'])


def downgrade():
    op.drop_index('ix_publication_state_ready', table_name='chart_publication_state')
    op.create_index('ix_publication_state_ready', 'chart_publication_state', ['next_at', 'served_at'])
    op.drop_column('chart_publication_state', 'last_service_seq')
    if op.get_bind().dialect.name == 'postgresql':
        sa.Sequence('chart_publication_service_seq').drop(op.get_bind(), checkfirst=True)
