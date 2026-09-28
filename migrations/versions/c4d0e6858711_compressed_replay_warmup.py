"""Keep full replay warmup without expanding each browser/step response."""

from alembic import op
import sqlalchemy as sa

revision = "c4d0e6858711"
down_revision = "b9a47ce41120"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("replays", sa.Column("warmup_snapshot", sa.LargeBinary(), nullable=True))
    op.add_column("replays", sa.Column("warmup_count", sa.Integer(), nullable=False, server_default="0"))


def downgrade():
    op.drop_column("replays", "warmup_count")
    op.drop_column("replays", "warmup_snapshot")
