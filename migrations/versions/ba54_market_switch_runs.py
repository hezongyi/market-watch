"""Persist switch runs; only a succeeded row unlocks the 30-day cleanup."""

from alembic import op
from alerts.storage import MarketSwitchRun
from sqlalchemy import text

revision = "ba54_market_switch_runs"
down_revision = "az53_notification_outbox_types"
branch_labels = None
depends_on = None


def upgrade():
    MarketSwitchRun.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    if op.get_bind().scalar(text("SELECT COUNT(*) FROM market_switch_runs")):
        raise RuntimeError("切换运行记录存在；请恢复迁移前的备份")
    op.drop_table("market_switch_runs")
