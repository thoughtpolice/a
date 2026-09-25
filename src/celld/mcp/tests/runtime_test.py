# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run an @celld/mcp server inside a real celld dev supervisor.

Buck provides the pinned CLI and the packaged test project
(tests/runtime/worker.ts). The Deno suites decide whether the library's rules
are right; this one checks the wire format on the real runtime, as a raw HTTP
MCP client that knows only the 2026-07-28 spec: the request headers and their
validation, JSON and SSE responses and SSE framing, `server/discover`, a tool
call, a multi round-trip request, a `subscriptions/listen` stream fed through
the McpChangeHub Durable Object, cancellation by closing a stream, and the
tasks extension (tasks stored and run by one McpTasks Durable Object each,
from its alarm). A last test has the Worker run the TypeScript client against
itself over real fetch.

LocalRuntime is the toolchain's helper from
buck/toolchains/celld/tests/runtime_test.py, as copied by jev.
"""

import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse


VERSION = "2026-07-28"
TOKEN = "runtime-token"
CLIENT_INFO = {"name": "python-raw-client", "version": "1.0.0"}


class LocalRuntime:
    """Own exactly one temporary project and celld dev supervisor process."""

    def __init__(self, project):
        self.temporary = tempfile.TemporaryDirectory(prefix="mcp-runtime-test-")
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
                self.port = listener.getsockname()[1]
            self.origin = f"http://127.0.0.1:{self.port}"
            # The Worker's fetch to itself must stay on loopback, so no
            # inherited proxy may apply.
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("CELLD_", "AWS_", "S3_"))
                   and key.lower() not in ("http_proxy", "https_proxy", "all_proxy")
                   and key != "RUST_LOG"}
            env["NO_COLOR"] = "1"
            self.log = self.log_path.open("w")
            self.command = [str(CELLD), "dev", str(self.root / "project"), "--host", "127.0.0.1",
                            "--port", str(self.port), "--logs", "--no-watch"]
            self.environment = env
            self.start()
        except BaseException:
            self.close()
            raise

    def logs(self):
        """Read diagnostics without draining a pipe or blocking the child."""
        return self.log_path.read_text(errors="replace")

    def start(self):
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

    def stop(self):
        """Stop only our supervisor; celld owns and reaps its child node."""
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=40)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
                raise AssertionError(f"celld did not stop gracefully:\n{self.logs()}")

    def close(self):
        try:
            self.stop()
        finally:
            if self.log is not None:
                self.log.close()
            self.temporary.cleanup()


def meta(capabilities=None, **extra):
    value = {
        "io.modelcontextprotocol/protocolVersion": VERSION,
        "io.modelcontextprotocol/clientCapabilities": capabilities or {},
        "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    }
    value.update(extra)
    return value


class Exchange:
    """One POST, with the response's status, headers and body or stream."""

    def __init__(self, runtime, path, method, body, headers, timeout):
        self.connection = http.client.HTTPConnection("127.0.0.1", runtime.port, timeout=timeout)
        payload = None if body is None else json.dumps(body).encode()
        self.connection.request(method, path, body=payload, headers=headers)
        self.response = self.connection.getresponse()
        self.status = self.response.status
        self.headers = {key.lower(): value for key, value in self.response.getheaders()}

    @property
    def content_type(self):
        return self.headers.get("content-type", "")

    def json(self):
        try:
            return json.loads(self.response.read())
        finally:
            self.close()

    def events(self):
        """Yield (fields, message) per SSE event, checking the framing."""
        fields = {}
        data = []
        while True:
            raw = self.response.readline()
            if raw == b"":
                return
            line = raw.decode().rstrip("\r\n")
            if line == "":
                if data:
                    yield fields, json.loads("\n".join(data))
                fields, data = {}, []
                continue
            if line.startswith(":"):
                continue  # A keep-alive comment.
            name, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if name == "data":
                data.append(value)
            else:
                fields[name] = value

    def close(self):
        self.connection.close()


