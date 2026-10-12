"""Task-local notification sink. Only run inside the ATR acceptance network."""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

OUTPUT = Path("/evidence/notifications.jsonl")


class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 100000:
            self.send_error(400)
            return
        body = json.loads(self.rfile.read(length))
        if body.get("topic") != "atr-offset-fixture":
            self.send_error(400)
            return
        with OUTPUT.open("a") as stream:
            stream.write(json.dumps(body, ensure_ascii=False) + "\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"id":"atr-fixture","event":"message"}')

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8000), Sink).serve_forever()
