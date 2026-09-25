# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run @celld/api/exedev inside a real celld dev supervisor against a fake lobby.

Buck provides the pinned CLI and the packaged test project
(tests/runtime/worker.ts). The Deno suites decide whether the library's rules
are right; this one decides whether they hold on the runtime and against an
independent implementation of the other side:

- the fake lobby splits each POST /exec body with Python's shlex (a POSIX
  lexer written by someone else), and runs `ssh <vm> <command>` through a real
  /bin/sh in a per-VM directory, so both layers of quoting, the base64 script
  transport, exit markers and setsid/nohup detaching are checked for real;
- exit codes go out as an HTTP trailer (which fetch cannot read) or a header;
- exe0 tokens minted with Web Crypto inside celld must equal the ones
  ssh-keygen made (tests/fixtures.ts), and fake-lobby checks their payload,
  namespace and signing key;
- the ExeFleet Durable Object reconciles against the fake, serializes
  concurrent runs, adopts a VM whose `new` answer was lost, prunes, and keeps
  its ledger across a supervisor restart;
- a Workflow provisions, waits, bootstraps (inline and detached) and
  verifies, and a second run with the same VM repeats none of the work.

No network or exe.dev account is involved. LocalRuntime is the toolchain's
helper from buck/toolchains/celld/tests/runtime_test.py, as jev copies it.
"""

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request


ADMIN_TOKEN = "exe1.runtime-test"
NARROW_TOKEN = "exe1.narrow"
# The fixture key's public half (tests/fixtures.ts).
FIXTURE_PUBLIC_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAILh+AbXdnj67HYeV2QNrdVPHS4QcgwNJhLAUlicvTjYI"

# Flags the fake accepts per command; others are a 422 like the real lobby's.
FLAGS = {
    "whoami": set(),
    "ls": {"-l", "--group"},
    "new": {"--name", "--tag", "--comment", "--cpu", "--memory", "--disk", "--image", "--integration",
            "--no-email", "--setup-script", "--env", "--pool"},
    "rm": set(),
    "tag": {"-d"},
    "comment": set(),
    "stat": {"--range"},
    "resize": {"--cpu", "--memory", "--disk"},
    "integrations attach": set(),
    "integrations detach": set(),
    "share port": set(),
    "share set-public": set(),
    "share set-private": set(),
}
SWITCHES = {"-l", "-d", "--no-email"}


def b64url_decode(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def read_string(data, offset):
    length = int.from_bytes(data[offset:offset + 4], "big")
    return data[offset + 4:offset + 4 + length], offset + 4 + length


def exe0_permissions(token):
    """The permissions of an exe0 token signed by the fixture key, else None.

    The signature itself is not verified here (Python's standard library has
    no Ed25519); the /mint test proves the minting code byte-identical to
    ssh-keygen, and this checks the token is shaped and scoped as exe.dev
    expects: an SSHSIG blob with the fixture key, namespace v0@exe.dev, and
    sha512.
    """
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "exe0":
        return None
    payload = b64url_decode(parts[1])
    blob = b64url_decode(parts[2])
    if blob[:6] != b"SSHSIG" or int.from_bytes(blob[6:10], "big") != 1:
        return None
    key, offset = read_string(blob, 10)
    namespace, offset = read_string(blob, offset)
    _, offset = read_string(blob, offset)
    hash_algorithm, offset = read_string(blob, offset)
    if base64.b64encode(key).decode() != FIXTURE_PUBLIC_KEY or namespace != b"v0@exe.dev" or hash_algorithm != b"sha512":
        return None
    permissions = json.loads(payload)
    if permissions.get("exp", 4102444800) < time.time():
        return None
    return permissions


class FakeLobby:
    """POST /exec the way the HTTPS API page describes it."""

    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="exedev-fake-lobby-"))
        self.lock = threading.Lock()
        self.vms = {}
        self.log = []
        self.faults = {}
        self.exit_via = "trailer"
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def reply(self, status, body, headers=()):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                for name, value in headers:
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

            def reply_trailer(self, data, code):
                self.send_response(200)
                self.send_header("content-type", "application/octet-stream")
                self.send_header("transfer-encoding", "chunked")
                self.send_header("trailer", "X-Exe-Exit")
                self.end_headers()
                if data:
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                self.wfile.write(b"0\r\nX-Exe-Exit: %d\r\n\r\n" % code)

            def do_GET(self):
                self.reply(405, {"error": "method not allowed"})

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                body = self.rfile.read(length).decode()
                auth = self.headers.get("authorization", "")
                result = fake.handle(body, auth)
                if result[0] == "ssh":
                    _, output, code = result
                    if fake.exit_via == "trailer":
                        return self.reply_trailer(output, code)
                    return self.reply(200, output, [("X-Exe-Exit", str(code))])
                if result[0] == "hang":
                    time.sleep(3)
                    try:
                        return self.reply(504, {"error": "too late"})
                    except OSError:
                        return None
                status, payload = result
                self.reply(status, payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.root, ignore_errors=True)

    def count(self, path, **match):
        with self.lock:
            return sum(1 for entry in self.log if entry["path"] == path
                       and all(entry.get(key) == value for key, value in match.items()))

    def fail_next(self, path, status, execute=False):
        with self.lock:
            self.faults[path] = (status, execute)

    def permissions(self, auth):
        if not auth.startswith("Bearer "):
            return None
        token = auth[len("Bearer "):]
        if token == ADMIN_TOKEN:
            return {"cmds": ["*"]}
        if token == NARROW_TOKEN:
            return {"cmds": ["ls"]}
        return exe0_permissions(token)

    def handle(self, body, auth):
        if not body.strip():
            return 400, {"error": "empty command"}
        if len(body.encode()) > 64 * 1024:
            return 413, {"error": "request too large"}
        try:
            words = shlex.split(body, posix=True)
        except ValueError as error:
            return 400, {"error": str(error)}
        path = " ".join(words[:2]) if " ".join(words[:2]) in FLAGS else words[0]
        rest = words[2:] if path.count(" ") == 1 else words[1:]
        permissions = self.permissions(auth)
        with self.lock:
            self.log.append({"path": path, "words": words, "token": auth[7:]})
        if permissions is None:
            return 401, {"error": "invalid token"}
        cmds = permissions.get("cmds", ["help", "ls", "new", "whoami", "ssh-key list", "share show",
                                       "exe0-to-exe1", "team", "team members"])
        target = rest[0] if path == "ssh" and rest else None
        if "*" not in cmds and path not in cmds and not (path == "ssh" and f"ssh {target}" in cmds):
            return 403, {"error": f"command not allowed by token permissions: {path}"}
        if path != "ssh" and path not in FLAGS:
            return 404, {"error": f"unknown command: {path}"}
        with self.lock:
            fault = self.faults.pop(path, None)
        if fault is not None and not fault[1]:
            return fault[0], {"error": "injected"}
        if path == "stat":
            return ("hang",)
        try:
            result = self.run(path, rest)
        except ValueError as error:
            result = (422, {"error": str(error)})
        if fault is not None:
            return fault[0], {"error": "injected after running"}
        return result

    def flags(self, path, rest):
        flags, args = {}, []
        for word in rest:
            if word.startswith("-") and word != "-":
                name, eq, value = word.partition("=")
                if name not in FLAGS[path]:
                    raise ValueError(f"unknown flag {name}")
                flags.setdefault(name, []).append(value if eq else True)
            else:
                args.append(word)
        return flags, args

    def listing(self, vm):
        return {"vm_name": vm["name"], "status": "running", "region": "lax", "region_display": "Los Angeles, USA",
                "ssh_dest": f"{vm['name']}.exe.xyz", "https_url": f"https://{vm['name']}.exe.xyz"}

    def run(self, path, rest):
        if path == "ssh":
            return self.ssh(rest)
        flags, args = self.flags(path, rest)
        with self.lock:
            if path == "whoami":
                return 200, {"email": "runtime@example.com", "ssh_keys": [{"fingerprint": "SHA256:x", "current": True}]}
            if path == "ls":
                return 200, {"vms": [self.listing(vm) for vm in self.vms.values()]}
            if path == "new":
                name = flags.get("--name", [None])[0] or f"auto-{len(self.vms)}"
                if name in self.vms:
                    raise ValueError(f"VM name {name} already exists")
                home = self.root / name
                home.mkdir()
                self.vms[name] = {"name": name, "tags": list(flags.get("--tag", [])),
                                  "comment": flags.get("--comment", [""])[0], "home": home,
                                  "setup": flags.get("--setup-script", [None])[0]}
                return 200, dict(self.listing(self.vms[name]), ssh_host=f"{name}.exe.xyz")
            if path == "rm":
                for name in args:
                    if name not in self.vms:
                        raise ValueError(f"no such VM: {name}")
                for name in args:
                    shutil.rmtree(self.vms.pop(name)["home"], ignore_errors=True)
                return 200, {"deleted": args}
            vm = self.vms.get(args[0]) if args else None
            if vm is None:
                raise ValueError(f"no such VM: {args[0] if args else ''}")
            if path == "tag":
                if "-d" in flags:
                    vm["tags"] = [tag for tag in vm["tags"] if tag not in args[1:]]
                else:
                    vm["tags"] += [tag for tag in args[1:] if tag not in vm["tags"]]
            elif path == "comment":
                vm["comment"] = " ".join(args[1:])
            return 200, {"ok": True}

    def ssh(self, rest):
        target, command = rest[0], " ".join(rest[1:])
        name = target.rpartition("@")[2]
        with self.lock:
            vm = self.vms.get(name)
        if vm is None:
            return 422, {"error": f"no such VM: {name}"}
        env = {"HOME": str(vm["home"]), "PATH": os.environ.get("PATH", "/usr/bin:/bin")}
        done = subprocess.run(["/bin/sh", "-c", command], cwd=vm["home"], env=env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=25)
        return "ssh", done.stdout, done.returncode


class LocalRuntime:
    """Own exactly one temporary project and celld dev supervisor process."""

    def __init__(self, project):
        self.temporary = tempfile.TemporaryDirectory(prefix="exedev-runtime-test-")
        self.root = Path(self.temporary.name)
        self.log_path = self.root / "celld.log"
        self.process = None
        self.log = None
        try:
            shutil.copytree(project, self.root / "project")
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            self.origin = f"http://127.0.0.1:{port}"
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("CELLD_", "AWS_", "S3_"))
                   and key.lower() not in ("http_proxy", "https_proxy", "all_proxy")
                   and key != "RUST_LOG"}
            env["NO_COLOR"] = "1"
            self.log = self.log_path.open("w")
            self.command = [str(CELLD), "dev", str(self.root / "project"), "--host", "127.0.0.1",
                            "--port", str(port), "--logs", "--no-watch"]
            self.environment = env
            self.start()
        except BaseException:
            self.close()
            raise

    def logs(self):
        return self.log_path.read_text(errors="replace")

    def start(self):
        offset = len(self.logs())
        self.process = subprocess.Popen(
            self.command, stdin=subprocess.DEVNULL, stdout=self.log,
            stderr=subprocess.STDOUT, env=self.environment,
        )
        self.until(lambda: "ready  " + self.origin in self.logs()[offset:], 40, "startup")

    def until(self, condition, seconds, phase):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError(f"celld exited during {phase}:\n{self.logs()}")
            if condition():
                return
            time.sleep(0.02)
        raise AssertionError(f"celld timed out during {phase}:\n{self.logs()}")

    def request(self, method, path, payload=None, timeout=60):
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(
            self.origin + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                body = error.read()
            try:
                return error.code, json.loads(body)
            except ValueError:
                return error.code, body.decode(errors="replace")
        except (OSError, urllib.error.URLError) as error:
            raise AssertionError(f"request failed: {error}\n{self.logs()}") from error

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=40)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
                raise AssertionError(f"celld did not stop gracefully:\n{self.logs()}")

    def restart(self):
        self.stop()
        self.start()

    def close(self):
        try:
            self.stop()
        finally:
            if self.log is not None:
                self.log.close()
            self.temporary.cleanup()


class ExedevRuntimeTest(unittest.TestCase):
    """The client, minting, fleet and workflow on the real runtime."""

    @classmethod
    def setUpClass(cls):
        cls.fake = FakeLobby()
        cls.addClassCleanup(cls.fake.close)
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def call(self, method, path, payload=None, query=""):
        separator = "&" if "?" in path else "?"
        status, body = self.runtime.request(method, f"{path}{separator}base={self.fake.origin}{query}", payload)
        self.assertEqual(status, 200, body)
        return body

    def fleet(self, name):
        return f"&fleet={name}"

    def test_the_client_over_real_fetch_and_a_real_shell(self):
        self.fake.exit_via = "trailer"
        result = self.call("POST", "/client")
        self.assertTrue(result["whoami"]["ok"], result["whoami"])
        self.assertEqual(result["created"]["value"]["vm_name"], "rt-0", result["created"])
        new = [entry for entry in self.fake.log if entry["path"] == "new" and "--name=rt-0" in entry["words"]][0]["words"]
        self.assertIn('--comment=it\'s a "test"; $HOME', new)
        self.assertIn("--setup-script=#!/bin/sh\\necho hi\\n", new)
        self.assertEqual(self.fake.vms["rt-0"]["tags"], ["rt"])
        duplicate = result["duplicate"]["error"]
        self.assertEqual((duplicate["kind"], duplicate["status"], duplicate["detail"]),
                         ("command_failed", 422, "VM name rt-0 already exists"))
        self.assertIn("rt-0", [vm["vm_name"] for vm in result["listed"]["value"]["vms"]])
        # Both quoting layers, through shlex and a real /bin/sh.
        argv = result["argv"]["value"]
        self.assertEqual((argv["exitCode"], argv["exitSource"], argv["text"]),
                         (0, "marker", "it's $HOME|a  b|`id`||\\n|"))
        script = result["script"]["value"]
        self.assertEqual((script["exitCode"], script["exitSource"]), (3, "marker"))
        self.assertEqual(sorted(script["text"].splitlines()), ["args: one two words", "to stderr"])
        header = result["header"]["value"]
        self.assertEqual((header["exitCode"], header["exitSource"], header["text"]), (None, None, "plain\n"))
        detached = result["detached"]["value"]
        self.assertGreater(detached["pid"], 0)
        home = self.fake.vms["rt-0"]["home"]
        deadline = time.monotonic() + 10
        while not (home / "detached.status").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual((home / "later.txt").read_text(), "later\n")
        self.assertEqual((home / "detached.status").read_text(), "0\n")
        missing = result["missing"]["error"]
        self.assertEqual((missing["kind"], missing["detail"]), ("command_failed", "no such VM: rt-404"))
        self.assertEqual(result["badFlag"]["error"]["detail"], "unknown flag --bogus")
        self.assertEqual(result["unauthorized"]["error"]["kind"], "authentication")
        forbidden = result["forbidden"]["error"]
        self.assertEqual((forbidden["kind"], forbidden["attempts"]), ("permission", 1))
        timeout = result["timeout"]["error"]
        self.assertEqual((timeout["kind"], timeout["attempts"], timeout["ambiguous"]), ("timeout", 2, True))
        self.assertLess(result["timeoutElapsedMs"], 2500)

    def test_exit_codes_arrive_in_a_header_when_the_server_sends_one(self):
        self.fake.exit_via = "header"
        try:
            status, body = self.runtime.request("POST", f"/client?base={self.fake.origin}")
            self.assertEqual(status, 200, body)
            self.assertTrue(body["script"]["ok"], body["script"])
            self.assertEqual(body["header"]["value"]["exitCode"], 4)
            self.assertEqual(body["header"]["value"]["exitSource"], "header")
            self.assertEqual(body["script"]["value"]["exitCode"], 3)
        finally:
            self.fake.exit_via = "trailer"
            with self.fake.lock:
                vm = self.fake.vms.pop("rt-0", None)
            if vm is not None:
                shutil.rmtree(vm["home"], ignore_errors=True)

    def test_exe0_minting_in_celld_matches_ssh_keygen(self):
        result = self.call("POST", "/mint")
        self.assertTrue(result["matches"], result["minted"])
        self.assertTrue(result["vmMatches"])
        self.assertTrue(result["whoami"]["ok"], result["whoami"])
        self.assertTrue(result["ls"]["ok"], result["ls"])
        self.assertEqual(result["denied"]["error"]["kind"], "permission")
        tokens = {entry["token"] for entry in self.fake.log if entry["path"] in ("whoami", "ls")
                  and entry["token"].startswith("exe0.")}
        self.assertEqual(len(tokens), 1, "one minted token is reused")
        permissions = exe0_permissions(tokens.pop())
        self.assertEqual(permissions["cmds"], ["whoami", "ls"])
        self.assertAlmostEqual(permissions["exp"], time.time() + 600, delta=60)

    def test_the_key_limiter_paces_requests_across_calls(self):
        result = self.call("POST", "/limiter", query="&name=pace")
        self.assertGreaterEqual(result["elapsedMs"], 900)
        self.assertEqual(result["snapshot"]["limits"], {"requestsPerSecond": 2, "burst": 1})

    def test_the_fleet_object_reconciles_serializes_and_survives_restart(self):
        name = self.fleet("web")
        spec = {"prefix": "fleet", "size": 3, "tags": ["web"], "comment": "runtime fleet"}
        self.assertEqual(self.call("POST", "/fleet/configure", {"spec": spec}, name), {"ok": True})
        first = self.call("POST", "/fleet/reconcile", query=name)
        self.assertEqual([(r["action"]["kind"], r["action"]["vm"], r["ok"]) for r in first["results"]],
                         [("create", "fleet-0", True), ("create", "fleet-1", True), ("create", "fleet-2", True)])
        self.assertEqual(self.fake.vms["fleet-1"]["tags"], ["fleet-fleet", "web"])
        self.assertEqual(self.fake.vms["fleet-1"]["comment"], "runtime fleet")
        second = self.call("POST", "/fleet/reconcile", query=name)
        self.assertTrue(second["converged"], second)
        self.assertEqual(second["results"], [])

        # Grow by two, and reconcile from two callers at once: each VM is
        # created exactly once.
        spec["size"] = 5
        self.call("POST", "/fleet/configure", {"spec": spec}, name)
        before = self.fake.count("new")
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.call("POST", "/fleet/reconcile", query=name)))
                   for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(self.fake.count("new") - before, 2)
        created = [w for entry in self.fake.log if entry["path"] == "new" for w in entry["words"] if w.startswith("--name=")]
        self.assertEqual(sorted(set(created) & {"--name=fleet-3", "--name=fleet-4"}), ["--name=fleet-3", "--name=fleet-4"])
        self.assertEqual(created.count("--name=fleet-3"), 1)

        # A new whose answer is lost is adopted, not repeated.
        spec["size"] = 6
        self.call("POST", "/fleet/configure", {"spec": spec}, name)
        self.fake.fail_next("new", 504, execute=True)
        lost = self.call("POST", "/fleet/reconcile", query=name)
        self.assertEqual([(r["action"]["vm"], r["ok"]) for r in lost["results"]], [("fleet-5", True)])
        self.assertIn("adopted", lost["results"][0]["note"])
        self.assertIn("fleet-5", self.fake.vms)

        # The ledger and spec are durable.
        self.runtime.restart()
        status = self.call("GET", "/fleet/status", query=name)
        self.assertEqual(status["spec"]["size"], 6)
        self.assertEqual(sorted(entry["name"] for entry in status["ledger"]),
                         [f"fleet-{index}" for index in range(6)])
        self.assertIsNone(status["lease"])
        self.assertTrue(self.call("POST", "/fleet/reconcile", query=name)["converged"])

        # Shrinking with prune deletes only the fleet's surplus.
        spec.update(size=2, prune=True)
        self.call("POST", "/fleet/configure", {"spec": spec}, name)
        pruned = self.call("POST", "/fleet/reconcile", query=name)
        self.assertEqual(sorted(r["action"]["vm"] for r in pruned["results"] if r["action"]["kind"] == "delete"),
                         ["fleet-2", "fleet-3", "fleet-4", "fleet-5"])
        self.assertEqual(sorted(vm for vm in self.fake.vms if vm.startswith("fleet-")), ["fleet-0", "fleet-1"])

        # requestReconcile runs through the alarm.
        spec.update(size=3)
        self.call("POST", "/fleet/configure", {"spec": spec}, name)
        self.call("POST", "/fleet/request", query=name)
        self.runtime.until(lambda: "fleet-2" in self.fake.vms, 20, "alarm reconcile")

    def test_a_workflow_provisions_bootstraps_and_verifies_once(self):
        first = self.run_workflow("wf-a", "wf-0")
        self.assertEqual(first["provisioned"]["value"]["created"], True, first)
        self.assertEqual(first["running"], {"ok": True, "value": "running"})
        self.assertEqual(first["inline"]["value"], {"exitCode": 0, "skipped": False, "output": "inline done\n"})
        self.assertEqual(first["detached"]["value"], {"exitCode": 0, "skipped": False, "output": "detached done\n"})
        self.assertEqual(first["verified"]["value"]["passed"], True, first["verified"])
        home = self.fake.vms["wf-0"]["home"]
        self.assertTrue((home / ".exedev" / "bootstrap" / "inline-v1.done").exists())
        self.assertTrue((home / ".exedev" / "bootstrap" / "detached-v1.done").exists())
        news = self.fake.count("new")
        second = self.run_workflow("wf-b", "wf-0")
        self.assertEqual(second["provisioned"]["value"]["created"], False)
        self.assertEqual(second["inline"]["value"]["skipped"], True)
        self.assertEqual(second["detached"]["value"]["skipped"], True)
        self.assertEqual(self.fake.count("new"), news)

    def run_workflow(self, instance, vm):
        self.call("POST", "/workflow", {"id": instance, "vm": vm})
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            status = self.call("GET", f"/workflow?id={instance}")
            if status["status"] == "complete":
                return status["output"]
            if status["status"] in ("errored", "terminated"):
                raise AssertionError(f"workflow {instance}: {status}\n{self.runtime.logs()}")
            time.sleep(0.2)
        raise AssertionError(f"workflow {instance} did not finish\n{self.runtime.logs()}")


def interrupted(signum, _frame):
    """Unwind unittest cleanups before exiting on runner cancellation."""
    raise KeyboardInterrupt(f"received signal {signum}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: runtime_test.py CELLD PROJECT")
    CELLD, PROJECT = (Path(value).resolve() for value in sys.argv[1:])
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    unittest.main(argv=[sys.argv[0]], verbosity=2)