class McpRuntimeTest(unittest.TestCase):
    """The Streamable HTTP wire format, checked from outside."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)
        cls.next_id = 100

    def post(self, message, headers=None, drop=(), path="/mcp", timeout=30, method="POST"):
        sent = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {TOKEN}",
        }
        if isinstance(message, dict) and "method" in message:
            sent["MCP-Protocol-Version"] = VERSION
            sent["Mcp-Method"] = message["method"]
            params = message.get("params", {})
            name = params.get("name", params.get("uri", params.get("taskId")))
            if message["method"] in ("tools/call", "prompts/get", "resources/read",
                                     "tasks/get", "tasks/update", "tasks/cancel"):
                sent["Mcp-Name"] = name
        sent.update(headers or {})
        for key in drop:
            sent.pop(key, None)
        return Exchange(self.runtime, path, method, message, sent, timeout)

    def request(self, method, params=None, capabilities=None, meta_extra=None, id=None):
        if id is None:
            McpRuntimeTest.next_id += 1
            id = McpRuntimeTest.next_id
        body = dict(params or {})
        body["_meta"] = meta(capabilities, **(meta_extra or {}))
        return {"jsonrpc": "2.0", "id": id, "method": method, "params": body}

    def call(self, message, **kwargs):
        exchange = self.post(message, **kwargs)
        self.assertEqual(exchange.content_type, "application/json", exchange.headers)
        return exchange.status, exchange.json()

    def publish(self, event):
        exchange = Exchange(self.runtime, "/admin/publish", "POST", event,
                            {"Content-Type": "application/json"}, 30)
        self.assertEqual(exchange.status, 200)
        exchange.json()

    def test_server_discover(self):
        status, body = self.call(self.request("server/discover", id="discover-1"))
        self.assertEqual(status, 200)
        self.assertEqual(body["id"], "discover-1")
        result = body["result"]
        self.assertEqual(result["resultType"], "complete")
        self.assertEqual(result["supportedVersions"], [VERSION])
        self.assertEqual(result["capabilities"]["tools"], {"listChanged": True})
        self.assertEqual(result["capabilities"]["resources"],
                         {"listChanged": True, "subscribe": True})
        self.assertEqual(result["capabilities"]["extensions"],
                         {"io.modelcontextprotocol/tasks": {}})
        self.assertEqual(result["_meta"]["io.modelcontextprotocol/serverInfo"],
                         {"name": "celld-mcp-runtime", "version": "0.1.0"})
        self.assertEqual((result["ttlMs"], result["cacheScope"]), (30000, "public"))
        self.assertEqual(result["instructions"], "A test server.")

    def test_request_headers_are_validated(self):
        message = self.request("tools/call", {"name": "echo", "arguments": {"text": "x"}})
        cases = [
            ({}, ("Mcp-Method",), "Header mismatch: Mcp-Method is missing"),
            ({"Mcp-Method": "tools/list"}, (),
             "Header mismatch: Mcp-Method header value 'tools/list' does not match body value 'tools/call'"),
            ({}, ("Mcp-Name",), "Header mismatch: Mcp-Name is missing"),
            ({"Mcp-Name": "other"}, (),
             "Header mismatch: Mcp-Name header value 'other' does not match body value 'echo'"),
            ({"MCP-Protocol-Version": "2025-11-25"}, (),
             "Header mismatch: MCP-Protocol-Version header value '2025-11-25' does not match body value '2026-07-28'"),
        ]
        for headers, drop, text in cases:
            status, body = self.call(message, headers=headers, drop=drop)
            self.assertEqual(status, 400, body)
            self.assertEqual(body["error"], {"code": -32020, "message": text})
            self.assertEqual(body["id"], message["id"])
        # A base64 sentinel Mcp-Name is decoded before comparing.
        status, body = self.call(message, headers={"Mcp-Name": "=?base64?ZWNobw==?="})
        self.assertEqual((status, body["result"]["content"]), (200, [{"type": "text", "text": "x"}]))

    def test_protocol_errors_and_statuses(self):
        old = self.request("tools/list", meta_extra={"io.modelcontextprotocol/protocolVersion": "1900-01-01"})
        status, body = self.call(old, headers={"MCP-Protocol-Version": "1900-01-01"})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], {
            "code": -32022, "message": "Unsupported protocol version",
            "data": {"supported": [VERSION], "requested": "1900-01-01"}})
        status, body = self.call(self.request("ping"))
        self.assertEqual((status, body["error"]["code"]), (404, -32601))
        status, body = self.call({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
                                 headers={"MCP-Protocol-Version": VERSION, "Mcp-Method": "tools/list"})
        self.assertEqual((status, body["error"]["code"]), (400, -32602))
        status, body = self.call(self.request("tools/call", {"name": "login"}))
        self.assertEqual((status, body["error"]["code"]), (400, -32021))
        self.assertEqual(body["error"]["data"],
                         {"requiredCapabilities": {"elicitation": {"form": {}}}})
        for method in ("GET", "DELETE"):
            exchange = self.post(None, method=method)
            self.assertEqual((exchange.status, exchange.headers.get("allow")), (405, "OPTIONS, POST"))
            exchange.json()
        notification = self.post({"jsonrpc": "2.0", "method": "notifications/cancelled",
                                  "params": {"requestId": 1}})
        self.assertEqual(notification.status, 202)
        self.assertEqual(notification.response.read(), b"")
        notification.close()

    def test_bearer_auth_and_protected_resource_metadata(self):
        exchange = self.post(self.request("tools/list"), drop=("Authorization",))
        self.assertEqual(exchange.status, 401)
        self.assertEqual(
            exchange.headers["www-authenticate"],
            f'Bearer resource_metadata="{self.runtime.origin}/.well-known/oauth-protected-resource/mcp"')
        exchange.json()
        document = Exchange(self.runtime, "/.well-known/oauth-protected-resource/mcp", "GET",
                            None, {}, 30)
        self.assertEqual(document.status, 200)
        self.assertEqual(document.json()["authorization_servers"], ["https://auth.example"])

    def test_tools_list_and_call(self):
        status, body = self.call(self.request("tools/list"))
        self.assertEqual(status, 200)
        tools = body["result"]["tools"]
        self.assertEqual([tool["name"] for tool in tools],
                         ["add", "build", "echo", "login", "region", "slow", "spin"])
        region = next(tool for tool in tools if tool["name"] == "region")
        self.assertEqual(region["inputSchema"]["properties"]["region"]["x-mcp-header"], "Region")
        status, body = self.call(self.request("tools/call", {"name": "add", "arguments": {"a": 2, "b": 3}}))
        result = body["result"]
        self.assertEqual((status, result["resultType"], result["structuredContent"]),
                         (200, "complete", {"sum": 5}))
        self.assertEqual(result["content"], [{"type": "text", "text": '{"sum":5}'}])
        call = self.request("tools/call", {"name": "region", "arguments": {"region": "eu-west"}})
        status, body = self.call(call, headers={"Mcp-Param-Region": "eu-west"})
        self.assertEqual(body["result"]["content"], [{"type": "text", "text": "in eu-west"}])
        status, body = self.call(call)
        self.assertEqual((status, body["error"]["message"]),
                         (400, "Header mismatch: Mcp-Param-Region is missing"))
        status, body = self.call(self.request("tools/call", {"name": "nope"}))
        self.assertEqual((status, body["error"]["code"]), (200, -32602))

    def test_progress_streams_as_sse(self):
        message = self.request("tools/call", {"name": "slow", "arguments": {"steps": 3, "tag": "sse"}},
                               meta_extra={"progressToken": "p1"})
        exchange = self.post(message)
        self.assertEqual(exchange.status, 200)
        self.assertTrue(exchange.content_type.startswith("text/event-stream"), exchange.headers)
        self.assertEqual(exchange.headers.get("x-accel-buffering"), "no")
        seen = []
        for fields, event in exchange.events():
            # One JSON-RPC message per `message` event, and no event ids:
            # streams are not resumable.
            self.assertEqual(fields, {"event": "message"})
            seen.append(event)
            if "id" in event:
                break
        exchange.close()
        self.assertEqual([event.get("method") for event in seen[:-1]],
                         ["notifications/progress"] * 3)
        self.assertEqual([event["params"]["progress"] for event in seen[:-1]], [1, 2, 3])
        self.assertEqual(seen[0]["params"], {"progressToken": "p1", "progress": 1, "total": 3})
        self.assertEqual(seen[-1]["id"], message["id"])
        self.assertEqual(seen[-1]["result"]["content"], [{"type": "text", "text": "finished 3"}])

    def test_multi_round_trip_request(self):
        caps = {"elicitation": {"form": {}}}
        first = self.request("tools/call", {"name": "login"}, capabilities=caps)
        status, body = self.call(first)
        result = body["result"]
        self.assertEqual((status, result["resultType"]), (200, "input_required"))
        self.assertEqual(result["inputRequests"]["github"]["method"], "elicitation/create")
        self.assertEqual(result["inputRequests"]["github"]["params"]["mode"], "form")
        state = result["requestState"]
        answer = {"github": {"action": "accept", "content": {"login": "octocat"}}}
        tampered = self.request("tools/call", {"name": "login", "inputResponses": answer,
                                               "requestState": state[:-4] + "AAAA"}, capabilities=caps)
        status, body = self.call(tampered)
        self.assertEqual(body["error"], {"code": -32602, "message": "Invalid requestState"})
        retry = self.request("tools/call", {"name": "login", "inputResponses": answer,
                                            "requestState": state}, capabilities=caps)
        self.assertNotEqual(retry["id"], first["id"])
        status, body = self.call(retry)
        self.assertEqual((status, body["result"]["resultType"], body["result"]["content"]),
                         (200, "complete", [{"type": "text", "text": "hello octocat"}]))

    def listen(self, notifications, id, capabilities=None):
        exchange = self.post(self.request("subscriptions/listen", {"notifications": notifications},
                                          capabilities=capabilities, id=id),
                             timeout=20)
        self.assertEqual(exchange.status, 200)
        self.assertTrue(exchange.content_type.startswith("text/event-stream"))
        return exchange, exchange.events()

    def test_subscriptions_listen(self):
        exchange, events = self.listen({"toolsListChanged": True, "promptsListChanged": True,
                                        "resourceSubscriptions": ["config://app"]}, "listen-1")
        try:
            _, ack = next(events)
            self.assertEqual(ack, {
                "jsonrpc": "2.0",
                "method": "notifications/subscriptions/acknowledged",
                "params": {
                    # The server has no prompts, so that type is not honoured.
                    "notifications": {"toolsListChanged": True,
                                      "resourceSubscriptions": ["config://app"]},
                    "_meta": {"io.modelcontextprotocol/subscriptionId": "listen-1"},
                },
            })
            self.publish({"type": "prompts"})
            self.publish({"type": "resource", "uri": "config://other"})
            self.publish({"type": "tools"})
            self.publish({"type": "resource", "uri": "config://app"})
            _, first = next(events)
            _, second = next(events)
            self.assertEqual(first, {
                "jsonrpc": "2.0", "method": "notifications/tools/list_changed",
                "params": {"_meta": {"io.modelcontextprotocol/subscriptionId": "listen-1"}}})
            self.assertEqual(second["method"], "notifications/resources/updated")
            self.assertEqual(second["params"], {
                "uri": "config://app",
                "_meta": {"io.modelcontextprotocol/subscriptionId": "listen-1"}})
        finally:
            exchange.close()

    def test_closing_the_stream_cancels_the_request(self):
        listener, events = self.listen({"resourceSubscriptions": ["cancelled://t1"]}, "listen-cancel")
        try:
            next(events)  # The acknowledgement.
            message = self.request("tools/call", {"name": "slow", "arguments": {"steps": 100, "tag": "t1"}},
                                   meta_extra={"progressToken": "c1"})
            work = self.post(message)
            stream = work.events()
            _, progress = next(stream)
            self.assertEqual(progress["method"], "notifications/progress")
            work.close()
            # The tool saw its AbortSignal fire and published that through
            # the hub.
            _, cancelled = next(events)
            self.assertEqual(cancelled["params"]["uri"], "cancelled://t1")
        finally:
            listener.close()

    TASKS = {"extensions": {"io.modelcontextprotocol/tasks": {}}}

    def task_call(self, method, params, token=None, capabilities=None, **kwargs):
        headers = {} if token is None else {"Authorization": f"Bearer {token}"}
        return self.call(self.request(method, params,
                                      capabilities=self.TASKS if capabilities is None else capabilities),
                         headers=headers, **kwargs)

    def poll(self, task_id, until, seconds=20):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            status, body = self.task_call("tasks/get", {"taskId": task_id})
            self.assertEqual(status, 200, body)
            task = body["result"]
            if until(task):
                return task
            time.sleep(0.05)
        raise AssertionError(f"task {task_id} never got there: {task}")

    def test_task_lifecycle(self):
        caps = {"extensions": {"io.modelcontextprotocol/tasks": {}}, "elicitation": {"form": {}}}
        # Without the extension the task-only tool cannot run.
        status, body = self.call(self.request("tools/call", {"name": "build", "arguments": {"target": "x"}}))
        self.assertEqual((status, body["error"]["code"]), (400, -32021))
        status, body = self.call(self.request("tools/call", {"name": "build", "arguments": {"target": "app"}},
                                              capabilities=caps))
        self.assertEqual(status, 200, body)
        created = body["result"]
        self.assertEqual((created["resultType"], created["status"], created["pollIntervalMs"]),
                         ("task", "working", 100))
        self.assertEqual(created["ttlMs"], 3600000)
        task_id = created["taskId"]
        self.assertRegex(task_id, r"^[A-Za-z0-9_-]{24}$")
        # Stored before the answer: an immediate poll finds it, in any isolate.
        status, body = self.task_call("tasks/get", {"taskId": task_id})
        self.assertEqual((status, body["result"]["taskId"]), (200, task_id))
        waiting = self.poll(task_id, lambda task: task["status"] == "input_required")
        self.assertEqual(waiting["resultType"], "complete")
        self.assertEqual(waiting["statusMessage"], "preparing app")
        self.assertEqual(waiting["inputRequests"]["confirm"]["params"]["message"], "Build app?")

        # Checked per request: extension, routing header, owner, answer shape.
        status, body = self.task_call("tasks/get", {"taskId": task_id}, capabilities={})
        self.assertEqual((status, body["error"]["code"]), (400, -32021))
        status, body = self.task_call("tasks/get", {"taskId": task_id}, drop=("Mcp-Name",))
        self.assertEqual((status, body["error"]["message"]), (400, "Header mismatch: Mcp-Name is missing"))
        status, body = self.task_call("tasks/get", {"taskId": task_id}, token="other-token")
        self.assertEqual(body["error"], {"code": -32602, "message": "Failed to retrieve task: Task not found"})
        status, body = self.task_call("tasks/update", {"taskId": task_id,
                                                       "inputResponses": {"confirm": {"action": "accept",
                                                                                      "content": {"ok": "yes"}}}})
        self.assertEqual(body["error"]["code"], -32602)

        status, body = self.task_call("tasks/update", {"taskId": task_id,
                                                       "inputResponses": {"confirm": {"action": "accept",
                                                                                      "content": {"ok": True}}}})
        self.assertEqual((status, body["result"]), (200, {
            "resultType": "complete",
            "_meta": {"io.modelcontextprotocol/serverInfo": {"name": "celld-mcp-runtime", "version": "0.1.0"}}}))
        done = self.poll(task_id, lambda task: task["status"] == "completed")
        # The body ran twice: once up to the question, once with the answer.
        self.assertEqual(done["result"]["structuredContent"], {"artifact": "app.tar", "runs": 2})
        self.assertEqual(done["result"]["content"], [{"type": "text", "text": '{"artifact":"app.tar","runs":2}'}])

    def test_task_cancel_and_notifications(self):
        status, body = self.task_call("tools/call", {"name": "spin"})
        task_id = body["result"]["taskId"]
        self.assertEqual(body["result"]["ttlMs"], 60000)
        exchange, events = self.listen({"taskIds": [task_id, "not-a-task"]}, "listen-tasks",
                                       capabilities=self.TASKS)
        try:
            _, ack = next(events)
            self.assertEqual(ack["params"]["notifications"], {"taskIds": [task_id]})
            _, first = next(events)
            self.assertEqual(first["method"], "notifications/tasks")
            self.assertEqual(first["params"]["taskId"], task_id)
            self.assertEqual(first["params"]["status"], "working")
            self.assertEqual(first["params"]["_meta"], {"io.modelcontextprotocol/subscriptionId": "listen-tasks"})
            # The body reports progress as status messages, which notify.
            _, progress = next(events)
            self.assertTrue(progress["params"]["statusMessage"].startswith("round "), progress)
            status, body = self.task_call("tasks/cancel", {"taskId": task_id})
            self.assertEqual((status, body["result"]["resultType"]), (200, "complete"))
            while True:
                _, event = next(events)
                if event["params"]["status"] != "working":
                    break
            self.assertEqual(event["params"]["status"], "cancelled")
        finally:
            exchange.close()
        cancelled = self.poll(task_id, lambda task: True)
        self.assertEqual((cancelled["status"], cancelled["statusMessage"]),
                         ("cancelled", "The client cancelled the task"))

    def test_task_notifications_need_the_extension(self):
        status, body = self.call(self.request("subscriptions/listen", {"notifications": {"taskIds": ["x"]}}))
        self.assertEqual((status, body["error"]["code"]), (400, -32021))

    def test_oauth_challenge_and_metadata(self):
        origin = self.runtime.origin
        call = self.request("tools/call", {"name": "whoami"})
        exchange = self.post(call, path="/oauth-mcp", drop=("Authorization",))
        self.assertEqual(exchange.status, 401)
        self.assertEqual(exchange.headers["www-authenticate"],
                         f'Bearer resource_metadata="{origin}/.well-known/oauth-protected-resource/oauth-mcp"')
        exchange.json()
        exchange = self.post(call, path="/oauth-mcp", headers={"Authorization": "Bearer not-a-jwt"})
        self.assertEqual(exchange.status, 401)
        self.assertIn('error="invalid_token"', exchange.headers["www-authenticate"])
        exchange.json()
        prm = Exchange(self.runtime, "/.well-known/oauth-protected-resource/oauth-mcp", "GET", None, {}, 30)
        self.assertEqual(prm.status, 200)
        self.assertEqual(prm.json(), {
            "resource": f"{origin}/oauth-mcp",
            "authorization_servers": [f"{origin}/oauth"],
            "bearer_methods_supported": ["header"],
            "scopes_supported": ["mcp:read"],
        })
        metadata = Exchange(self.runtime, "/.well-known/oauth-authorization-server/oauth", "GET", None, {}, 30)
        document = metadata.json()
        self.assertEqual(document["issuer"], f"{origin}/oauth")
        self.assertEqual(document["code_challenge_methods_supported"], ["S256"])
        self.assertTrue(document["authorization_response_iss_parameter_supported"])
        # Behind a proxy the metadata names the URL the client used.
        exchange = self.post(call, path="/oauth-mcp", drop=("Authorization",),
                             headers={"X-Forwarded-Proto": "https", "X-Forwarded-Host": "mcp.example"})
        self.assertEqual(exchange.headers["www-authenticate"],
                         'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/oauth-mcp"')
        exchange.json()

    def test_oauth_typescript_client(self):
        target = self.runtime.origin + "/oauth-mcp"
        exchange = Exchange(self.runtime, f"/oauth-check?target={urllib.parse.quote(target, safe='')}",
                            "GET", None, {}, 60)
        status = exchange.status
        report = exchange.json()
        self.assertEqual(status, 200, report)
        self.assertEqual(report["whoami"], {"subject": "oauth-user", "scopes": ["mcp:read"]})
        self.assertEqual(report["write"], [{"type": "text", "text": "wrote hi"}])
        self.assertEqual(report["issuer"], self.runtime.origin + "/oauth")
        self.assertEqual(report["resource"], target)
        # A first authorization, then a step-up keeping the earlier scope.
        self.assertEqual(report["scopes"], ["mcp:read", "mcp:read mcp:write"])
        self.assertEqual(report["resources"], [target, target])
        # Both authorizations were pushed (RFC 9126), with PKCE in the push.
        self.assertEqual(report["pushed"], [True, True])

    def test_typescript_client_end_to_end(self):
        target = urllib.parse.quote(self.runtime.origin + "/mcp", safe="")
        exchange = Exchange(self.runtime, f"/client-check?target={target}", "GET", None, {}, 60)
        status = exchange.status
        report = exchange.json()
        self.assertEqual(status, 200, report)
        self.assertEqual(report["versions"], [VERSION])
        self.assertEqual(report["tools"],
                         ["add", "build", "echo", "login", "region", "slow", "spin"])
        self.assertEqual(report["echo"], [{"type": "text", "text": "hi"}])
        self.assertEqual(report["add"], {"sum": 42})
        self.assertEqual(report["region"], [{"type": "text", "text": "in eu-west"}])
        self.assertEqual(report["login"], [{"type": "text", "text": "hello octocat"}])
        self.assertEqual(report["elicited"], ["Your GitHub login?", "Build app?"])
        self.assertEqual(report["build"], {"artifact": "app.tar", "runs": 2})
        self.assertEqual(report["buildStatuses"][-1], "completed")
        self.assertIn("input_required", report["buildStatuses"])
        self.assertEqual(report["slow"], [{"type": "text", "text": "finished 3"}])
        self.assertEqual(report["progress"], [1, 2, 3])
        self.assertEqual(report["config"], [{"uri": "config://app", "text": '{"debug":true}',
                                             "mimeType": "application/json"}])
        self.assertTrue(report["missing"])
        self.assertEqual(report["acknowledged"], {"toolsListChanged": True})
        self.assertEqual(report["notification"], "notifications/tools/list_changed")


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
