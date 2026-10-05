"""Persistent cancellable native history demands; existing caches are unchanged."""
from alembic import op
from alerts.storage import NativeHistoryLoad

revision = "r19_native_history_loads"
down_revision = "q18_yahoo_catalog"
branch_labels = None
depends_on = None


def upgrade():
    NativeHistoryLoad.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    op.drop_table("native_history_loads")
