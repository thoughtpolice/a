# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run @celld/api/openai inside a real celld dev supervisor against a fake Codex backend.

Buck provides the pinned CLI and the packaged test project
(tests/runtime/worker.ts). The Deno suites decide whether the library's rules
are right; this one decides whether they hold on the runtime: server-sent
events streamed over real fetch in pieces, a stream broken off and retried,
idle timeouts, the GptPacer Durable Object serialising calls and holding every
caller after a usage limit (across a supervisor restart), conversations
persisted in GptConversations with encrypted reasoning replayed, and an agent
run as a Workflow. A small HTTP server in this process stands in for the
integration at https://llm.int.exe.xyz/openai/v1; it checks every request for
the invariants the ChatGPT backend needs. No network or account is involved.

LocalRuntime is the toolchain's helper from
buck/toolchains/celld/tests/runtime_test.py, as copied by jev and the journal.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
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


def invariant_problems(body, headers):
    """What the ChatGPT backend (per the Codex client) would refuse or misread."""
    problems = []
    if body.get("stream") is not True:
        problems.append("stream must be true")
    if body.get("store") is not False:
        problems.append("store must be false")
    if "reasoning.encrypted_content" not in body.get("include", []):
        problems.append("include must ask for reasoning.encrypted_content")
    for banned in ("previous_response_id", "max_output_tokens", "temperature", "top_p"):
        if banned in body:
            problems.append(f"{banned} is not supported")
    key = body.get("prompt_cache_key")
    if not key:
        problems.append("prompt_cache_key is missing")
    elif headers.get("session-id") != key:
        problems.append("session-id must carry the prompt cache key")
    if headers.get("accept") != "text/event-stream":
        problems.append("accept must be text/event-stream")
    if headers.get("authorization") is not None:
        problems.append("the integration injects credentials; the VM sends none")
    items = body.get("input", [])
    if body.get("model", "").startswith("gpt-6"):
        if not items or items[0].get("type") != "additional_tools":
            problems.append("lite encoding: input must start with additional_tools")
        if len(items) < 2 or items[1].get("role") != "developer":
            problems.append("lite encoding: the instructions must follow as a developer message")
        if "instructions" in body or "tools" in body:
            problems.append("lite encoding: no top-level instructions or tools")
        if body.get("parallel_tool_calls") is not False:
            problems.append("lite encoding: parallel tool calls are off")
        if body.get("reasoning", {}).get("context") != "all_turns":
            problems.append("lite encoding: reasoning.context is all_turns")
    elif not body.get("instructions"):
        problems.append("instructions are required")
    return problems


def last_user_text(items):
    for item in reversed(items):
        if item.get("type") == "message" and item.get("role") == "user":
            for part in item.get("content", []):
                if part.get("type") == "input_text":
                    return part["text"]
    return ""


