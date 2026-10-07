"""Immutable per-timeframe artifacts retain their fixed M1 parent identity."""

from alembic import op
from alerts.storage import HistoryArtifact, HistoryArtifactBlock
from sqlalchemy import text

revision = "ab29_history_artifacts"
down_revision = "aa28_history_maintenance"
branch_labels = None
depends_on = None


def upgrade():
    for model in (HistoryArtifact, HistoryArtifactBlock):
        model.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    if op.get_bind().scalar(text("SELECT COUNT(*) FROM market_history_artifacts")):
        raise RuntimeError("Historical artifacts exist; restore the verified pre-migration backup")
    op.drop_table("market_history_artifact_blocks")
    op.drop_table("market_history_artifacts")
