"""Independent persistent native-period provider cache."""

import sqlalchemy as sa
from alembic import op

revision = "m14_provider_cache"
down_revision = "l13_managed_publication"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "provider_datasets",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("symbol", sa.String(64), nullable=False),
        sa.Column("timeframe", sa.String(8), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("coverage", sa.JSON(), nullable=False),
        sa.Column("earliest", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column("latest_at", sa.BigInteger(), nullable=False),
        sa.Column("accessed_at", sa.BigInteger(), nullable=False),
        sa.Column("lease_token", sa.String(36)),
        sa.Column("lease_until", sa.BigInteger(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
    )
    op.create_index("ix_provider_datasets_accessed_at", "provider_datasets", ["accessed_at"])
    op.create_table(
        "provider_bars",
        sa.Column(
            "dataset_id", sa.String(64), sa.ForeignKey("provider_datasets.id"), primary_key=True
        ),
        sa.Column("start", sa.BigInteger(), primary_key=True),
        sa.Column("chart_time", sa.BigInteger(), nullable=False),
        sa.Column("complete", sa.Boolean(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("observed_at", sa.BigInteger(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
    )
    op.create_index("ix_provider_bars_range", "provider_bars", ["dataset_id", "chart_time"])
    op.create_table(
        "provider_interests",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("client", sa.String(64), nullable=False),
        sa.Column("listener", sa.String(100), nullable=False),
        sa.Column(
            "dataset_id", sa.String(64), sa.ForeignKey("provider_datasets.id"), nullable=False
        ),
        sa.Column("subscribed", sa.Boolean(), nullable=False),
        sa.Column("expires", sa.BigInteger(), nullable=False),
        sa.Column("accessed_at", sa.BigInteger(), nullable=False),
        sa.Column("targets", sa.JSON(), nullable=False),
        sa.Column("indicators", sa.JSON(), nullable=False),
        sa.Column("cursor", sa.BigInteger(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("next_poll", sa.BigInteger(), nullable=False),
        sa.Column("error", sa.String(200)),
    )
    for field in ("client", "dataset_id", "expires"):
        op.create_index("ix_provider_interests_" + field, "provider_interests", [field])


def downgrade():
    op.drop_table("provider_interests")
    op.drop_table("provider_bars")
    op.drop_table("provider_datasets")
