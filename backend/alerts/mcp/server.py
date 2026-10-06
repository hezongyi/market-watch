"""Official SDK owns protocol and HTTP transport; host owns one lifespan."""

from mcp.server.lowlevel import Server
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ListToolsResult

from ..capabilities.actions import build_registry
from ..capabilities.context import current_identity
from ..config import settings
from .adapter import Adapter
from .auth import BearerMiddleware


def create_server(registry=None):
    adapter = Adapter(registry or build_registry())

    async def list_tools(ctx, params):
        return ListToolsResult(tools=adapter.tools(current_identity.get()))

    async def call_tool(ctx, params):
        return await adapter.call(current_identity.get(), params.name, params.arguments or {})

    server = Server(
        "Market Watch",
        version="1",
        on_list_tools=list_tools,
        on_call_tool=call_tool,
        instructions="Use source, series, timestamp and quality as returned. Saved drawings only. "
        "Separate data facts, calculations and analysis. Discuss plans with the user.",
    )
    http = server.streamable_http_app(
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=True,
        max_request_body_size=settings.mcp_max_body_bytes,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=settings.mcp_allowed_hosts,
            allowed_origins=settings.mcp_allowed_origins,
        ),
    )
    http.router.redirect_slashes = False

    class Endpoint:
        async def __call__(self, scope, receive, send):
            scope = dict(scope)
            if scope["path"].endswith("/mcp/"):
                scope["path"] = scope["path"][:-1]
                scope["raw_path"] = scope["path"].encode()
            return await http(scope, receive, send)

    return server, BearerMiddleware(Endpoint()), adapter
