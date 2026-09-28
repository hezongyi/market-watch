"""Explicit instrument closures and immutable replay calendar snapshots."""

from alembic import op
import sqlalchemy as sa

revision = "b9a47ce41120"
down_revision = "971dbb57af10"
branch_labels = None
depends_on = None


def upgrade():
    for table in ("instruments", "replays"):
        op.add_column(table, sa.Column("calendar_profile", sa.JSON(), nullable=False, server_default="{}"))


def downgrade():
    for table in ("replays", "instruments"):
        op.drop_column(table, "calendar_profile")
