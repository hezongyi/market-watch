"""Record real history task mutation times without inventing legacy events."""

import sqlalchemy as sa
from alembic import op

revision = "al39_history_task_activity"
down_revision = "ak38_composite_watch_bindings"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    for table in ("market_history_versions", "market_history_runs", "market_history_artifacts"):
        # Earlier migrations create tables from current ORM metadata. Fresh
        # installations can therefore already contain this nullable column.
        if "updated_at" not in {column["name"] for column in sa.inspect(bind).get_columns(table)}:
            op.add_column(table, sa.Column("updated_at", sa.BigInteger(), nullable=True))


def downgrade():
    for table in ("market_history_artifacts", "market_history_runs", "market_history_versions"):
        op.drop_column(table, "updated_at")
