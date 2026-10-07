"""Add restartable managed publication requests after the three-layer release."""

import sqlalchemy as sa
from alembic import op

revision = "an41_publication_state"
down_revision = "am40_chart_revision_demand"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("chart_publication_state"):
        op.create_table("chart_publication_state",
            sa.Column("instrument_id", sa.String(40), sa.ForeignKey("instruments.id"), primary_key=True),
            sa.Column("timeframe", sa.String(8), primary_key=True),
            sa.Column("requested", sa.BigInteger(), nullable=False, server_default="1"),
            sa.Column("processed", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("reasons", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("requested_at", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("served_at", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("next_at", sa.BigInteger(), nullable=True),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("blocked_reason", sa.String(40), nullable=True))
        op.create_index("ix_publication_state_ready", "chart_publication_state", ["next_at", "served_at"])
    # Existing visible snapshots and approved plans are initialized once, without
    # mutating three-layer history/composite identities or any reader snapshot.
    op.execute(sa.text('''INSERT INTO chart_publication_state
        (instrument_id,timeframe,requested,processed,reasons,requested_at,served_at,next_at,attempts)
        SELECT t.instrument_id,f.frame,1,0,1,0,0,0,0 FROM
        (SELECT instrument_id FROM chart_history_plans UNION SELECT instrument_id FROM chart_publications) t
        CROSS JOIN (SELECT 'M1' AS frame UNION ALL SELECT 'M5' UNION ALL SELECT 'M15'
          UNION ALL SELECT 'M30' UNION ALL SELECT 'H1' UNION ALL SELECT 'H4' UNION ALL SELECT 'D1'
          UNION ALL SELECT 'W1' UNION ALL SELECT 'MN') f
        WHERE NOT EXISTS (SELECT 1 FROM chart_publication_state s
          WHERE s.instrument_id=t.instrument_id AND s.timeframe=f.frame)'''))


def downgrade():
    # Roll back the application with the additive table retained. Dropping pending
    # requests without first rebuilding old bucket jobs would lose corrections.
    if op.get_bind().scalar(sa.text('SELECT COUNT(*) FROM chart_publication_state '
                                    'WHERE requested > processed')):
        raise RuntimeError("Pending publication requests exist; prepare application rollback first")
    op.drop_table("chart_publication_state")
