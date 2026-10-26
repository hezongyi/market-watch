"""Add independent native-period bindings and checkpoints, retaining all M1 bytes."""

import sqlalchemy as sa
from alembic import op

revision = "ay52_history_modes"
down_revision = "ax51_mapping_notes"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    for table in ("market_history_chunks", "market_history_read_attempts"):
        if "timeframe" not in {c["name"] for c in sa.inspect(bind).get_columns(table)}:
            op.add_column(table, sa.Column("timeframe", sa.String(4), nullable=False,
                                          server_default="M1"))
    chunks = "market_history_chunks"
    constraints = sa.inspect(bind).get_unique_constraints(chunks)
    old = next((c for c in constraints if c["column_names"] == ["version_id", "start"]), None)
    new = any(c["column_names"] == ["version_id", "timeframe", "start"] for c in constraints)
    if old or not new:
        naming = {"uq": "uq_%(table_name)s_%(column_0_name)s_%(column_1_name)s"}
        with op.batch_alter_table(chunks, naming_convention=naming) as batch:
            if old:
                batch.drop_constraint(old["name"] or "uq_market_history_chunks_version_id_start",
                                      type_="unique")
            if not new:
                batch.create_unique_constraint("uq_history_chunk_version_frame_start",
                                               ["version_id", "timeframe", "start"])
    if "frame_plan" not in {c["name"] for c in sa.inspect(bind).get_columns("market_dataset_maintenance")}:
        op.add_column("market_dataset_maintenance",
                      sa.Column("frame_plan", sa.JSON(), nullable=False, server_default="{}"))
    if not sa.inspect(bind).has_table("market_dataset_frame_sources"):
        op.create_table("market_dataset_frame_sources",
            sa.Column("dataset_id", sa.String(64), sa.ForeignKey("market_datasets.id"), primary_key=True),
            sa.Column("timeframe", sa.String(4), primary_key=True),
            sa.Column("source_id", sa.String(64), sa.ForeignKey("market_source_series.id"), nullable=False))
        op.create_index("ix_market_dataset_frame_sources_source_id", "market_dataset_frame_sources", ["source_id"])
    if not sa.inspect(bind).has_table("market_history_frame_runs"):
        op.create_table("market_history_frame_runs",
            sa.Column("version_id", sa.String(36), sa.ForeignKey("market_history_versions.id"), primary_key=True),
            sa.Column("timeframe", sa.String(4), primary_key=True),
            sa.Column("source_id", sa.String(64), sa.ForeignKey("market_source_series.id"), nullable=False),
            sa.Column("start", sa.BigInteger(), nullable=False),
            sa.Column("end", sa.BigInteger(), nullable=False),
            sa.Column("cursor", sa.BigInteger(), nullable=False),
            sa.Column("status", sa.String(20), nullable=False),
            sa.Column("attempts", sa.Integer(), nullable=False),
            sa.Column("retry_at", sa.BigInteger(), nullable=False),
            sa.Column("observed_at", sa.BigInteger()),
            sa.Column("last_success", sa.BigInteger()),
            sa.Column("inherited_version_id", sa.String(36), sa.ForeignKey("market_history_versions.id")),
            sa.Column("error", sa.String(40)),
            sa.Column("facts", sa.JSON(), nullable=False))


def downgrade():
    raise RuntimeError("Retain archived periods and M1 data: roll back the application; "
                       "use a verified pre-migration backup for schema rollback")
