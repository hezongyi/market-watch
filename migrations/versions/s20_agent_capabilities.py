"""Scoped agent credentials and atomic idempotent operations."""

from alembic import op
from alerts.storage import AgentCredential, AgentOperation

revision = "s20_agent_capabilities"
down_revision = "r19_native_history_loads"
branch_labels = None
depends_on = None


def upgrade():
    AgentCredential.__table__.create(op.get_bind(), checkfirst=True)
    AgentOperation.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    op.drop_table("agent_operations")
    op.drop_table("agent_credentials")
