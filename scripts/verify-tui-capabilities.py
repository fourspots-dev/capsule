#!/usr/bin/env python3
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


model_calls = 0
model_lock = threading.Lock()


class ModelHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        global model_calls
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        with model_lock:
            model_calls += 1
            call = model_calls
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if call == 1:
            tool = {
                "index": 0,
                "id": "call_write",
                "function": {
                    "name": "write_file",
                    "arguments": json.dumps(
                        {
                            "path": "verified.txt",
                            "text": "verified by portable TUI\n",
                        }
                    ),
                },
            }
            finish = "tool_calls"
        elif call == 2:
            tool = {
                "index": 0,
                "id": "call_check",
                "function": {
                    "name": "action_app_game_check",
                    "arguments": "{}",
                },
            }
            finish = "tool_calls"
        else:
            event = {
                "choices": [
                    {
                        "delta": {"content": "TUI capability completed"},
                        "finish_reason": "stop",
                    }
                ]
            }
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return
        event = {
            "choices": [
                {
                    "delta": {"tool_calls": [tool]},
                    "finish_reason": finish,
                }
            ]
        }
        self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, _format, *_args):
        return


def read_available(fd, output, timeout):
    end = time.time() + timeout
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready:
            continue
        try:
            output.extend(os.read(fd, 65536))
        except OSError:
            return
        if b"TUI capability completed" in bytes(output):
            return


def main():
    root = Path(tempfile.mkdtemp(prefix="tinyai-tui-capabilities-"))
    (root / "package.json").write_text(
        json.dumps(
            {
                "private": True,
                "scripts": {
                    "check": "node -e \"process.stdout.write('tui-check-ok\\\\n')\""
                },
            }
        )
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir("/Users/jiaoxiang/ai/clj/clj-agent")
        os.environ.update(
            {
                "DEEPSEEK_API_KEY": "test-key",
                "TERM": "xterm-256color",
            }
        )
        os.execv(
            "/usr/bin/env",
            [
                "env",
                "node",
                "dist/tinyai-tui.cjs",
                "--workspace",
                str(root),
                "--workspace-mode",
                "host",
                "--tool-profile",
                "portable",
                "--approval",
                "auto",
                "--base-url",
                f"http://127.0.0.1:{port}/v1",
                "--model",
                "mock",
                "--action-script",
                "app.game.check:check:Run TUI smoke check",
            ],
        )
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 128, 0, 0))
    output = bytearray()
    read_available(fd, output, 1.5)
    os.write(fd, b"Write and verify through portable tools\r")
    read_available(fd, output, 15)
    os.write(fd, b"\x03")
    time.sleep(0.3)
    os.write(fd, b"\x03")
    read_available(fd, output, 1)
    try:
        waited, _ = os.waitpid(pid, os.WNOHANG)
        if waited == 0:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.2)
            waited, _ = os.waitpid(pid, os.WNOHANG)
        if waited == 0:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    server.shutdown()
    server.server_close()
    text = re.sub(
        rb"\x1b\[[0-9;?]*[ -/]*[@-~]", b"", bytes(output)
    ).decode("utf-8", "replace")
    verified_file = root / "verified.txt"
    result = {
        "workspace": str(root),
        "modelCalls": model_calls,
        "containsFinal": "TUI capability completed" in text,
        "containsAction": "action_app_game_check" in text,
        "legacyShellAdvertised": "Virtual Shell only provides" in text,
        "verifiedFile": verified_file.read_text() if verified_file.exists() else None,
        "tail": text[-1800:],
    }
    print(json.dumps(result, indent=2))
    if (
        not result["containsFinal"]
        or not result["containsAction"]
        or result["legacyShellAdvertised"]
        or result["verifiedFile"] != "verified by portable TUI\n"
    ):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
