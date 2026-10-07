"""Separate managed daily schedules from realtime demand and version tasks."""

from alembic import op
from alerts.storage import DatasetMaintenance, HistoryRun
from sqlalchemy import text

revision = "aa28_history_maintenance"
down_revision = "z27_source_m1_store"
branch_labels = None
depends_on = None


def upgrade():
    for model in (DatasetMaintenance, HistoryRun):
        model.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    if op.get_bind().scalar(text("SELECT COUNT(*) FROM market_dataset_maintenance")):
        raise RuntimeError("Managed schedules exist; restore the verified pre-migration backup")
    op.drop_table("market_history_runs")
    op.drop_table("market_dataset_maintenance")
