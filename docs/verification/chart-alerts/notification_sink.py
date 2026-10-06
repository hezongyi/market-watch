"""Task-only ntfy protocol sink; never forwards messages to any other service."""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

records = []
attempts = []
lock = threading.Lock()
failures = int(os.environ.get("SINK_INITIAL_FAILURES", "1"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if self.path != "/" or not 0 < length <= 100_000:
            return self.reply(400, {"error": "invalid task fixture request"})
        try:
            payload = json.loads(self.rfile.read(length))
        except ValueError:
            return self.reply(400, {"error": "invalid JSON"})
        with lock:
            attempts.append(payload)
            if len(attempts) <= failures:
                return self.reply(503, {"error": "isolated injected retry"})
            records.append(payload)
            return self.reply(200, {"id": "isolated-" + str(len(records))})

    def do_GET(self):
        if self.path != "/records":
            return self.reply(404, {"error": "unknown fixture endpoint"})
        with lock:
            return self.reply(200, {"scope": "isolated notification sink; no device delivery",
                                    "attempts": attempts, "accepted": records})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
