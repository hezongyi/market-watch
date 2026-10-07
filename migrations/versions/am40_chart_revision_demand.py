"""Bind chart leases to the composite revision actually read."""

import sqlalchemy as sa
from alembic import op

revision = "am40_chart_revision_demand"
down_revision = "al39_history_task_activity"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    # Earlier migrations use current ORM metadata on fresh installations.
    if "composite_revision_id" not in {c["name"] for c in sa.inspect(bind).get_columns("market_data_demand")}:
        with op.batch_alter_table("market_data_demand") as batch:
            batch.add_column(sa.Column("composite_revision_id", sa.String(36), nullable=True))
            batch.create_foreign_key("fk_market_demand_composite_revision", "market_composite_revisions",
                                     ["composite_revision_id"], ["id"])
            batch.create_index("ix_market_data_demand_composite_revision_id", ["composite_revision_id"])


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM market_data_demand WHERE composite_revision_id IS NOT NULL")):
        raise RuntimeError("Revision-bound chart leases exist; restore a verified backup")
    with op.batch_alter_table("market_data_demand") as batch:
        batch.drop_index("ix_market_data_demand_composite_revision_id")
        batch.drop_constraint("fk_market_demand_composite_revision", type_="foreignkey")
        batch.drop_column("composite_revision_id")
