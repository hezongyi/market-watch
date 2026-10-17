"""Additive unified notification center projection tables (Issue #75)."""

from alembic import op
from alerts.storage import (
    NotificationChange,
    NotificationEvent,
    NotificationIncident,
    NotificationObservation,
    NotificationSourceClaim,
    NotificationStream,
)

revision = "ba50_notification_center"
down_revision = "av49_indicator_demands"
branch_labels = None
depends_on = None

TABLES = [NotificationStream, NotificationIncident, NotificationEvent,
          NotificationChange, NotificationObservation, NotificationSourceClaim]


def upgrade():
    bind = op.get_bind()
    for table in TABLES:
        table.__table__.create(bind, checkfirst=True)


def downgrade():
    # New tables only. Legacy notifications/outbox/receipts are untouched, so
    # rolling the application back keeps every existing delivery fact intact.
    for table in reversed(TABLES):
        table.__table__.drop(bind=op.get_bind(), checkfirst=True)
