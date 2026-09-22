# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Machinery for driving a celld application on a real fleet under injected faults.

An application's `celld dev` runtime test decides whether it implements its rules
on the runtime. These tests decide whether it keeps them when the storage underneath
celld misbehaves: a fleet node proves every acknowledged write through the
bucket, so an S3 that returns errors, commits a mutation and then reports a
failure, truncates a body, or vanishes entirely is the adversary that matters.

The pieces:

  - `Chaos3` runs the in-memory S3 with a pinned fault seed, either an exact
    `--failpoint` schedule or a `--chaos storage-v1` campaign, and parses the
    coverage reports it prints so a test can refuse to pass vacuously.
  - `Proxy` is a forward proxy on loopback, because celld will be deployed
    where its only route to S3 is one. It has its own seeded faults and an
    outage switch.
  - `Node` is one `celld` fleet process with its own working directory, and
    `Supervisor` restarts it the way a real supervisor would: only after a
    whole lease lifetime has passed.
  - `Fleet` owns a chaos3, an optional proxy, one deployment, and N nodes, and
    turns any failure into a message carrying every seed and log.
  - `resilient`, `encode`, `decode`, and `FleetTestCase` are what an application's
    own client and workload build on; the journal and wormspace each keep theirs
    beside their scenarios and pick the `Fleet` subclass with `fleet_class`.

