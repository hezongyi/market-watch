"""Additive professional-chart notification projections and durable browser intake.

Rollback the application while retaining these tables and the av49 demand tables.
"""
import secrets
import uuid

import sqlalchemy as sa
from alembic import op

revision = "aw50_notice_center"
down_revision = "av49_indicator_demands"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('notice_streams',
        sa.Column('subject', sa.String(length=80), nullable=False, primary_key=True),
        sa.Column('epoch', sa.String(length=36), nullable=False, primary_key=False),
        sa.Column('seq', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('floor', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('started_at', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('cursor_secret', sa.String(length=64), nullable=False, primary_key=False),
    )
    op.create_table('notice_incidents',
        sa.Column('id', sa.String(length=36), nullable=False, primary_key=True),
        sa.Column('subject', sa.String(length=80), nullable=False, primary_key=False),
        sa.Column('dedupe_key', sa.String(length=64), nullable=False, primary_key=False),
        sa.Column('first_at', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('last_at', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('closed_at', sa.BigInteger(), nullable=True, primary_key=False),
        sa.Column('count', sa.Integer(), nullable=False, primary_key=False),
        sa.Column('severity', sa.Integer(), nullable=False, primary_key=False),
        sa.Column('source_version', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('last_event_id', sa.String(length=80), nullable=False, primary_key=False),
    )
    op.create_index('ix_notice_incident_open', 'notice_incidents', ['subject', 'dedupe_key', 'closed_at'], unique=False)
    op.create_index('ix_notice_incidents_subject', 'notice_incidents', ['subject'], unique=False)
    op.create_table('notice_events',
        sa.Column('id', sa.String(length=80), nullable=False, primary_key=True),
        sa.Column('subject', sa.String(length=80), nullable=False, primary_key=False),
        sa.Column('source_domain', sa.String(length=20), nullable=False, primary_key=False),
        sa.Column('source_kind', sa.String(length=40), nullable=False, primary_key=False),
        sa.Column('source_id', sa.String(length=100), nullable=False, primary_key=False),
        sa.Column('incident_id', sa.String(length=36), nullable=False, primary_key=False),
        sa.Column('occurred_at', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('recorded_at', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('first_seq', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('version', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('severity', sa.String(length=12), nullable=False, primary_key=False),
        sa.Column('kind', sa.String(length=32), nullable=False, primary_key=False),
        sa.Column('workspace', sa.String(length=80), nullable=False, primary_key=False),
        sa.Column('instrument', sa.String(length=120), nullable=False, primary_key=False),
        sa.Column('viewed_at', sa.BigInteger(), nullable=True, primary_key=False),
        sa.Column('handled_at', sa.BigInteger(), nullable=True, primary_key=False),
        sa.Column('attention', sa.Boolean(), nullable=False, primary_key=False),
        sa.Column('backfill', sa.Boolean(), nullable=False, primary_key=False),
        sa.Column('body', sa.JSON(), nullable=False, primary_key=False),
        sa.Column('intake_hash', sa.String(length=64), nullable=True, primary_key=False),
    )
    op.create_index('ix_notice_events_incident_id', 'notice_events', ['incident_id'], unique=False)
    op.create_index('ix_notice_events_instrument', 'notice_events', ['instrument'], unique=False)
    op.create_index('ix_notice_events_kind', 'notice_events', ['kind'], unique=False)
    op.create_index('ix_notice_events_severity', 'notice_events', ['severity'], unique=False)
    op.create_index('ix_notice_events_source_domain', 'notice_events', ['source_domain'], unique=False)
    op.create_index('ix_notice_events_subject', 'notice_events', ['subject'], unique=False)
    op.create_index('ix_notice_events_workspace', 'notice_events', ['workspace'], unique=False)
    op.create_index('ix_notice_history', 'notice_events', ['subject', 'occurred_at', 'id'], unique=False)
    op.create_index('ix_notice_source', 'notice_events', ['subject', 'source_kind', 'source_id'], unique=False)
    op.create_table('notice_changes',
        sa.Column('subject', sa.String(length=80), nullable=False, primary_key=True),
        sa.Column('seq', sa.BigInteger(), nullable=False, primary_key=True),
        sa.Column('event_id', sa.String(length=80), nullable=False, primary_key=False),
        sa.Column('at', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('kind', sa.String(length=20), nullable=False, primary_key=False),
        sa.Column('body', sa.JSON(), nullable=False, primary_key=False),
    )
    op.create_index('ix_notice_changes_at', 'notice_changes', ['at'], unique=False)
    op.create_index('ix_notice_changes_event_id', 'notice_changes', ['event_id'], unique=False)
    op.create_table('notice_source_receipts',
        sa.Column('source_key', sa.String(length=100), nullable=False, primary_key=True),
        sa.Column('event_id', sa.String(length=80), nullable=True, primary_key=False),
        sa.Column('at', sa.BigInteger(), nullable=False, primary_key=False),
    )
    op.create_table('notice_observations',
        sa.Column('id', sa.String(length=100), nullable=False, primary_key=True),
        sa.Column('event_id', sa.String(length=80), nullable=False, primary_key=False),
        sa.Column('subject', sa.String(length=80), nullable=False, primary_key=False),
        sa.Column('profile', sa.String(length=80), nullable=False, primary_key=False),
        sa.Column('kind', sa.String(length=24), nullable=False, primary_key=False),
        sa.Column('reported_at', sa.BigInteger(), nullable=True, primary_key=False),
        sa.Column('at', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('details', sa.JSON(), nullable=False, primary_key=False),
        sa.Column('intent_hash', sa.String(length=64), nullable=False, primary_key=False),
    )
    op.create_index('ix_notice_observation_timeline', 'notice_observations', ['event_id', 'at', 'id'], unique=False)
    op.create_table('notice_intakes',
        sa.Column('id', sa.String(length=80), nullable=False, primary_key=True),
        sa.Column('subject', sa.String(length=80), nullable=False, primary_key=False),
        sa.Column('profile', sa.String(length=80), nullable=False, primary_key=False),
        sa.Column('at', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('intent_hash', sa.String(length=64), nullable=False, primary_key=False),
        sa.Column('body', sa.JSON(), nullable=False, primary_key=False),
    )
    op.create_index('ix_notice_intakes_at', 'notice_intakes', ['at'], unique=False)
    op.create_index('ix_notice_intakes_subject', 'notice_intakes', ['subject'], unique=False)
    op.create_table('notice_intake_budgets',
        sa.Column('subject', sa.String(length=80), nullable=False, primary_key=True),
        sa.Column('at', sa.BigInteger(), nullable=False, primary_key=False),
        sa.Column('tokens', sa.Double(), nullable=False, primary_key=False),
    )
    stream = sa.table('notice_streams', sa.column('subject'), sa.column('epoch'),
        sa.column('seq'), sa.column('floor'), sa.column('started_at'), sa.column('cursor_secret'))
    import time
    op.bulk_insert(stream, [{'subject': 'admin', 'epoch': str(uuid.uuid4()), 'seq': 0,
        'floor': 0, 'started_at': int(time.time() * 1000), 'cursor_secret': secrets.token_hex(32)}])


def downgrade():
    raise RuntimeError('Keep notice source and projection data; roll back the application instead')
