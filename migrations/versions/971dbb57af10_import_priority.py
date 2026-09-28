"""Prioritize repair and manually requested history over initial backfill."""

from alembic import op
import sqlalchemy as sa

revision = "971dbb57af10"
down_revision = "878ba03c3c44"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("import_jobs", sa.Column("priority", sa.Integer(), nullable=False, server_default="10"))


def downgrade():
    op.drop_column("import_jobs", "priority")
