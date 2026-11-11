"""Keep notice-source polling independent of unrelated audit history size."""

import sqlalchemy as sa
from alembic import op

revision = 'bd57_notice_source_poll_index'
down_revision = 'bc56_price_alert_inputs'
branch_labels = None
depends_on = None


def upgrade():
    op.create_index('ix_audit_events_notice_source_id', 'audit_events', ['id'],
        postgresql_where=sa.text("kind = 'notice_source'"),
        sqlite_where=sa.text("kind = 'notice_source'"), if_not_exists=True)


def downgrade():
    op.drop_index('ix_audit_events_notice_source_id', table_name='audit_events', if_exists=True)
