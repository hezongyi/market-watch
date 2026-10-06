"""Versioned chart alerts and per-event signal identity; preserve old evidence."""
from alembic import op
from alerts.storage import ChartAlert, ChartAlertVersion
from sqlalchemy import Column, ForeignKey, String, inspect, text

revision = "s20_chart_alerts"
down_revision = "r19_native_history_loads"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    ChartAlert.__table__.create(bind, checkfirst=True)
    ChartAlertVersion.__table__.create(bind, checkfirst=True)
    constraints = inspect(bind).get_unique_constraints("signals")
    with op.batch_alter_table("signals", naming_convention={
        "uq": "uq_%(table_name)s_%(column_0_name)s",
    }) as batch:
        for constraint in constraints:
            if constraint["column_names"] == ["watch_id"]:
                batch.drop_constraint(constraint["name"] or "uq_signals_watch_id", type_="unique")
        batch.alter_column("watch_id", existing_type=String(36), nullable=True)
        batch.add_column(Column("chart_alert_id", String(36),
                                ForeignKey("chart_alerts.id", name="fk_signals_chart_alert")))
        batch.add_column(Column("event_key", String(100), nullable=True))
    # Historical signal ids are stable and keep every notification FK intact.
    bind.execute(text("UPDATE signals SET event_key = id"))
    with op.batch_alter_table("signals") as batch:
        batch.alter_column("event_key", existing_type=String(100), nullable=False)
        batch.create_unique_constraint("uq_signals_event_key", ["event_key"])
        batch.create_index("ix_signals_chart_alert_id", ["chart_alert_id"])
        batch.create_index("ix_signals_watch_id", ["watch_id"])


def downgrade():
    bind = op.get_bind()
    if bind.execute(text("SELECT count(*) FROM chart_alerts")).scalar():
        raise RuntimeError("Chart alerts exist; restore the verified pre-migration backup")
    if bind.execute(text("SELECT count(*) FROM (SELECT watch_id FROM signals "
                         "GROUP BY watch_id HAVING count(*) > 1) AS duplicates")).scalar():
        raise RuntimeError("Multiple events exist; restore the verified pre-migration backup")
    with op.batch_alter_table("signals") as batch:
        batch.drop_index("ix_signals_chart_alert_id")
        batch.drop_index("ix_signals_watch_id")
        batch.drop_constraint("uq_signals_event_key", type_="unique")
        batch.drop_constraint("fk_signals_chart_alert", type_="foreignkey")
        batch.drop_column("event_key")
        batch.drop_column("chart_alert_id")
        batch.alter_column("watch_id", existing_type=String(36), nullable=False)
        batch.create_unique_constraint("uq_signals_watch_id", ["watch_id"])
    op.drop_table("chart_alert_versions")
    op.drop_table("chart_alerts")
