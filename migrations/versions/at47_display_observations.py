"""Retain accepted price observations and exact shared display snapshots."""

import sqlalchemy as sa
from alembic import op

revision = 'at47_display_observations'
down_revision = 'as46_provider_price_confirmation'
branch_labels = None
depends_on = None


def upgrade():
    if not sa.inspect(op.get_bind()).has_table('market_observed_minutes'):
        op.create_table('market_observed_minutes',
            sa.Column('dataset_id', sa.String(64), sa.ForeignKey('market_datasets.id'), primary_key=True),
            sa.Column('start', sa.BigInteger(), primary_key=True),
            sa.Column('epoch', sa.BigInteger(), primary_key=True),
            sa.Column('content', sa.JSON(), nullable=False),
            sa.Column('observed_at', sa.BigInteger(), nullable=False),
            sa.Column('sequence', sa.BigInteger(), nullable=False))
    if not sa.inspect(op.get_bind()).has_table('market_display_snapshots'):
        op.create_table('market_display_snapshots',
            sa.Column('id', sa.String(64), primary_key=True),
            sa.Column('revision_id', sa.String(36), sa.ForeignKey('market_composite_revisions.id'), nullable=False),
            sa.Column('timeframe', sa.String(4), nullable=False),
            sa.Column('input_revision', sa.BigInteger(), nullable=False),
            sa.Column('content', sa.JSON(), nullable=False),
            sa.Column('expires_at', sa.BigInteger(), nullable=False),
            sa.Column('size_bytes', sa.BigInteger(), nullable=False))
        op.create_index('ix_market_display_snapshots_revision_id', 'market_display_snapshots', ['revision_id'])
        op.create_index('ix_market_display_snapshots_expires_at', 'market_display_snapshots', ['expires_at'])


def downgrade():
    for name in ('market_display_snapshots', 'market_observed_minutes'):
        if sa.inspect(op.get_bind()).has_table(name):
            if op.get_bind().scalar(sa.text(f'SELECT count(*) FROM {name}')):
                raise RuntimeError('Display observations require a verified backup before downgrade')
    op.drop_table('market_display_snapshots')
    op.drop_table('market_observed_minutes')
