"""Shared bounded display replay beyond the synchronous chart work budget."""

import sqlalchemy as sa
from alembic import op

revision = 'au48_display_indicator_tasks'
down_revision = 'at47_display_observations'
branch_labels = None
depends_on = None


def upgrade():
    if sa.inspect(op.get_bind()).has_table('market_display_indicator_tasks'):
        return
    op.create_table('market_display_indicator_tasks',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('snapshot_id', sa.String(64), sa.ForeignKey('market_display_snapshots.id', ondelete='CASCADE'), nullable=False),
        sa.Column('run_id', sa.String(64), sa.ForeignKey('market_fixed_indicator_runs.id', ondelete='CASCADE'), nullable=False),
        sa.Column('affected', sa.BigInteger(), nullable=False),
        sa.Column('cursor', sa.BigInteger(), nullable=False),
        sa.Column('end', sa.BigInteger(), nullable=False),
        sa.Column('state', sa.JSON(), nullable=False),
        sa.Column('dependent', sa.Boolean(), nullable=False),
        sa.Column('output', sa.LargeBinary(), nullable=False),
        sa.Column('presentation', sa.JSON()),
        sa.Column('status', sa.String(16), nullable=False),
        sa.Column('lease_token', sa.String(36)),
        sa.Column('lease_until', sa.BigInteger(), nullable=False),
        sa.Column('next_at', sa.BigInteger(), nullable=False),
        sa.Column('error', sa.String(64)))
    op.create_index('ix_market_display_indicator_tasks_snapshot_id', 'market_display_indicator_tasks', ['snapshot_id'])
    op.create_index('ix_market_display_indicator_tasks_status', 'market_display_indicator_tasks', ['status'])


def downgrade():
    if op.get_bind().scalar(sa.text('SELECT count(*) FROM market_display_indicator_tasks')):
        raise RuntimeError('Display task data requires a verified backup before downgrade')
    op.drop_table('market_display_indicator_tasks')