Everything is loopback, bounded, and stdlib only. Child environments are built
from scratch rather than inherited, so an ambient `AWS_*`, `CELLD_*`, or proxy
variable cannot reach a node.
"""

import base64
import http.client
import json
import os
from pathlib import Path
import random
import re
import select
import shutil
import signal
import socket
import socketserver
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

# Bound to the three paths Buck hands the scenario runner, by `main`.
CELLD = CHAOS3 = PROJECT = None

# Every child sees exactly these, plus what a helper adds deliberately.
INHERITED_PREFIXES = ("CELLD_", "AWS_", "S3_")
INHERITED_NAMES = (
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "RUST_LOG",
)

CREDENTIALS = {
    "AWS_ACCESS_KEY_ID": "chaos3",
    "AWS_SECRET_ACCESS_KEY": "chaos3",
    "AWS_REGION": "us-east-1",
}


def base_environment():
    """A child environment with every ambient storage and proxy knob removed."""
    environment = {
        key: value for key, value in os.environ.items()
        if not key.startswith(INHERITED_PREFIXES) and key not in INHERITED_NAMES
    }
    environment["NO_COLOR"] = "1"
    return environment


def free_port():
    """Reserve a kernel-chosen loopback port and release it immediately.

    celld's `--listen` needs a concrete port to keep one origin across
    restarts. The gap between release and bind is a race the bounded readiness
    wait reports rather than hides.
    """
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def tail(text, lines=60):
    """The last lines of a log, for an assertion message."""
    kept = text.splitlines()[-lines:]
    return "\n".join(kept)


class Unreachable(Exception):
    """The service could not be reached at all: no status code was produced."""


class Chaos3:
    """One chaos3 process: the fleet's bucket, and the fault injector."""

    def __init__(self, binary, root, bucket, *, failpoints=(), seed=None,
                 chaos=None, warmup=None, requests=None, trace=True):
        self.root = Path(root)
        self.bucket = bucket
        self.log_path = self.root / "chaos3.log"
        command = [str(binary), "--listen", "127.0.0.1:0", "--bucket", bucket]
        for failpoint in failpoints:
            command += ["--failpoint", failpoint]
        if seed is not None:
            command += ["--fault-seed", str(seed)]
        if chaos is not None:
            command += ["--chaos", chaos]
            if warmup is not None:
                command += ["--chaos-warmup-requests", str(warmup)]
            if requests is not None:
                command += ["--chaos-requests", str(requests)]
            if trace:
                command += ["--chaos-trace"]
        read_fd, write_fd = os.pipe()
        command += ["--ready-fd", str(write_fd)]
        self.command = command
        self.log = self.log_path.open("w")
        try:
            # The descriptor number is the argument, so chaos3 must inherit that
            # exact fd; Python closes its own copy once the child has it.
            self.process = subprocess.Popen(
                command, stdin=subprocess.DEVNULL, stdout=self.log,
                stderr=subprocess.STDOUT, pass_fds=[write_fd],
                env=base_environment(), cwd=str(self.root),
            )
        finally:
            os.close(write_fd)
        try:
            self.endpoint = self._read_ready(read_fd, 30)
        except BaseException:
            self.stop()
            raise
        finally:
            os.close(read_fd)

    def _read_ready(self, read_fd, seconds):
        """Read the announced endpoint, bounded, without blocking forever."""
        deadline = time.monotonic() + seconds
        announced = b""
        os.set_blocking(read_fd, False)
        while b"\n" not in announced:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"chaos3 never announced readiness:\n{self.logs()}")
            ready, _, _ = select.select([read_fd], [], [], min(remaining, 0.25))
            if ready:
                chunk = os.read(read_fd, 4096)
                if not chunk:
                    break
                announced += chunk
            elif self.process.poll() is not None:
                raise AssertionError(f"chaos3 exited during startup:\n{self.logs()}")
        endpoint = announced.decode().strip()
        if not endpoint.startswith("http://"):
            raise AssertionError(f"chaos3 announced {endpoint!r}:\n{self.logs()}")
        return endpoint

    def logs(self):
        """Read diagnostics without draining a pipe or blocking the child."""
        try:
            return self.log_path.read_text(errors="replace")
        except OSError:
            return ""

    def seed(self):
        """The effective fault seed, as chaos3 logged it."""
        found = re.findall(r"^chaos3 fault seed: (\d+)$", self.logs(), re.MULTILINE)
        return int(found[-1]) if found else None

    def coverage(self):
        """The most recent campaign report, or None when chaos is not running.

        The counters record effects chaos3 *selected* at boundaries it reached.
        They are the only evidence that a passing workload actually met faults.
        """
        reports = re.findall(r"^chaos3 chaos: (.*)$", self.logs(), re.MULTILINE)
        if not reports:
            return None
        report = {}
        for field in reports[-1].split():
            key, _, value = field.partition("=")
            report[key] = int(value) if value.isdigit() else value
        return report

    def traces(self):
        """Every `--chaos-trace` line, for mapping a failure back to a boundary."""
        return re.findall(r"^chaos3 chaos trace: (.*)$", self.logs(), re.MULTILINE)

    def trace_actions(self, boundary=None, action=None):
        """Count traced decisions, narrowed to one boundary and kind of effect.

        The campaign counters say how many effects were selected; the trace
        says *where*. That distinction is the whole point of a coverage check
        here, because celld absorbs most of what chaos3 injects: a workload can
        see nothing but `200`s while the write path was being attacked
        throughout, so "the client saw an error" measures celld's retries, not
        the campaign's reach.
        """
        total = 0
        for line in self.traces():
            fields = dict(item.split("=", 1) for item in line.split() if "=" in item)
            if boundary is not None and fields.get("boundary") != boundary:
                continue
            if action is not None and not fields.get("action", "").startswith(action):
                continue
            total += 1
        return total

    def s3_get_probe(self, key, timeout=30):
        """GET one object and report a short body instead of raising.

        A `s3.get_object.body` truncation is a `200` with a `Content-Length`
        the body never reaches, which is exactly what a client must notice; a
        returned length below the declared one is that observation.
        """
        url = f"{self.endpoint}/{self.bucket}/{key}"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(urllib.request.Request(url, method="GET"), timeout=timeout) as reply:
                declared = int(reply.headers.get("Content-Length", -1))
                try:
                    return reply.status, len(reply.read()), declared
                except http.client.IncompleteRead as short:
                    return reply.status, len(short.partial), declared
        except urllib.error.HTTPError as error:
            with error:
                error.read()
            return error.code, 0, -1
        except Exception:  # noqa: BLE001 - a cut connection is an observation
            return None, 0, -1

    def s3_request(self, method, key, body=None, timeout=30):
        """One anonymous S3 request straight at chaos3, bypassing celld.

        chaos3 gives a counted failpoint no counter of its own, so this is how a
        test sees one: when the plan's budget is spent, the request celld was
        being failed on succeeds, and while budget remains it still fails.
        """
        url = f"{self.endpoint}/{self.bucket}/{key}"
        request = urllib.request.Request(url, data=body, method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.read()

    def wait_recovered(self, seconds, drive=False):
        """Wait for a finite campaign to reach recovery with nothing in flight.

        A phase transition does not cancel outstanding requests, so auditing
        recovered state before the drain report would race them. `drive` spends
        the campaign's remaining admissions on the test's own probes instead of
        waiting for celld's background traffic to spend them.
        """
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            report = self.coverage()
            if report and report["phase"] == "recovery" and report["in_flight"] == 0:
                return report
            if self.process.poll() is not None:
                raise AssertionError(f"chaos3 exited before recovery:\n{self.logs()}")
            if drive:
                # Spend the campaign's remaining admissions quickly rather than
                # waiting on celld's once-a-second background traffic.
                for _ in range(25):
                    self.s3_request("HEAD", "campaign-drain", timeout=10)
            else:
                time.sleep(0.25)
        raise AssertionError(
            f"chaos3 campaign did not drain within {seconds}s "
            f"(seed {self.seed()}, last report {self.coverage()})"
        )

    def stop(self):
        process = getattr(self, "process", None)
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if self.log is not None:
            self.log.close()
            self.log = None

    def diagnostics(self):
        # The command line first: it is the one thing that reproduces the run.
        return (f"chaos3 $ {' '.join(self.command)}\n"
                f"chaos3 seed={self.seed()} endpoint={self.endpoint} "
                f"coverage={self.coverage()}\n--- chaos3 log ---\n{tail(self.logs(), 40)}")


class _ProxyServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    # A failing handler is a fault the test asserts on, not a crash to print.
    def handle_error(self, request, client_address):
        pass


class Proxy:
    """A seeded, controllable HTTP forward proxy between celld and chaos3.

    celld reaches S3 through `HTTP_PROXY`, so the proxy is a real part of the
    failure surface: it can reset a connection after reading the request (the
    ambiguous case, because the request may already be upstream), answer `502`
    without forwarding, stall, or refuse to talk at all.

    A plan is `{"reset": p, "error": p, "delay_ms": (p, milliseconds)}`, whose
    probabilities are cumulative over one draw, so a connection gets at most
    one of them. Decisions come from `random.Random(seed ^ ordinal * K)`, so
    which connection gets which fault depends only on its ordinal and never on
    thread scheduling. Which S3 request lands on which ordinal does depend on
    celld, which is why tests assert coverage rather than an exact schedule.
    """

    SALT = 0x9E3779B97F4A7C15
    MAX_LINES = 400

    def __init__(self, seed=0, plan=None):
        self.seed = seed
        self.plan = dict(plan or {})
        self.lock = threading.Lock()
        self.mode = "normal"
        self.generation = 0
        self.connections = 0
        self.forwarded = 0
        self.resets = 0
        self.errors = 0
        self.delays = 0
        self.stalled = 0
        self.refused = 0
        self.lines = []
        self.server = _ProxyServer(("127.0.0.1", 0), _ProxyHandler)
        self.server.proxy = self
        self.url = "http://127.0.0.1:{}".format(self.server.server_address[1])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def set_mode(self, mode):
        """Switch the outage state, aborting whatever is in flight."""
        assert mode in ("normal", "refuse", "stall"), mode
        with self.lock:
            self.mode = mode
            self.generation += 1

    def admit(self):
        """Take one connection's ordinal, mode, and generation, atomically."""
        with self.lock:
            self.connections += 1
            return self.connections, self.mode, self.generation

    def decide(self, ordinal):
        """The fault this connection ordinal draws, independent of scheduling."""
        if not self.plan:
            return None, 0.0
        choices = random.Random(self.seed ^ (ordinal * self.SALT))
        roll = choices.random()
        threshold = 0.0
        for action in ("reset", "error", "delay_ms"):
            setting = self.plan.get(action)
            if setting is None:
                continue
            probability = setting[0] if isinstance(setting, tuple) else setting
            threshold += probability
            if roll < threshold:
                if action == "delay_ms":
                    return "delay", setting[1] / 1000.0
                return action, 0.0
        return None, 0.0

    def count(self, field, line=None):
        with self.lock:
            setattr(self, field, getattr(self, field) + 1)
            if line is not None and len(self.lines) < self.MAX_LINES:
                self.lines.append(line)

    def aborted(self, generation):
        with self.lock:
            return self.generation != generation

    def counters(self):
        with self.lock:
            return {
                "connections": self.connections, "forwarded": self.forwarded,
                "resets": self.resets, "errors": self.errors,
                "delays": self.delays, "stalled": self.stalled,
                "refused": self.refused,
            }

    def requests(self):
        with self.lock:
            return list(self.lines)

    def stop(self):
        self.set_mode("normal")
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)

    def diagnostics(self):
        sample = self.requests()
        return ("proxy seed={} plan={} counters={}\n--- proxy requests (first {}) ---\n{}"
                .format(self.seed, self.plan, self.counters(), len(sample[:15]),
                        "\n".join(sample[:15])))


