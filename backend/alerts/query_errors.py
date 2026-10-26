"""Query failures translated by HTTP and MCP adapters."""

class QueryError(Exception):
    def __init__(self, status_code: int, detail, headers: dict[str, str] | None = None):
        self.status_code = status_code
        self.detail = detail
        self.headers = headers
        super().__init__(str(detail))
