from __future__ import annotations

import argparse
import json
import mimetypes
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from agent import load_dataset, plan_trip, public_cities


ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"


class Handler(BaseHTTPRequestHandler):
    server_version = "WaypointAgent/1.0"

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 500_000:
            raise ValueError("Request too large")
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            dataset = load_dataset()["dataset"]
            return self.send_json({"ok":True,"mode":"openai" if os.getenv("OPENAI_API_KEY") else "local","model":os.getenv("OPENAI_MODEL") if os.getenv("OPENAI_API_KEY") else None,"dataset":dataset})
        if path == "/api/cities":
            return self.send_json(public_cities())
        self.serve_static(path)

    def do_POST(self):
        if urlparse(self.path).path != "/api/plan":
            return self.send_json({"error":"Not found"}, HTTPStatus.NOT_FOUND)
        try:
            return self.send_json(plan_trip(self.read_json()))
        except (ValueError, json.JSONDecodeError) as exc:
            return self.send_json({"error":str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            return self.send_json({"error":f"Planner failed: {type(exc).__name__}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def serve_static(self, path):
        relative = unquote(path).lstrip("/") or "index.html"
        candidate = (WEB / relative).resolve()
        if not str(candidate).startswith(str(WEB.resolve())) or not candidate.is_file():
            candidate = WEB / "index.html"
        data = candidate.read_bytes()
        mime = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if mime.startswith("text/") or mime in {"application/javascript", "application/json"}:
            mime += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")


def main():
    parser = argparse.ArgumentParser(description="Waypoint travel planning agent")
    parser.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8877")))
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Waypoint Agent running at http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
