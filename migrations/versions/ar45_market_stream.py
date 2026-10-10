"""Durable shared market results and session-owned consumers."""

from alembic import op
from alerts.storage import (
    MarketStreamClient,
    MarketStreamResult,
    MarketStreamSubscription,
    MarketStreamTask,
)

revision = "ar45_market_stream"
down_revision = "aq44_aggregation_service_order"
branch_labels = None
depends_on = None


def upgrade():
    for model in (MarketStreamClient, MarketStreamTask, MarketStreamSubscription, MarketStreamResult):
        model.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    for model in (MarketStreamResult, MarketStreamSubscription, MarketStreamTask, MarketStreamClient):
        model.__table__.drop(op.get_bind(), checkfirst=True)
