"""Explicit historical start, persistent maintenance and per-period publication."""
import sqlalchemy as sa
from alembic import op

revision = 'l13_managed_publication'
down_revision = 'k12_chart_aggregation'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('chart_history_plans', sa.Column('cursor', sa.BigInteger(), nullable=True))
    op.add_column('chart_history_plans', sa.Column('realtime_enabled', sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column('chart_history_plans', sa.Column('realtime_end', sa.BigInteger(), nullable=False, server_default='0'))
    op.execute('UPDATE chart_history_plans SET cursor = target_end')
    op.create_table('chart_publications',
        sa.Column('instrument_id', sa.String(40), sa.ForeignKey('instruments.id'), primary_key=True),
        sa.Column('timeframe', sa.String(8), primary_key=True),
        sa.Column('start', sa.BigInteger(), nullable=False),
        sa.Column('end', sa.BigInteger(), nullable=False),
        sa.Column('complete_count', sa.Integer(), nullable=False),
        sa.Column('revision', sa.Integer(), nullable=False),
        sa.Column('initialized', sa.Boolean(), nullable=False),
        sa.Column('updated_at', sa.BigInteger(), nullable=False))
    op.create_table('chart_published_bars',
        sa.Column('instrument_id', sa.String(40), sa.ForeignKey('instruments.id'), primary_key=True),
        sa.Column('timeframe', sa.String(8), primary_key=True),
        sa.Column('start', sa.BigInteger(), primary_key=True),
        sa.Column('end', sa.BigInteger(), nullable=False),
        sa.Column('complete', sa.Boolean(), nullable=False),
        sa.Column('payload', sa.JSON(), nullable=False))


def downgrade():
    op.drop_table('chart_published_bars')
    op.drop_table('chart_publications')
    op.drop_column('chart_history_plans', 'realtime_end')
    op.drop_column('chart_history_plans', 'realtime_enabled')
    op.drop_column('chart_history_plans', 'cursor')
