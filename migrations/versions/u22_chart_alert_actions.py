"""Fence lifecycle transitions and retain committed request identities."""

from alembic import op
from alerts.storage import ChartAlertAction
from sqlalchemy import Column, Integer, inspect, text

revision = "u22_chart_alert_actions"
down_revision = "t21_merge_alerts_mcp"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if "control_revision" not in {c["name"] for c in inspect(bind).get_columns("chart_alerts")}:
        op.add_column("chart_alerts", Column("control_revision", Integer(), nullable=False, server_default="1"))
    ChartAlertAction.__table__.create(bind, checkfirst=True)


def downgrade():
    bind = op.get_bind()
    if bind.execute(text("SELECT count(*) FROM chart_alerts")).scalar():
        raise RuntimeError("Chart alerts exist; restore the verified pre-migration backup")
    if bind.execute(text("SELECT count(*) FROM chart_alert_actions")).scalar():
        raise RuntimeError("Lifecycle request evidence exists; restore a verified pre-migration backup")
    if bind.execute(text("SELECT count(*) FROM (SELECT watch_id FROM signals "
                         "GROUP BY watch_id HAVING count(*) > 1) AS duplicates")).scalar():
        raise RuntimeError("Multiple events exist; restore the verified pre-migration backup")
    op.drop_table("chart_alert_actions")
    with op.batch_alter_table("chart_alerts") as batch:
        batch.drop_column("control_revision")