class FakeCodex:
    """Answer the Responses API the way the Codex backend streams it.

    The last user message picks a scenario: "hello" streams text in pieces
    with rate-limit headers; "flaky:<id>" breaks the stream off the first time
    an id is seen; "hang" stalls after response.created; "slow:<id>" takes
    half a second (to measure concurrency); "usage:<id>" answers 429
    usage_limit_reached; "json" answers structured output; "agent:..." calls
    the lookup tool, then answers with its result once the encrypted
    reasoning comes back. Every request is recorded.
    """

    def __init__(self):
        self.requests = []
        self.seen = set()
        self.lock = threading.Lock()
        self.in_flight = 0
        self.max_in_flight = 0
        self.counter = 0
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body, headers=()):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                for name, value in headers:
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

            def start_stream(self, headers=()):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("x-request-id", f"req-{fake.counter}")
                self.send_header("openai-model", "gpt-6-astra-2026-09-01")
                for name, value in headers:
                    self.send_header(name, value)
                self.end_headers()

            def send_events(self, events, pause=0.0):
                for event in events:
                    frame = f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()
                    # Split each event across two writes so the client reassembles.
                    self.wfile.write(frame[: len(frame) // 2])
                    self.wfile.flush()
                    self.wfile.write(frame[len(frame) // 2:])
                    self.wfile.flush()
                    if pause:
                        time.sleep(pause)

            def do_GET(self):
                if self.path.endswith("/models"):
                    return self.reply(200, {"object": "list", "data": [
                        {"id": "gpt-6-astra", "object": "model"},
                        {"id": "gpt-5.5", "object": "model"},
                    ]})
                return self.reply(404, {"error": {"message": "not found"}})

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                body = json.loads(self.rfile.read(length))
                headers = {name.lower(): value for name, value in self.headers.items()}
                text = last_user_text(body.get("input", []))
                with fake.lock:
                    fake.counter += 1
                    fake.requests.append({"path": self.path, "body": body, "headers": headers, "text": text})
                    first = text not in fake.seen
                    fake.seen.add(text)
                if not self.path.endswith("/openai/v1/responses"):
                    return self.reply(404, {"error": {"message": f"no route {self.path}"}})
                problems = invariant_problems(body, headers)
                if problems:
                    return self.reply(400, {"error": {"message": "; ".join(problems), "code": "invalid_request_error"}})
                try:
                    return self.scenario(body, text, first)
                except OSError:
                    return None  # The client gave up and closed the socket.

            def scenario(self, body, text, first):
                rid = f"resp_{fake.counter}"
                model = body["model"]
                if text.startswith("usage:"):
                    return self.reply(429, {"error": {
                        "type": "usage_limit_reached",
                        "message": "You've hit your usage limit.",
                        "plan_type": "pro",
                        "resets_at": int(time.time()) + 3600,
                    }}, [("x-codex-primary-used-percent", "100"), ("x-codex-primary-window-minutes", "300")])
                if text == "hang":
                    self.start_stream()
                    self.send_events([created(rid, model)])
                    time.sleep(3)
                    return None
                if text.startswith("flaky:") and first:
                    self.start_stream()
                    self.send_events([created(rid, model), *message(rid, 0, ["never ", "finished"])[:3]])
                    self.wfile.write(b"event: response.output_text.delta\ndata: {\"type\":")
                    self.wfile.flush()
                    self.close_connection = True
                    return None
                if text.startswith("slow:"):
                    with fake.lock:
                        fake.in_flight += 1
                        fake.max_in_flight = max(fake.max_in_flight, fake.in_flight)
                    try:
                        time.sleep(0.5)
                        self.start_stream()
                        self.send_events(complete(rid, model, message(rid, 0, ["slow ", "done"])))
                    finally:
                        with fake.lock:
                            fake.in_flight -= 1
                    return None
                if text == "json":
                    self.start_stream()
                    return self.send_events(complete(rid, model, message(rid, 0, ['{"verdict":', '"yes","score":0.5}'])))
                if text.startswith("agent:"):
                    call_id = f"call_{fake.counter}_lookup"
                    outputs = {item["call_id"]: item["output"] for item in body["input"]
                               if item.get("type") == "function_call_output"}
                    if not outputs:
                        self.start_stream()
                        return self.send_events(complete(rid, model, [
                            *reasoning(rid, 0, "I should look it up.", "ENC-A"),
                            *function_call(rid, 1, call_id, "lookup", {"key": "alpha"}),
                        ]))
                    replayed = [item for item in body["input"] if item.get("type") == "reasoning"]
                    if not any(item.get("encrypted_content") == "ENC-A" for item in replayed):
                        return self.reply(400, {"error": {"message": "encrypted reasoning was not replayed"}})
                    calls = [item for item in body["input"] if item.get("type") == "function_call"]
                    if [item["call_id"] for item in calls] != list(outputs):
                        return self.reply(400, {"error": {"message": "every call needs its output, in order"}})
                    self.start_stream()
                    return self.send_events(complete(rid, model, message(
                        rid, 0, [f"lookup said {list(outputs.values())[-1]}"], phase="final_answer")))
                self.start_stream([
                    ("x-codex-primary-used-percent", "12.5"),
                    ("x-codex-primary-window-minutes", "300"),
                    ("x-codex-primary-reset-at", str(int(time.time()) + 3600)),
                ])
                return self.send_events(complete(rid, model, [
                    *reasoning(rid, 0, "Greeting.", "ENC-H"),
                    *message(rid, 1, ["Hello ", "from ", "the ", "fake"]),
                ]), pause=0.01)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.base = f"{self.origin}/openai/v1"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def count(self, text):
        with self.lock:
            return sum(1 for request in self.requests if request["text"] == text)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def created(rid, model):
    return {"type": "response.created", "response": {"id": rid, "model": model, "status": "in_progress", "output": []}}


def message(rid, index, deltas, phase=None):
    item_id = f"msg_{rid}_{index}"
    text = "".join(deltas)
    done = {"id": item_id, "type": "message", "status": "completed", "role": "assistant",
            "content": [{"type": "output_text", "text": text, "annotations": []}]}
    if phase is not None:
        done["phase"] = phase
    return [
        {"type": "response.output_item.added", "output_index": index,
         "item": {"id": item_id, "type": "message", "status": "in_progress", "role": "assistant", "content": []}},
        *({"type": "response.output_text.delta", "item_id": item_id, "output_index": index,
           "content_index": 0, "delta": delta} for delta in deltas),
        {"type": "response.output_item.done", "output_index": index, "item": done},
    ]


def reasoning(rid, index, summary, encrypted):
    item_id = f"rs_{rid}_{index}"
    return [
        {"type": "response.output_item.added", "output_index": index,
         "item": {"id": item_id, "type": "reasoning", "summary": []}},
        {"type": "response.reasoning_summary_text.delta", "item_id": item_id, "output_index": index,
         "summary_index": 0, "delta": summary},
        {"type": "response.output_item.done", "output_index": index,
         "item": {"id": item_id, "type": "reasoning", "summary": [{"type": "summary_text", "text": summary}],
                  "encrypted_content": encrypted}},
    ]


def function_call(rid, index, call_id, name, arguments):
    item_id = f"fc_{rid}_{index}"
    args = json.dumps(arguments)
    return [
        {"type": "response.output_item.added", "output_index": index,
         "item": {"id": item_id, "type": "function_call", "status": "in_progress", "call_id": call_id,
                  "name": name, "arguments": ""}},
        {"type": "response.function_call_arguments.delta", "item_id": item_id, "output_index": index, "delta": args},
        {"type": "response.output_item.done", "output_index": index,
         "item": {"id": item_id, "type": "function_call", "status": "completed", "call_id": call_id,
                  "name": name, "arguments": args}},
    ]


def complete(rid, model, items):
    return [
        created(rid, model),
        *items,
        {"type": "response.completed", "response": {
            "id": rid, "model": model, "status": "completed", "output": [],
            "usage": {"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 600},
                      "output_tokens": 40, "output_tokens_details": {"reasoning_tokens": 10},
                      "total_tokens": 1040},
        }},
    ]


class LocalRuntime:
    """Own exactly one temporary project and celld dev supervisor process."""

    def __init__(self, project):
        self.temporary = tempfile.TemporaryDirectory(prefix="openai-runtime-test-")
        self.root = Path(self.temporary.name)
        self.log_path = self.root / "celld.log"
        self.process = None
        self.log = None
        try:
            shutil.copytree(project, self.root / "project")
            # dev rejects port 0. Reserving then releasing a kernel-selected
            # port leaves a small bind race, reported by the bounded startup.
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            self.origin = f"http://127.0.0.1:{port}"
            # The Worker's fetch must reach the fake server on loopback
            # directly, so no inherited proxy may apply.
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
        """Read diagnostics without draining a pipe or blocking the child."""
        return self.log_path.read_text(errors="replace")

    def start(self):
        """Start/restart the same project and ignore any earlier readiness log."""
        offset = len(self.logs())
        self.process = subprocess.Popen(
            self.command, stdin=subprocess.DEVNULL, stdout=self.log,
            stderr=subprocess.STDOUT, env=self.environment,
        )
        self.until(lambda: "ready  " + self.origin in self.logs()[offset:], 40, "startup")

    def until(self, condition, seconds, phase):
        """Bound polling independently and include runtime logs on failure."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError(f"celld exited during {phase}:\n{self.logs()}")
            if condition():
                return
            time.sleep(0.02)
        raise AssertionError(f"celld timed out during {phase}:\n{self.logs()}")

    def request(self, method, path, payload=None, timeout=30):
        """Issue one request, returning its status even when it is a rejection."""
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(
            self.origin + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        # Ignore any inherited HTTP proxy for isolated loopback traffic.
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
        """Stop only our supervisor; celld owns and reaps its child node."""
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                # Upstream graceful shutdown is bounded at 35 seconds.
                self.process.wait(timeout=40)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
                raise AssertionError(f"celld did not stop gracefully:\n{self.logs()}")

    def restart(self):
        """Replace the supervisor while retaining its project, data, and port."""
        self.stop()
        self.start()

    def close(self):
        """Bound shutdown and remove only the temporary project owned by this test."""
        try:
            self.stop()
        finally:
            if self.log is not None:
                self.log.close()
            self.temporary.cleanup()


class OpenAIRuntimeTest(unittest.TestCase):
    """The client, pacer, conversations and workflow on the real runtime."""

    @classmethod
    def setUpClass(cls):
        cls.fake = FakeCodex()
        cls.addClassCleanup(cls.fake.close)
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def pacer(self):
        """A pacer object of this test's own, so tests share no state."""
        return self.id().rsplit(".", 1)[-1].replace("_", "-")

    def call(self, method, path, payload=None, pacer=None, extra=""):
        separator = "&" if "?" in path else "?"
        query = f"{separator}base={self.fake.base}&pacer={pacer or self.pacer()}{extra}"
        status, body = self.runtime.request(method, path + query, payload)
        self.assertEqual(status, 200, body)
        return body

    def respond(self, text, stream=False, pacer=None, extra=""):
        return self.call("POST", "/respond", {"input": text, "stream": stream}, pacer, extra)

    def test_a_streamed_response_arrives_in_pieces_over_real_fetch(self):
        body = self.respond("hello", stream=True)
        outcome = body["outcome"]
        self.assertTrue(outcome["ok"], outcome)
        turn = outcome["result"]
        self.assertEqual(turn["finalText"], "Hello from the fake")
        self.assertEqual(body["deltas"], ["Hello ", "from ", "the ", "fake"])
        self.assertEqual(body["events"][-1], "completed")
        self.assertIn("reasoning.delta", body["events"])
        self.assertEqual(turn["servedModel"], "gpt-6-astra-2026-09-01")
        self.assertEqual(turn["reasoningSummary"], ["Greeting."])
        self.assertEqual(turn["usage"], {"inputTokens": 1000, "cachedInputTokens": 600, "outputTokens": 40,
                                         "reasoningTokens": 10, "totalTokens": 1040})
        meta = turn["meta"]
        self.assertEqual((meta["attempts"], meta["encoding"]), (1, "lite"))
        self.assertTrue(meta["requestId"].startswith("req-"), meta)
        self.assertEqual(meta["rateLimits"][0]["primary"]["usedPercent"], 12.5)
        sent = [r for r in self.fake.requests if r["text"] == "hello"][-1]
        self.assertEqual(sent["path"], "/openai/v1/responses")
        self.assertEqual(sent["headers"]["user-agent"], "celld-openai/0.1.0")
        # The fake refuses anything the backend would; a 200 means none.
        self.assertEqual(sent["body"]["model"], "gpt-6-astra")

    def test_a_stream_broken_off_mid_event_is_retried(self):
        outcome = self.respond("flaky:one")["outcome"]
        self.assertTrue(outcome["ok"], outcome)
        self.assertEqual(outcome["result"]["meta"]["attempts"], 2)
        self.assertEqual(outcome["result"]["finalText"], "Hello from the fake")
        self.assertEqual(self.fake.count("flaky:one"), 2)

    def test_an_idle_stream_times_out(self):
        started = time.monotonic()
        outcome = self.respond("hang", extra="&idle=300&retries=0")["outcome"]
        self.assertFalse(outcome["ok"], outcome)
        self.assertEqual((outcome["error"]["kind"], outcome["error"]["message"]),
                         ("timeout", "no stream event within 300 ms"))
        self.assertLess(time.monotonic() - started, 2.5)

    def test_structured_output_is_decoded_and_typed(self):
        body = self.call("POST", "/structured", {"input": "json"})
        self.assertEqual(body, {"ok": True, "verdict": "yes", "score": 0.5})
        sent = [r for r in self.fake.requests if r["text"] == "json"][-1]["body"]
        self.assertEqual(sent["text"]["format"]["type"], "json_schema")
        self.assertTrue(sent["text"]["format"]["strict"])

    def test_models_are_listed(self):
        models = self.call("GET", "/models")
        self.assertEqual([model["id"] for model in models], ["gpt-6-astra", "gpt-5.5"])

    def test_the_pacer_serialises_the_shared_subscription(self):
        name = self.pacer()
        config = self.call("POST", "/pacer", {"maxConcurrent": 1}, pacer=name)
        self.assertEqual(config["maxConcurrent"], 1)
        results = []
        threads = [threading.Thread(target=lambda i=i: results.append(self.respond(f"slow:{i}", pacer=name)))
                   for i in range(3)]
        with self.fake.lock:
            self.fake.max_in_flight = 0
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertTrue(all(result["outcome"]["ok"] for result in results), results)
        self.assertEqual(self.fake.max_in_flight, 1)
        snapshot = self.call("GET", "/pacer", pacer=name)
        self.assertEqual((snapshot["inFlight"], snapshot["totals"]["calls"]), (0, 3))
        self.assertEqual(snapshot["totals"]["cachedInputTokens"], 1800)

    def test_a_usage_limit_holds_every_caller_until_reset_even_across_a_restart(self):
        name = self.pacer()
        first = self.respond("usage:a", pacer=name)["outcome"]
        self.assertFalse(first["ok"], first)
        error = first["error"]
        self.assertEqual((error["kind"], error["code"], error["retryable"]), ("usage_limit", "usage_limit_reached", False))
        self.assertGreater(error["resetsAt"], time.time() * 1000)
        before = len(self.fake.requests)
        second = self.respond("hello", pacer=name)["outcome"]
        self.assertEqual(second["error"]["kind"], "usage_limit")
        self.assertIn("was not sent", second["error"]["message"])
        self.assertEqual(len(self.fake.requests), before)
        self.runtime.restart()
        snapshot = self.call("GET", "/pacer", pacer=name)
        self.assertEqual(snapshot["block"]["reason"], "usage_limit")
        self.assertEqual(snapshot["totals"]["usageLimits"], 1)
        third = self.respond("hello", pacer=name)["outcome"]
        self.assertEqual(third["error"]["kind"], "usage_limit")
        self.call("POST", "/pacer/unblock", pacer=name)
        self.assertTrue(self.respond("hello", pacer=name)["outcome"]["ok"])

    def test_an_agent_replays_encrypted_reasoning_and_its_conversation_persists(self):
        body = self.call("POST", "/agent", {"id": "conv-1", "task": "agent: look up alpha"})
        result = body["result"]
        self.assertEqual((result["stopReason"], result["text"], result["turns"], result["toolCalls"]),
                         ("completed", "lookup said value-of-alpha", 2, 1))
        sent = [r for r in self.fake.requests if r["text"] == "agent: look up alpha"]
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[1]["body"]["prompt_cache_key"], "conv-1")
        tools = sent[0]["body"]["input"][0]["tools"]
        self.assertEqual([tool["name"] for tool in tools], ["lookup", "apply_patch"])
        self.assertEqual(tools[1]["format"]["syntax"], "lark")
        self.runtime.restart()
        stored = self.call("GET", "/conversation?id=conv-1")
        self.assertEqual([item["type"] for item in stored["items"]],
                         ["message", "reasoning", "function_call", "function_call_output", "message"])
        self.assertEqual(stored["items"][1]["encrypted_content"], "ENC-A")
        self.assertEqual((stored["turns"], stored["usage"]["totalTokens"]), (2, 2080))

    def test_an_agent_workflow_runs_each_turn_once(self):
        created = self.call("POST", "/workflow", {"id": "wf-one", "task": "agent: workflow"})
        self.assertEqual(created["id"], "wf-one")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status = self.call("GET", "/workflow?id=wf-one")
            if status["status"] == "complete":
                break
            if status["status"] in ("errored", "terminated"):
                raise AssertionError(f"workflow: {status}\n{self.runtime.logs()}")
            time.sleep(0.2)
        else:
            raise AssertionError(f"the workflow did not finish\n{self.runtime.logs()}")
        self.assertEqual(status["output"], {"stopReason": "completed", "text": "lookup said value-of-alpha", "turns": 2})
        self.assertEqual(self.fake.count("agent: workflow"), 2)


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
