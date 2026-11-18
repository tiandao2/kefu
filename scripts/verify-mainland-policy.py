#!/usr/bin/python3
"""Exercise the installed CIDRs and exceptions in an isolated loopback Nginx."""
import json
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main():
    checks = []
    with tempfile.TemporaryDirectory(prefix="kf-mainland-check-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        config = root / "nginx.conf"
        config.write_text(f"""daemon off;
pid {root}/nginx.pid;
error_log {root}/error.log;
events {{ worker_connections 64; }}
http {{
    access_log off;
    include /etc/nginx/conf.d/kf-mainland-geo.conf;
    server {{
        listen 127.0.0.1:{port};
        server_name localhost;
        # Test-only trusted header; never installed in the public Nginx server.
        set_real_ip_from 127.0.0.1;
        real_ip_header X-KF-Test-IP;
        location ^~ /.well-known/acme-challenge/ {{ root /var/www/letsencrypt; }}
        location = /telegram/webhook {{
            include /etc/nginx/snippets/kf-telegram-sources.conf;
            include /etc/nginx/snippets/kf-proxy.conf;
        }}
        location / {{
            include /etc/nginx/snippets/kf-mainland-only.conf;
            include /etc/nginx/snippets/kf-proxy.conf;
        }}
    }}
}}
""")
        process = subprocess.Popen(["nginx", "-p", str(root), "-c", str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        def request(ip, path="/", body=None, headers=None):
            values = {"X-KF-Test-IP": ip, "Host": "kf.wgioat.cn", **(headers or {})}
            if body is not None:
                values["Content-Type"] = "application/json"
            req = urllib.request.Request(f"http://127.0.0.1:{port}" + path, data=body, headers=values)
            try:
                with urllib.request.urlopen(req, timeout=5) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()
        def expect(ip, path, expected, body=None, headers=None):
            status, response = request(ip, path, body, headers)
            assert status == expected, (ip, path, expected, status)
            checks.append({"source": ip, "path": path, "expected_status": expected, "actual_status": status})
            return response
        try:
            for _ in range(50):
                try:
                    request("127.0.0.1")
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("Isolated Nginx did not start")
            for ip in ["223.5.5.5", "114.114.114.114", "119.29.29.29", "2400:3200::1"]:
                expect(ip, "/", 200)
                expect(ip, "/api/messages", 401)
            for ip in ["8.8.8.8", "1.1.1.1", "43.129.28.176", "168.95.1.1", "202.175.1.1", "2606:4700:4700::1111"]:
                for path in ["/", "/api/messages", "/ws"]:
                    expect(ip, path, 403)
            token = "kf-mainland-policy-preflight"
            challenge = Path("/var/www/letsencrypt/.well-known/acme-challenge") / token
            challenge.parent.mkdir(parents=True, exist_ok=True)
            challenge.write_text("mainland-policy-acme-ok")
            try:
                assert expect("8.8.8.8", "/.well-known/acme-challenge/" + token, 200) == b"mainland-policy-acme-ok"
            finally:
                challenge.unlink(missing_ok=True)
            values = {}
            for line in Path("/etc/kf-chat.env").read_text().splitlines():
                if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    parts = shlex.split(value)
                    values[key] = parts[0] if parts else ""
            secret = {"X-Telegram-Bot-Api-Secret-Token": values["WEBHOOK_SECRET"]}
            # {} is deliberately invalid: the app returns 400 without queueing an update.
            for ip in ["149.154.160.1", "91.108.4.1"]:
                expect(ip, "/telegram/webhook", 400, b"{}", secret)
                expect(ip, "/telegram/webhook", 403, b"{}", {"X-Telegram-Bot-Api-Secret-Token": "invalid-test-secret"})
            for ip in ["8.8.8.8", "223.5.5.5"]:
                expect(ip, "/telegram/webhook", 403, b"{}", secret)
        finally:
            process.terminate()
            process.communicate(timeout=10)
        result = {"passed": len(checks), "checks": checks, "test_listener": "isolated loopback only; stopped after testing"}
        Path("/root/kf-mainland-policy-verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
