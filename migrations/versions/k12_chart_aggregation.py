"""Durable bounded selected-period aggregation work."""
import sqlalchemy as sa
from alembic import op

revision = 'k12_chart_aggregation'
down_revision = 'j11_chart_history_plans'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('chart_aggregation_jobs',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('instrument_id', sa.String(40), sa.ForeignKey('instruments.id'), nullable=False),
        sa.Column('timeframe', sa.String(8), nullable=False),
        sa.Column('start', sa.BigInteger(), nullable=False),
        sa.Column('end', sa.BigInteger(), nullable=False),
        sa.Column('created_at', sa.BigInteger(), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False),
        sa.Column('next_at', sa.BigInteger(), nullable=False),
        sa.Column('error', sa.String(200), nullable=True),
        sa.UniqueConstraint('instrument_id', 'timeframe', 'start', 'end'))


def downgrade():
    op.drop_table('chart_aggregation_jobs')
