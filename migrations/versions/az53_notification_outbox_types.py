"""Allow system and explicitly requested test messages in the shared Outbox."""

import sqlalchemy as sa
from alembic import op

revision = "az53_notification_outbox_types"
down_revision = "ay52_history_modes"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("notifications", "signal_id", existing_type=sa.String(length=36),
                    nullable=True)
    op.add_column("notifications", sa.Column(
        "kind", sa.String(length=16), server_default="signal", nullable=False))
    op.add_column("notifications", sa.Column(
        "payload", sa.JSON(), server_default="{}", nullable=False))


def downgrade():
    raise RuntimeError(
        "Notification runtime schema is forward-only; roll back the application and restore "
        "the pre-migration backup"
    )
