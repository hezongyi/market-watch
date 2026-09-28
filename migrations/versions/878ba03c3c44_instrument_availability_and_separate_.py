"""instrument availability and separate BTCUSDT source
Revision ID: 878ba03c3c44
Revises: 6be9ffe49143
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '878ba03c3c44'
down_revision: Union[str, Sequence[str], None] = '6be9ffe49143'
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.add_column("instruments", sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.execute(sa.text("UPDATE instruments SET enabled = false WHERE id = 'BTCUSD'"))

def downgrade() -> None:
    op.drop_column("instruments", "enabled")
