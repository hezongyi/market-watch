"""Join independent chart-alert and native MCP upgrade paths without rewriting either."""

from alembic import op
from sqlalchemy import text

revision = "t21_merge_alerts_mcp"
down_revision = ("s20_chart_alerts", "s20_agent_capabilities")
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    # Fail before Alembic splits the joined head, including on SQLite where DDL
    # may not roll back. Keep the existing chart migration's backup requirement.
    bind = op.get_bind()
    if bind.execute(text("SELECT count(*) FROM chart_alerts")).scalar():
        raise RuntimeError("Chart alerts exist; restore the verified pre-migration backup")
    if bind.execute(text("SELECT count(*) FROM (SELECT watch_id FROM signals "
                         "GROUP BY watch_id HAVING count(*) > 1) AS duplicates")).scalar():
        raise RuntimeError("Multiple events exist; restore the verified pre-migration backup")
