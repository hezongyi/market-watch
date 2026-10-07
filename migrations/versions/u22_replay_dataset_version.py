"""Pin historical replays to immutable source versions and content manifests."""

import sqlalchemy as sa
from alembic import op

revision = "u22_replay_dataset_version"
down_revision = "t21_history_snapshots"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("replays", sa.Column("dataset_version", sa.String(36)))
    op.add_column("replays", sa.Column("input_manifest", sa.JSON(), nullable=False, server_default="{}"))


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM replays WHERE dataset_version IS NOT NULL")):
        raise RuntimeError("Restore backup before discarding pinned replay manifests")
    op.drop_column("replays", "input_manifest")
    op.drop_column("replays", "dataset_version")
