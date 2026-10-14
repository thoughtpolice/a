#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Drive gopls over LSP through the launcher, on the toolchain's tests.

Runs gopls with the command and settings that Helix, Claude Code and OMP
give it, after checking that their three configurations agree. Opens
tests/hello/main.go, which a go_binary and a go_test share and which
imports the go_library in tests/greeting, and checks that gopls reports
no errors and finds definitions in the library, the stdlib and golang.org/x;
that an import added in the editor, before any save, resolves; and that a
type error shows. Then checks that a golang.org/x file type-checks after an
editor adds its module as a workspace folder, that a go_bootstrap_binary's
file does, and that a file no target owns gets an error saying so. The
driver's Buck calls run in their own isolation directory, whose daemon this
stops at the end.
"""

import json
import os
import queue
import subprocess
import sys
import threading
import time
import tomllib

ISOLATION_DIR = ".gopls-tests"
TIMEOUT = 600


def fail(msg: str):
    print("FAIL: " + msg, file=sys.stderr)
    sys.exit(1)


def project_root() -> str:
    return subprocess.run(
        ["buck2", "root", "--kind", "project"], capture_output=True, text=True, check=True
    ).stdout.strip()


def configured_server(root: str) -> tuple[list[str], dict]:
    """The command that starts gopls and the settings it gets. Helix, Claude
    Code and OMP each have a copy, in their own shape (see README.md)."""

    def read(path: str):
        with open(os.path.join(root, path), "rb") as f:
            return tomllib.load(f) if path.endswith(".toml") else json.load(f)

    helix = read(".helix/languages.toml")["language-server"]["gopls"]
    claude = read(".claude/marketplace/lsp/.lsp.json")["gopls"]
    omp = read(".omp/lsp.json")["servers"]["gopls"]
    command = [helix["command"], *helix["args"]]
    settings = helix["config"]
    for path, config, given in [
        (".claude/marketplace/lsp/.lsp.json", claude, [claude["initializationOptions"]]),
        (".omp/lsp.json", omp, [omp["initOptions"], omp["settings"]["gopls"]]),
    ]:
        if [config["command"], *config["args"]] != command:
            fail("{} starts gopls differently from .helix/languages.toml".format(path))
        if any(s != settings for s in given):
            fail("{} gives gopls other settings than .helix/languages.toml".format(path))
    return command, settings


class Server:
    def __init__(self, root: str, command: list[str], settings: dict):
        self.settings = settings
        env = dict(os.environ, BUCK_ISOLATION_DIR=ISOLATION_DIR)
        self.proc = subprocess.Popen(
            command,
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

    def request(self, method: str, params):
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
            if msg.get("method") == "workspace/configuration":
                self.send({"id": msg["id"], "result": [self.settings for _ in msg["params"]["items"]]})
            elif "method" in msg and "id" in msg:
                # registerCapability, workDoneProgress/create and friends
                self.send({"id": msg["id"], "result": None})
            elif msg.get("method") == "window/showMessage" and msg["params"]["type"] == 1:
                fail("server error: " + msg["params"]["message"])
        fail("timed out waiting for " + method)

    def errors(self, uri: str) -> list[str]:
        """The errors gopls finds in a file now. Pulled rather than waited
        for: gopls publishes diagnostics when it gets round to them."""
        report = self.request("textDocument/diagnostic", {"textDocument": {"uri": uri}})
        return [d["message"] for d in report["items"] if d.get("severity") == 1]


class File:
    def __init__(self, server: Server, path: str, text: str | None = None):
        self.server = server
        self.uri = "file://" + path
        self.name = os.path.basename(path)
        if text is None:
            with open(path) as f:
                text = f.read()
        self.text = text
        self.version = 1
        server.send(
            {
                "method": "textDocument/didOpen",
                "params": {"textDocument": {"uri": self.uri, "languageId": "go", "version": 1, "text": text}},
            }
        )

    def edit(self, text: str):
        """Replace the editor's contents, without saving."""
        self.text = text
        self.version += 1
        self.server.send(
            {
                "method": "textDocument/didChange",
                "params": {
                    "textDocument": {"uri": self.uri, "version": self.version},
                    "contentChanges": [{"text": text}],
                },
            }
        )

    def expect_clean(self):
        errors = self.server.errors(self.uri)
        if errors:
            fail("errors in {}:\n{}".format(self.name, "\n".join(errors)))

    def definition(self, line_text: str, word: str) -> str:
        """Where gopls says `word`, on the first line containing line_text, is
        defined."""
        for line, content in enumerate(self.text.split("\n")):
            if line_text in content:
                col = content.index(word, content.index(line_text)) + 1
                result = self.server.request(
                    "textDocument/definition",
                    {"textDocument": {"uri": self.uri}, "position": {"line": line, "character": col}},
                )
                if not result:
                    fail("no definition of {} in {}".format(word, self.name))
                location = result[0] if isinstance(result, list) else result
                return location["uri"].removeprefix("file://")
        fail("{} not in {}".format(line_text, self.name))