class _ProxyHandler(socketserver.BaseRequestHandler):
    """One client connection; `Connection: close` keeps it to one request."""

    POLL = 0.25

    def handle(self):
        proxy = self.server.proxy
        ordinal, mode, generation = proxy.admit()
        client = self.request
        client.settimeout(self.POLL)
        if mode == "refuse":
            proxy.count("refused")
            return
        if mode == "stall":
            proxy.count("stalled")
            self._hold(proxy, generation)
            return

        head = self._read_head(client)
        if head is None:
            return
        head, rest = head
        lines = head.decode("latin-1").split("\r\n")
        try:
            method, target, version = lines[0].split(" ", 2)
        except ValueError:
            return
        if method == "CONNECT":
            client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n"
                           b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            return
        if not target.startswith("http://"):
            client.sendall(b"HTTP/1.1 400 Bad Request\r\n"
                           b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            return

        action, seconds = proxy.decide(ordinal)
        if action == "reset":
            # The request head is read and discarded: from celld's side this is
            # indistinguishable from a request lost in flight.
            proxy.count("resets", lines[0][:160])
            return
        if action == "error":
            proxy.count("errors", lines[0][:160])
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n"
                           b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            return
        if action == "delay":
            proxy.count("delays")
            time.sleep(seconds)
            if proxy.aborted(generation):
                return

        proxy.count("forwarded", lines[0][:160])
        self._forward(proxy, generation, client, target, method, version, lines, rest)

    def _hold(self, proxy, generation):
        """Accept and answer nothing until the outage window ends."""
        while not proxy.aborted(generation):
            time.sleep(0.05)

    def _read_head(self, client):
        buffered = b""
        deadline = time.monotonic() + 30
        while b"\r\n\r\n" not in buffered:
            if time.monotonic() > deadline:
                return None
            try:
                chunk = client.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                return None
            if not chunk:
                return None
            buffered += chunk
        return tuple(buffered.split(b"\r\n\r\n", 1))

    def _forward(self, proxy, generation, client, target, method, version, lines, rest):
        hostport, _, path = target[len("http://"):].partition("/")
        host, _, port = hostport.partition(":")
        headers = [line for line in lines[1:]
                   if not line.lower().startswith(("connection:", "proxy-connection:"))]
        head = "\r\n".join([f"{method} /{path} {version}"] + headers +
                           ["Connection: close"]) + "\r\n\r\n"
        try:
            upstream = socket.create_connection((host, int(port or 80)), timeout=10)
        except OSError:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n"
                           b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            return
        upstream.settimeout(self.POLL)
        try:
            upstream.sendall(head.encode("latin-1") + rest)
            worker = threading.Thread(target=self._pump, daemon=True,
                                      args=(proxy, generation, client, upstream))
            worker.start()
            self._pump(proxy, generation, upstream, client)
            # One request per connection, so the response ending ends the
            # exchange; closing upstream releases a still-reading body pump.
            worker.join(timeout=1)
        except OSError:
            pass
        finally:
            upstream.close()

    def _pump(self, proxy, generation, source, sink):
        """Copy until EOF, an error, or the outage switch moves."""
        try:
            while not proxy.aborted(generation):
                try:
                    chunk = source.recv(65536)
                except socket.timeout:
                    continue
                if not chunk:
                    break
                sink.sendall(chunk)
        except OSError:
            pass
        finally:
            try:
                sink.shutdown(socket.SHUT_WR)
            except OSError:
                pass


class Node:
    """One celld fleet node: its own working directory, port, and log."""

    PROBE = "readiness-probe"
    READY_PATH = f"/v1/logs/{PROBE}"

    def __init__(self, celld, root, name, endpoint, bucket, *, proxy=None,
                 ttl_ms=3000, deadline_ms=5000, extra_env=None, ready_path=READY_PATH):
        self.celld = Path(celld)
        # Any GET route that answers 200 once the node serves; another service
        # reusing this harness passes its own.
        self.ready_path = ready_path
        self.name = name
        self.root = Path(root) / name
        self.root.mkdir(parents=True, exist_ok=True)
        self.log_path = Path(root) / f"{name}.log"
        self.log_path.write_text("")
        self.port = free_port()
        self.origin = f"http://127.0.0.1:{self.port}"
        self.command = [
            str(self.celld), "--bucket", f"s3://{bucket}", "--endpoint", endpoint,
            "--region", "us-east-1", "--listen", f"127.0.0.1:{self.port}",
            "--internal-listen", "127.0.0.1:0",
        ]
        self.environment = base_environment()
        self.environment.update(CREDENTIALS)
        self.environment["CELLD_WATCH"] = str(self.root)
        self.environment["CELLD_TTL_MS"] = str(ttl_ms)
        self.environment["CELLD_OPERATION_DEADLINE_MS"] = str(deadline_ms)
        if proxy is not None:
            self.environment["HTTP_PROXY"] = proxy.url
            self.environment["http_proxy"] = proxy.url
        self.environment.update(extra_env or {})
        self.ttl_ms = ttl_ms
        self.process = None
        self.log = None
        self.starts = 0
        self.exits = []

    def start(self):
        """Run a fresh node session against the same working directory."""
        assert self.process is None or self.process.poll() is not None
        self.starts += 1
        # A restart is a new node session, as it would be under a supervisor;
        # the durable state is the bucket and the working directory.
        environment = dict(self.environment, CELLD_NODE=f"{self.name}-{self.starts}")
        self.log = self.log_path.open("a")
        self.log.write(f"\n=== start {self.starts} at {time.time():.3f} ===\n")
        self.log.flush()
        self.process = subprocess.Popen(
            self.command, stdin=subprocess.DEVNULL, stdout=self.log,
            stderr=subprocess.STDOUT, env=environment, cwd=str(self.root),
        )
        return self

    def logs(self):
        try:
            return self.log_path.read_text(errors="replace")
        except OSError:
            return ""

    def running(self):
        return self.process is not None and self.process.poll() is None

    def exit_code(self):
        return None if self.process is None else self.process.poll()

    def self_fenced(self):
        """A node that lost the bucket fences itself and exits 3."""
        return "SELF-FENCE:" in self.logs()

    def wait_ready(self, seconds=90):
        """Poll the readiness route: 200 means this node serves requests."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        url = f"{self.origin}{self.ready_path}"
        deadline = time.monotonic() + seconds
        last = None
        while time.monotonic() < deadline:
            code = self.exit_code()
            if code is not None:
                raise AssertionError(
                    f"node {self.name} exited {code} before serving:\n{tail(self.logs())}")
            try:
                with opener.open(url, timeout=5) as response:
                    if response.status == 200:
                        response.read()
                        return self
            except Exception as error:  # noqa: BLE001 - any failure is "not yet"
                last = error
            time.sleep(0.2)
        raise AssertionError(
            f"node {self.name} was not ready within {seconds}s (last {last!r}):\n"
            f"{tail(self.logs())}")

    def stop(self, seconds=40):
        """Graceful stop; upstream bounds its own shutdown at 35 seconds."""
        if self.running():
            self.process.terminate()
            try:
                self.process.wait(timeout=seconds)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
                raise AssertionError(
                    f"node {self.name} did not stop gracefully:\n{tail(self.logs())}")
        self._close()
        return self

    def kill(self):
        """The crash case: no shutdown, no lease release."""
        if self.running():
            self.process.kill()
            self.process.wait(timeout=10)
        self._close()
        return self

    def _close(self):
        if self.process is not None and self.process.poll() is not None:
            self.exits.append(self.process.poll())
        if self.log is not None:
            self.log.close()
            self.log = None

    def restart(self, fresh=False, ready_timeout=90):
        """Replace the process; `fresh` wipes the local copy of the fleet state.

        A fresh restart is the interesting one: nothing but the bucket carries
        the journal, so everything the test reads afterwards was proven durable.
        """
        if self.running():
            self.stop()
        else:
            self._close()
        if fresh:
            shutil.rmtree(self.root, ignore_errors=True)
            self.root.mkdir(parents=True, exist_ok=True)
        self.start()
        return self.wait_ready(ready_timeout)

    def diagnostics(self):
        return (f"node {self.name} $ {' '.join(self.command)}\n"
                f"node {self.name} origin={self.origin} starts={self.starts} "
                f"exits={self.exits} running={self.running()} "
                f"self_fenced={self.self_fenced()}\n"
                f"--- {self.name} log ---\n{tail(self.logs(), 40)}")


class Supervisor:
    """Restart a node after it dies, never faster than one lease lifetime.

    celld requires that: a node that self-fenced may still hold a lease other
    nodes can see, and restarting inside the lease would race its own ghost.
    """

    def __init__(self, node, ttl_ms=None):
        self.node = node
        self.ttl_ms = node.ttl_ms if ttl_ms is None else ttl_ms
        self.restarts = 0
        self.attempts = 0
        self.fenced = 0
        self.observed_exits = []
        self.died_at = None

    def ensure_ready(self, attempts=5, ready_timeout=90):
        """Bring the node up, restarting after a lease each time it dies trying.

        Startup is not exempt from the faults a test injects: a node whose
        first bucket writes are refused exits, and a supervisor's answer to
        that is the same as to any other death — wait a lease, start it again.
        """
        last = None
        for _ in range(attempts):
            try:
                if self.node.running():
                    return self.node.wait_ready(ready_timeout)
                self.restart_if_dead(ready_timeout)
                return self.node
            except AssertionError as error:
                last = error
                if self.node.running():
                    raise
        raise AssertionError(
            f"node {self.node.name} never served after {attempts} supervised "
            f"attempts; last: {last}")

    def restart_if_dead(self, ready_timeout=90, tolerant=False):
        """Return True when this call brought the node back up.

        `tolerant` is for a supervisor running inside a client's retry loop
        during an outage: it neither blocks out the lease wait nor fails when
        the node cannot come up yet, because the bucket is still unreachable.
        """
        if self.node.running():
            self.died_at = None
            return False
        self._note_death()
        waited = time.monotonic() - self.died_at
        if waited < self.ttl_ms / 1000.0:
            if tolerant:
                return False
            time.sleep(self.ttl_ms / 1000.0 - waited)
        self.node._close()
        self.attempts += 1
        self.node.start()
        try:
            self.node.wait_ready(ready_timeout)
        except AssertionError:
            if not self.node.running():
                # It died trying: the next attempt owes it another lease.
                self.died_at = None
                self._note_death()
            if not tolerant:
                raise
            return False
        self.restarts += 1
        self.died_at = None
        return True

    def _note_death(self):
        """Record one death, including whether the node fenced itself."""
        if self.died_at is not None:
            return
        self.died_at = time.monotonic()
        self.observed_exits.append(self.node.exit_code())
        if self.node.self_fenced():
            self.fenced += 1

    def diagnostics(self):
        return (f"supervisor {self.node.name} restarts={self.restarts} "
                f"attempts={self.attempts} self_fenced={self.fenced} "
                f"exits={self.observed_exits}")


class Fleet:
    """chaos3, an optional proxy, one deployment, and N nodes, as one fixture."""

    def __init__(self, celld, chaos3_binary, project, *, bucket="celld", nodes=1,
                 failpoints=(), seed=None, chaos=None, warmup=None, requests=None,
                 trace=True, proxy=False, proxy_seed=0, proxy_plan=None,
                 ttl_ms=10_000, deadline_ms=15_000, node_env=None,
                 celld_env=None, deploy_through_proxy=True, ready_timeout=90,
                 ready_path=Node.READY_PATH):
        self.celld = Path(celld)
        self.ready_path = ready_path
        self.chaos3_binary = Path(chaos3_binary)
        self.project = Path(project)
        self.bucket = bucket
        self.node_count = nodes
        self.ttl_ms = ttl_ms
        self.deadline_ms = deadline_ms
        self.node_env = dict(node_env or {})
        self.extra_celld_env = dict(celld_env or {})
        self.ready_timeout = ready_timeout
        self.deploy_through_proxy = deploy_through_proxy
        self.temporary = tempfile.TemporaryDirectory(prefix="celld-fleet-")
        self.root = Path(self.temporary.name)
        self.chaos3 = None
        self.proxy = None
        self.nodes = []
        self.supervisors = {}
        self.deploy_result = None
        self.deploy_attempts = 0
        self._settings = dict(
            failpoints=failpoints, seed=seed, chaos=chaos, warmup=warmup,
            requests=requests, trace=trace, proxy=proxy, proxy_seed=proxy_seed,
            proxy_plan=proxy_plan,
        )

    def open(self):
        """Start everything, or clean up and raise. Same as entering it."""
        return self.__enter__()

    def __enter__(self):
        settings = self._settings
        try:
            self.chaos3 = Chaos3(
                self.chaos3_binary, self.root, self.bucket,
                failpoints=settings["failpoints"], seed=settings["seed"],
                chaos=settings["chaos"], warmup=settings["warmup"],
                requests=settings["requests"], trace=settings["trace"],
            )
            if settings["proxy"]:
                self.proxy = Proxy(seed=settings["proxy_seed"], plan=settings["proxy_plan"])
            self.deploy()
            for index in range(self.node_count):
                self.add_node(chr(ord("a") + index))
            for node in self.nodes:
                self.supervisor(node).ensure_ready(ready_timeout=self.ready_timeout)
        except BaseException:
            self.close()
            raise
        return self

    def __exit__(self, *_exception):
        self.close()
        return False

    def celld_env(self, through_proxy=True):
        environment = base_environment()
        environment.update(CREDENTIALS)
        if self.proxy is not None and through_proxy:
            environment["HTTP_PROXY"] = self.proxy.url
            environment["http_proxy"] = self.proxy.url
        environment.update(self.extra_celld_env)
        return environment

    def bucket_args(self):
        return ["--bucket", f"s3://{self.bucket}", "--endpoint", self.chaos3.endpoint,
                "--region", "us-east-1"]

    def deploy(self, timeout=180, attempts=8):
        """Publish the packaged project into the bucket; nodes adopt it.

        `celld deploy` 0.5.1 does not retry its own conditional writes: one
        injected `SlowDown` on the bucket ends it with "may have committed".
        Retrying a whole deploy is what an operator does with that message, and
        the command is idempotent, so the fixture does exactly that and records
        how many attempts the injected faults cost.
        """
        command = [str(self.celld), "deploy", str(self.project), "--json", *self.bucket_args()]
        transcript = []
        for attempt in range(1, attempts + 1):
            result = subprocess.run(
                command, env=self.celld_env(self.deploy_through_proxy), cwd=str(self.root),
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout,
            )
            transcript.append(f"$ {' '.join(command)}\nattempt {attempt} rc={result.returncode}\n"
                              f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}\n")
            (self.root / "deploy.log").write_text("\n".join(transcript))
            if result.returncode == 0:
                self.deploy_attempts = attempt
                self.deploy_result = json.loads(result.stdout.strip().splitlines()[-1])
                return self.deploy_result
            time.sleep(0.5)
        raise AssertionError(f"celld deploy failed {attempts} times:\n"
                             f"{tail(transcript[-1])}\n{self.diagnostics()}")

    def diagnose(self, timeout=120):
        """Run `celld diagnose --json`, returning one dict per check."""
        command = [str(self.celld), "diagnose", "--json", *self.bucket_args()]
        result = subprocess.run(
            command, env=self.celld_env(), cwd=str(self.root), stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=timeout,
        )
        checks = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        return result.returncode, checks, result.stderr

    def add_node(self, name, *, ready=False, extra_env=None):
        node = Node(
            self.celld, self.root, name, self.chaos3.endpoint, self.bucket,
            proxy=self.proxy, ttl_ms=self.ttl_ms, deadline_ms=self.deadline_ms,
            extra_env=dict(self.node_env, **(extra_env or {})),
            ready_path=self.ready_path,
        )
        self.nodes.append(node)
        node.start()
        if ready:
            node.wait_ready(self.ready_timeout)
        return node

    def node(self, index=0):
        return self.nodes[index]

    def supervisor(self, node=None, index=0):
        """The one supervisor for a node, created on first use."""
        node = node or self.nodes[index]
        return self.supervisors.setdefault(node.name, Supervisor(node))

    def diagnostics(self):
        """Everything needed to reproduce and to read a failure."""
        parts = [f"fleet bucket={self.bucket} deploy_attempts={self.deploy_attempts} "
                 f"ttl_ms={self.ttl_ms} deadline_ms={self.deadline_ms}"]
        if self.chaos3 is not None:
            parts.append(self.chaos3.diagnostics())
        if self.proxy is not None:
            parts.append(self.proxy.diagnostics())
        for node in self.nodes:
            parts.append(node.diagnostics())
            supervisor = self.supervisors.get(node.name)
            if supervisor is not None:
                parts.append(supervisor.diagnostics())
        return "\n\n".join(parts)

    def close(self):
        errors = []
        for node in self.nodes:
            try:
                node.stop()
            except BaseException as error:  # noqa: BLE001 - cleanup must continue
                errors.append(error)
        if self.proxy is not None:
            try:
                self.proxy.stop()
            except BaseException as error:  # noqa: BLE001
                errors.append(error)
        if self.chaos3 is not None:
            self.chaos3.stop()
        self.temporary.cleanup()
        if errors:
            raise errors[0]


# What a client must treat as "ask again". 503 is the documented UNAVAILABLE,
# which an application's edge answers for celld's routing error, for the peer
# tunnel to an owner that just died, and for a write it could not prove
# durable. 500 INTERNAL is deliberately absent: the README calls it a bug, so
# under injected faults it is a throw nobody has classified, and the run must
# fail on it rather than quietly retry past it.
RETRYABLE_STATUSES = (502, 503, 504)


def resilient(call, *args, budget=120.0, pause=0.25, **kwargs):
    """Repeat one journal call until it answers something that is not transient.

    Only operations the README makes safe to repeat go through this: `status`
    and `read` are pure, `recordSnapshot` and `trim` are idempotent and never
    move a mark backwards, and `acquireLease` by the candidate that already
    holds the lease is a renewal that keeps the term. `append` does not: it
    goes through `Writer`, which carries `expectedNextSeq`.
    """
    deadline = time.monotonic() + budget
    seen = []
    while True:
        try:
            status, body = call(*args, **kwargs)
        except Unreachable as error:
            status, body = None, error
        if status is not None and status not in RETRYABLE_STATUSES:
            return status, body
        seen.append(status)
        if time.monotonic() > deadline:
            raise AssertionError(
                f"{getattr(call, '__name__', call)} never settled in {budget}s; "
                f"saw {seen}; last {body}")
        time.sleep(pause)


def encode(payload):
    return base64.b64encode(payload).decode()


def decode(text):
    return base64.b64decode(text)


class FleetTestCase(unittest.TestCase):
    """A test whose failures carry every seed and log the fleet produced.

    `_callTestMethod` is the one hook that sees the whole test body, so no
    assertion anywhere — in a test or in this module's helpers — can report a
    failure without the chaos3 seed, the campaign coverage, the proxy counters,
    and each node's log tail needed to reproduce it.
    """

    fleet = None
    # The application's Fleet subclass, when it adds a client of its own.
    fleet_class = Fleet

    def _callTestMethod(self, method):
        try:
            method()
        except AssertionError as error:
            raise AssertionError(f"{error}\n\n{self.diagnostics()}") from None
        except Exception as error:
            raise AssertionError(
                f"{type(error).__name__}: {error}\n\n{self.diagnostics()}") from error

    def diagnostics(self):
        if self.fleet is None:
            return "(no fleet)"
        try:
            return self.fleet.diagnostics()
        except Exception as error:  # noqa: BLE001 - diagnosis must not mask a failure
            return f"(diagnostics unavailable: {error!r})"

    def log_name(self):
        """A distinct, well-formed cell name per test method."""
        return self.id().rsplit(".", 1)[-1].replace("_", "-")

    def expect(self, response, status, code=None):
        """Assert one reply's status and code, showing the whole body on failure."""
        self.assertEqual(response[0], status, response)
        if code is not None:
            self.assertEqual(response[1].get("code"), code, response)
        return response[1]

    def use_fleet(self, **kwargs):
        """One fleet for this test method alone, torn down even on failure."""
        self.fleet = self.fleet_class(CELLD, CHAOS3, PROJECT, **kwargs).open()
        self.addCleanup(self.fleet.close)
        return self.fleet

    @classmethod
    def start_fleet(cls, **kwargs):
        """Own one fleet for the whole class, torn down even on failure."""
        cls.fleet = cls.fleet_class(CELLD, CHAOS3, PROJECT, **kwargs).open()
        cls.addClassCleanup(cls.fleet.close)
        return cls.fleet


def interrupted(signum, _frame):
    """Unwind unittest cleanups before exiting on runner cancellation."""
    raise KeyboardInterrupt(f"received signal {signum}")


def main(argv):
    """Bind the three Buck-supplied paths and run the module's tests."""
    global CELLD, CHAOS3, PROJECT
    if len(argv) != 4:
        raise SystemExit(f"usage: {Path(argv[0]).name} CELLD CHAOS3 PROJECT")
    CELLD, CHAOS3, PROJECT = (Path(value).resolve() for value in argv[1:])
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    unittest.main(argv=[argv[0]], verbosity=2)
