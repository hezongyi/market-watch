"""Allow system and explicitly requested test messages in the shared Outbox."""

import sqlalchemy as sa
from alembic import op

revision = "az53_notification_outbox_types"
down_revision = "ay52_history_modes"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    columns = {column["name"]: column for column in sa.inspect(bind).get_columns("notifications")}
    with op.batch_alter_table("notifications") as batch:
        signal_id = columns.get("signal_id")
        if signal_id and not signal_id["nullable"]:
            batch.alter_column("signal_id", existing_type=sa.String(length=36), nullable=True)
        if "kind" not in columns:
            batch.add_column(sa.Column(
                "kind", sa.String(length=16), server_default="signal", nullable=False))
        if "payload" not in columns:
            batch.add_column(sa.Column(
                "payload", sa.JSON(), server_default="{}", nullable=False))


def downgrade():
    raise RuntimeError(
        "Notification runtime schema is forward-only; roll back the application and restore "
        "the pre-migration backup"
    )
