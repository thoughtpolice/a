#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Drive `lake serve` over LSP on the Lean toolchain's test program.

Opens buck/toolchains/lean/tests/Main.lean, whose imports live in two other
Buck targets, and checks that the server reports no errors, hovers a
definition from one of them, and jumps to its source. The shim's Buck
calls run in their own isolation directory, whose daemon this stops at the
end.
"""

import json
import os
import queue
import subprocess
import sys
import threading
import time

ISOLATION_DIR = ".lean-lsp-tests"
TIMEOUT = 600


def fail(msg: str):
    print("FAIL: " + msg, file=sys.stderr)
    sys.exit(1)


def project_root() -> str:
    return subprocess.run(
        ["buck2", "root", "--kind", "project"], capture_output=True, text=True, check=True
    ).stdout.strip()


class Server:
    def __init__(self, root: str):
        env = dict(os.environ, BUCK_ISOLATION_DIR=ISOLATION_DIR)
        self.proc = subprocess.Popen(
            [os.path.join(root, "buck/toolchains/lean/lsp/lake"), "serve"],
            cwd=root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        self.messages = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        out = self.proc.stdout
        while True:
            header = b""
            while not header.endswith(b"\r\n\r\n"):
                c = out.read(1)
                if not c:
                    self.messages.put(None)
                    return
                header += c
            length = next(
                int(line.split(b":")[1]) for line in header.split(b"\r\n") if line.lower().startswith(b"content-length")
            )
            self.messages.put(json.loads(out.read(length)))

    def send(self, msg: dict):
        body = json.dumps(dict(msg, jsonrpc="2.0")).encode()
        self.proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
        self.proc.stdin.flush()

    def request(self, method: str, params, on_message=None):
        self.next_id += 1
        rid = self.next_id
        self.send({"id": rid, "method": method, "params": params})
        deadline = time.time() + TIMEOUT
        while time.time() < deadline:
            msg = self.messages.get(timeout=TIMEOUT)
            if msg is None:
                fail("server exited during " + method)
            if msg.get("id") == rid and "method" not in msg:
                if "error" in msg:
                    fail("{} failed: {}".format(method, msg["error"]))
                return msg["result"]
            if "method" in msg and "id" in msg:
                # registerCapability and friends
                self.send({"id": msg["id"], "result": None})
            elif on_message:
                on_message(msg)
        fail("timed out waiting for " + method)


def position(text: str, word: str) -> dict:
    for line, content in enumerate(text.split("\n")):
        col = content.find(word)
        if col >= 0:
            return {"line": line, "character": col + 1}
    fail("{} not in file".format(word))


def main():
    root = project_root()
    path = os.path.join(root, "buck/toolchains/lean/tests/Main.lean")
    uri = "file://" + path
    with open(path) as f:
        text = f.read()

    server = Server(root)
    try:
        server.request("initialize", {"processId": os.getpid(), "rootUri": "file://" + root, "capabilities": {}})
        server.send({"method": "initialized", "params": {}})
        server.send(
            {
                "method": "textDocument/didOpen",
                "params": {"textDocument": {"uri": uri, "languageId": "lean", "version": 1, "text": text}},
            }
        )

        diagnostics = []

        def record(msg):
            if msg.get("method") == "textDocument/publishDiagnostics" and msg["params"]["uri"] == uri:
                diagnostics[:] = msg["params"]["diagnostics"]

        server.request("textDocument/waitForDiagnostics", {"uri": uri, "version": 1}, on_message=record)
        errors = [d["message"] for d in diagnostics if d.get("severity") == 1]
        if errors:
            fail("errors in Main.lean:\n" + "\n".join(errors))

        doc = {"uri": uri}
        at = position(text, "greeting")
        hover = server.request("textDocument/hover", {"textDocument": doc, "position": at})
        if not hover or "greeting (name : String) : String" not in hover["contents"]["value"]:
            fail("unexpected hover: {}".format(hover))

        definition = server.request("textDocument/definition", {"textDocument": doc, "position": at})
        targets = [d["targetUri"] for d in definition or []]
        if not any(t.endswith("/buck/toolchains/lean/tests/Greeting.lean") for t in targets):
            fail("unexpected definition: {}".format(definition))

        server.request("shutdown", None)
        server.send({"method": "exit", "params": None})
        server.proc.wait(timeout=30)
        print("ok: diagnostics, hover and definition through Buck")
    finally:
        if server.proc.poll() is None:
            server.proc.kill()
        subprocess.run(["buck2", "--isolation-dir", ISOLATION_DIR, "kill"], cwd=root, capture_output=True)


if __name__ == "__main__":
    main()