def expect(what: str, path: str, *parts: str):
    if not all(part in path for part in parts):
        fail("{} is at {}, not under {}".format(what, path, "/".join(parts)))


def main():
    root = project_root()
    command, settings = configured_server(root)
    server = Server(root, command, settings)
    try:
        server.request(
            "initialize",
            {
                "processId": os.getpid(),
                "rootUri": "file://" + root,
                "capabilities": {"workspace": {"configuration": True}},
                "initializationOptions": settings,
            },
        )
        server.send({"method": "initialized", "params": {}})

        tests = os.path.join(root, "buck/toolchains/golang/lsp/tests")
        main_go = File(server, os.path.join(tests, "hello/main.go"))
        main_go.expect_clean()
        expect("greeting.Hello", main_go.definition("greeting.Hello(", "Hello"), "lsp/tests/greeting/greeting.go")
        expect("fmt.Println", main_go.definition("fmt.Println(", "Println"), "/src/fmt/")

        # An import of golang.org/x that only the editor has seen, then a
        # type error.
        original = main_go.text
        imported = original.replace('\t"fmt"\n', '\t"fmt"\n\n\t"golang.org/x/text/language"\n', 1)
        main_go.edit(imported + "\nvar _ = language.English\n")
        main_go.expect_clean()
        expect("language.English", main_go.definition("var _ = language.English", "English"), "module-text/language/")
        main_go.edit(original + '\nvar _ int = "not an int"\n')
        if not any("cannot use" in e for e in server.errors(main_go.uri)):
            fail("no type error in an edited main.go")
        main_go.edit(original)

        # The go_test's own file, and the library's golang.org/x.
        main_test = File(server, os.path.join(tests, "hello/main_test.go"))
        main_test.expect_clean()
        expect("testing.T", main_test.definition("t *testing.T", "T"), "/src/testing/")
        greeting = File(server, os.path.join(tests, "greeting/greeting.go"))
        greeting.expect_clean()
        cases_go = greeting.definition("cases.Title(", "Title")
        expect("cases.Title", cases_go, "module-text/cases/")

        # An editor that roots a workspace folder at the nearest go.mod, as
        # Helix does unless told otherwise, adds golang.org/x/text's on
        # opening the file there, and gopls asks about the file directly.
        module = cases_go[: cases_go.index("/module-text/") + len("/module-text")]
        server.send(
            {
                "method": "workspace/didChangeWorkspaceFolders",
                "params": {"event": {"added": [{"uri": "file://" + module, "name": "module-text"}], "removed": []}},
            }
        )
        File(server, cases_go).expect_clean()

        # A go_bootstrap_binary, built from the stdlib alone.
        manifest = File(server, os.path.join(root, "buck/toolchains/golang/x/manifest.go"))
        manifest.expect_clean()
        expect("build.Default", manifest.definition("build.Default", "Default"), "/src/go/build/")

        # A file in no target's srcs: never saved, so not even a glob has it.
        unsaved = File(
            server,
            os.path.join(tests, "hello/zz_unsaved.go"),
            'package main\n\nimport "fmt"\n\nvar _ = fmt.Sprint\n',
        )
        errors = server.errors(unsaved.uri)
        if len(errors) != 1 or "srcs of no go_binary" not in errors[0]:
            fail("unowned file errors: {}".format(errors))

        server.request("shutdown", None)
        server.send({"method": "exit"})
        server.proc.wait(timeout=60)
    finally:
        if server.proc.poll() is None:
            server.proc.kill()
        subprocess.run(["buck2", "--isolation-dir", ISOLATION_DIR, "kill"], cwd=root, capture_output=True)
    print("ok")


if __name__ == "__main__":
    main()
