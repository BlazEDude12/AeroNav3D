"""AeroNav3D local server.

Serves the static site and proxies /flights to the adsb.lol re-api
(https://www.adsb.lol/docs/feeders-only/re-api/). The proxy is required
because re-api is IP-restricted to ADS-B feeder stations and sends no
CORS headers, so the browser cannot call it directly.

Usage: python server.py  (serves on http://localhost:8321)
"""
import json
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = 8321
UPSTREAM = "https://re-api.adsb.lol/"


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path != "/flights":
            return super().do_GET()
        try:
            req = urllib.request.Request(
                UPSTREAM + ("?" + url.query if url.query else ""),
                headers={"User-Agent": "AeroNav3D/1.0 (local proxy)"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
            self._send_json(200, body)
        except Exception as exc:  # upstream down, timeout, non-feeder IP, ...
            self._send_json(502, json.dumps({"error": str(exc)}).encode())

    def _send_json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # keep the console quiet


if __name__ == "__main__":
    print(f"AeroNav3D serving on http://localhost:{PORT} (flights proxied to re-api.adsb.lol)")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
