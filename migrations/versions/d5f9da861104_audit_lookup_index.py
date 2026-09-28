"""Index recurring health, login throttle and source audit lookups."""

from alembic import op

revision = "d5f9da861104"
down_revision = "c4d0e6858711"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_audit_events_kind_at", "audit_events", ["kind", "at"])


def downgrade():
    op.drop_index("ix_audit_events_kind_at", table_name="audit_events")
