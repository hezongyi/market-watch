"""Join market-data integration with chart alerts and native MCP.

Both previously deployed heads remain valid upgrade starting points.
"""

revision = "w24_merge_market_data"
down_revision = ("v23_live_pricing", "u22_chart_alert_actions")
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
