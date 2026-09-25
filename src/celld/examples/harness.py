# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run a celld example under `celld dev` against a fake upstream.

`celld_example` (defs.bzl) gives every example two commands built on this
file:

    harness.py test --celld CELLD --project DIR --spec SPEC [--upstream CMD]
    harness.py dev  --celld CELLD --project DIR --spec SPEC [--upstream CMD]
                    [--port 9876] [--live] [--state DIR]

`test` copies the packaged project into a temporary directory, starts the
fake upstream (if any), writes the variables it asks for plus the spec's own
into `.dev.vars`, boots `celld dev` on a free loopback port, runs the spec's
steps in order and tears everything down, whatever happened. `dev` does the
same setup and then leaves the example running for `curl`, until Ctrl-C;
`--live` skips the fake so the Worker reaches the real service with whatever
`--var`s you pass.

A spec is JSON:

    {
      "vars": {"NAME": "value, {upstream} is the fake's origin",
               "JWK": {"kty": "EC", "...": "an object arrives as compact JSON"}},
      "steps": [{
        "name": "what this step shows",
        "restart": false,
        "script": <JSON for the fake, or a list of them>,
        "request": {"method": "POST", "path": "/x", "json": {...},
                    "body": "raw text", "headers": {...}},
        (or "url": an absolute loopback URL instead of "path")
        "expect": {"status": 200, "json": M, "text": M, "headers": M,
                   "cookies": M, "sse": M},
        "until": {"seconds": 30, "interval": 0.2},
        "upstream": M,
        "save": {"name": "json.result.id"}
      }]
    }

`M` is a matcher (see `match`). `expect.status` defaults to 200. `headers`
keeps the last value of a repeated header; `cookies` is the list of every
`Set-Cookie` line. Variables reach the Worker byte for byte (see
`dev_vars_text`). `until` repeats the request until `expect` holds.
`upstream` is matched against the list of requests the fake received since
the last step that had an `upstream` check (or since startup), so `[]` says
nothing reached it, and requests a Workflow makes after the step that
started it are checked by the step that waits for its result.

`save` keeps values from a step's response (a dotted path from its
`status`, `json`, `text` or `headers`; list indices are numbers) under a
name, and later steps' `script`, `request`, `expect` and `upstream` say
`{name}` to use it: a string that is exactly `{name}` becomes the value
itself, and one containing it gets the value's text. This is how a spec
follows an id or token the Worker made up (see `substitute`). A save of
`{"path": p, "regex": r}` keeps the first group of `r` in the value at
`p`, such as the `code` in a `Location` (see `extract`), and a request's
`url` (instead of `path`) follows a saved absolute URL on loopback, such
as a redirect to the fake upstream or back to the Worker.

Everything stays on loopback: no network, account or real token is used.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


# MARK: Matching


def _short(value):
    text = json.dumps(value, sort_keys=True)
    return text if len(text) <= 200 else text[:197] + "..."


OPERATORS = frozenset(["$any", "$absent", "$exact", "$regex", "$contains", "$len",
                       "$gt", "$gte", "$lt", "$lte", "$json", "$not"])


def _operator(expected, exact=False):
    """The `$op` of a one-key `{"$op": arg}` object, else None. Under
    `$exact` only the known operators count, so data with a `$` key (a JSON
    Schema's `{"$ref": ...}`) is compared as data."""
    if isinstance(expected, dict) and len(expected) == 1:
        (key,) = expected
        if key.startswith("$") and (not exact or key in OPERATORS):
            return key
    return None


def _same(expected, actual):
    """Plain equality that keeps booleans apart from numbers."""
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    return expected == actual


def match(expected, actual, path="$", exact=False):
    """Every way `actual` fails `expected`, as `path: problem` strings.

    - an object matches an object with at least its keys, each matching;
    - a list matches a list of the same length, element by element;
    - a scalar matches an equal scalar (`true` is not `1`);
    - `{"$any": true}` matches anything that is present;
    - `{"$absent": true}`, as an object's value, says the key is missing;
    - `{"$exact": v}` is `v` with no extra keys in any object inside it
      (`exact`). Operators inside it still work (`{"$exact": {"id":
      {"$regex": "^t"}}}`), and their own arguments are matched as usual
      (wrap one in `$exact` again to make it exact too); a `$` key that is
      not an operator is data there, such as JSON Schema's `$ref`;
    - `{"$regex": r}` matches a string `re.search` finds `r` in;
    - `{"$contains": v}` matches a string with substring `v`, or a list with
      an element matching `v`;
    - `{"$len": n}` matches a string, list or object of length `n`;
    - `{"$gt": n}`, `$gte`, `$lt`, `$lte` compare numbers;
    - `{"$json": m}` parses a string as JSON and matches it against `m`;
    - `{"$not": m}` matches whatever `m` does not.
    """
    op = _operator(expected, exact)
    if op is not None:
        return _match_operator(op, expected[op], actual, path)
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{path}: expected an object, got {_short(actual)}"]
        problems = []
        for key, value in expected.items():
            where = f"{path}.{key}"
            if _operator(value, exact) == "$absent":
                if key in actual:
                    problems.append(f"{where}: expected no key, got {_short(actual[key])}")
            elif key not in actual:
                problems.append(f"{where}: missing")
            else:
                problems.extend(match(value, actual[key], where, exact))
        if exact:
            extra = sorted(key for key in actual if key not in expected)
            if extra:
                problems.append(f"{path}: unexpected keys under $exact: {', '.join(extra)}")
        return problems
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return [f"{path}: expected a list, got {_short(actual)}"]
        if len(expected) != len(actual):
            return [f"{path}: expected {len(expected)} items, got {len(actual)}: {_short(actual)}"]
        problems = []
        for index, (want, got) in enumerate(zip(expected, actual)):
            problems.extend(match(want, got, f"{path}[{index}]", exact))
        return problems
    if not _same(expected, actual):
        return [f"{path}: expected {_short(expected)}, got {_short(actual)}"]
    return []


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _match_operator(op, arg, actual, path):
    fail = [f"{path}: expected {{{op}: {_short(arg)}}}, got {_short(actual)}"]
    if op == "$any":
        return []
    if op == "$absent":
        return [f"{path}: $absent only applies to an object's key"]
    if op == "$exact":
        return match(arg, actual, path, exact=True)
    if op == "$regex":
        return [] if isinstance(actual, str) and re.search(arg, actual) else fail
    if op == "$contains":
        if isinstance(actual, str) and isinstance(arg, str):
            return [] if arg in actual else fail
        if isinstance(actual, list):
            return [] if any(not match(arg, item) for item in actual) else fail
        return fail
    if op == "$len":
        return [] if isinstance(actual, (str, list, dict)) and len(actual) == arg else fail
    comparisons = {"$gt": lambda a, b: a > b, "$gte": lambda a, b: a >= b,
                   "$lt": lambda a, b: a < b, "$lte": lambda a, b: a <= b}
    if op in comparisons:
        return [] if _number(actual) and comparisons[op](actual, arg) else fail
    if op == "$not":
        return fail if not match(arg, actual, path) else []
    if op == "$json":
        if not isinstance(actual, str):
            return fail
        try:
            parsed = json.loads(actual)
        except ValueError:
            return [f"{path}: expected JSON text, got {_short(actual)}"]
        return match(arg, parsed, f"{path}<json>")
    return [f"{path}: unknown matcher {op}"]


def lookup(response, path):
    """The value at a dotted `path` in a response; raises KeyError if absent."""
    value = response
    for part in path.split("."):
        if isinstance(value, list) and re.fullmatch(r"-?\d+", part):
            index = int(part)
            if not -len(value) <= index < len(value):
                raise KeyError(path)
            value = value[index]
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            raise KeyError(path)
    return value


def extract(response, spec):
    """What a `save` entry keeps: the value at a dotted path, or with
    `{"path": p, "regex": r}` the first group of `r` in that value's text.
    Raises KeyError when the path or the pattern finds nothing."""
    if isinstance(spec, dict):
        value = lookup(response, spec["path"])
        found = re.search(spec["regex"], value if isinstance(value, str) else json.dumps(value))
        if found is None:
            raise KeyError(f"{spec['path']} =~ {spec['regex']}")
        return found.group(1) if found.groups() else found.group(0)
    return lookup(response, spec)


def request_url(origin, spec):
    """The URL a spec's request goes to: the Worker's `path`, or an absolute
    loopback `url` (a saved `Location`); anything else is refused."""
    url = spec.get("url")
    if url is None:
        return origin + spec.get("path", "/")
    if not re.match(r"^http://(127\.0\.0\.1|localhost|[a-z0-9.-]+\.localhost)(:\d+)?/", url):
        raise StepFailure([f"request.url must be an http URL on loopback, not {url!r}"])
    return url


def substitute(value, saved):
    """`value` with every `{name}` of `saved` filled in (see `save`)."""
    if not saved:
        return value
    if isinstance(value, str):
        for name, found in saved.items():
            token = "{" + name + "}"
            if value == token:
                return found
            if token in value:
                value = value.replace(token, found if isinstance(found, str) else json.dumps(found))
        return value
    if isinstance(value, list):
        return [substitute(item, saved) for item in value]
    if isinstance(value, dict):
        return {substitute(key, saved): substitute(item, saved) for key, item in value.items()}
    return value


def parse_sse(text):
    """Server-sent events as `[{"event": name or null, "data": JSON or text}]`."""
    events = []
    for block in re.split(r"\r?\n\r?\n", text):
        name, data = None, []
        for line in block.splitlines():
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].removeprefix(" "))
        if name is None and not data:
            continue
        payload = "\n".join(data)
        try:
            payload = json.loads(payload)
        except ValueError:
            pass
        events.append({"event": name, "data": payload})
    return events


# MARK: Processes


_VAR_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def dev_vars_text(dev_vars):
    """`.dev.vars` text that celld dev reads back byte for byte.

    celld's parser (0.5.1) takes `NAME=value` lines, trims the name and the
    value, and removes one pair of matching quotes around the value. It
    reads no escapes (`"a\\"b"` arrives as `a\\"b`), no `export`, no
    comments after a value and no value spanning lines. So each value is
    written between single quotes, verbatim: the quotes protect leading and
    trailing spaces and a value that is itself quoted (`'"x"'` arrives as
    `"x"`), and JSON needs nothing more. A value with a line break cannot be
    written at all and is refused.
    """
    lines = []
    for name, value in sorted(dev_vars.items()):
        if not _VAR_NAME.fullmatch(name):
            raise StepFailure([f"vars: {name!r} is not a variable name celld accepts"])
        if "\n" in value or "\r" in value:
            raise StepFailure([f"vars.{name}: celld's .dev.vars cannot carry a line break"])
        lines.append(f"{name}='{value}'\n")
    return "".join(lines)


def var_text(value):
    """A spec's variable as the Worker sees it: strings as they are, anything
    else (an object, such as a JWK) as compact JSON."""
    return value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))


def _clean_environment():
    """The caller's environment without anything that could leave loopback."""
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("CELLD_", "AWS_", "S3_"))
           and key.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")
           and key != "RUST_LOG"}
    env["NO_COLOR"] = "1"
    return env


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Hand a redirect back as the response, so a spec can check it."""

    def redirect_request(self, *args, **kwargs):
        return None


def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirects())


def _free_port():
    # celld dev rejects port 0. Reserving then releasing a kernel-chosen port
    # leaves a small race, which Runtime.start retries.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def _stop(process, grace):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


class Upstream:
    """The example's fake upstream: a Deno program printing its ready line."""

    def __init__(self, command, root):
        self.log_path = root / "upstream.log"
        self.log = self.log_path.open("w")
        env = _clean_environment()
        # Deno keeps its caches here, not in the user's home.
        env["DENO_DIR"] = str(root / "deno")
        env["DENO_NO_UPDATE_CHECK"] = "1"
        scratch = root / "upstream"
        scratch.mkdir(exist_ok=True)
        self.process = subprocess.Popen(
            # $(exe) joins a multi-argument command into one argument.
            [*shlex.split(command), str(scratch)], stdin=subprocess.DEVNULL, stdout=self.log,
            stderr=subprocess.STDOUT, env=env,
        )
        try:
            ready = _wait(self.process, self._ready, 30, "the fake upstream's startup", self.logs)
        except BaseException:
            self.close()
            raise
        self.origin, self.vars = ready["upstream"], ready["vars"]

    def logs(self):
        return self.log_path.read_text(errors="replace")

    def _ready(self):
        for line in self.logs().splitlines():
            if line.startswith('{"upstream":'):
                return json.loads(line)
        return None

    def _call(self, method, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(self.origin + path, data=data, method=method,
                                         headers={"content-type": "application/json"})
        try:
            with _opener().open(request, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                raise StepFailure([f"the fake upstream refused {path}: {error.read().decode()}"])

    def script(self, instruction):
        self._call("POST", "/__upstream/script", instruction)

    def requests(self, since):
        return self._call("GET", f"/__upstream/requests?since={since}")

    def close(self):
        _stop(self.process, 5)
        self.log.close()


class Runtime:
    """One `celld dev` supervisor over a private copy of the project."""

    def __init__(self, celld, project, root, dev_vars, port=None):
        self.directory = root / "project"
        if not self.directory.exists():
            shutil.copytree(project, self.directory)
            # Buck's outputs are read-only; celld keeps its state inside.
            for path in [self.directory, *self.directory.rglob("*")]:
                path.chmod(path.stat().st_mode | 0o200)
        (self.directory / ".dev.vars").write_text(dev_vars_text(dev_vars))
        self.celld = celld
        self.fixed_port = port is not None
        self.log_path = root / "celld.log"
        self.log = self.log_path.open("a")
        self.process = None
        self._listen(port or _free_port())

    def _listen(self, port):
        self.port = port
        self.origin = f"http://127.0.0.1:{port}"
        self.command = [str(self.celld), "dev", str(self.directory), "--host", "127.0.0.1",
                        "--port", str(port), "--logs", "--no-watch"]

    def logs(self):
        return self.log_path.read_text(errors="replace")

    def start(self):
        for attempt in range(3):
            offset = len(self.logs())
            self.process = subprocess.Popen(
                self.command, stdin=subprocess.DEVNULL, stdout=self.log,
                stderr=subprocess.STDOUT, env=_clean_environment(),
            )
            try:
                _wait(self.process, lambda: "ready  " + self.origin in self.logs()[offset:],
                      60, "celld startup", self.logs)
                return
            except StepFailure:
                # Parallel tests can take the port between _free_port and the
                # bind; a port of our own choosing can simply be chosen again.
                taken = "Address already in use" in self.logs()[offset:]
                if self.fixed_port or not taken or attempt == 2:
                    raise
                self.stop()
                self._listen(_free_port())

    def stop(self):
        # celld's graceful shutdown is bounded at 35 seconds.
        _stop(self.process, 40)

    def restart(self):
        self.stop()
        self.start()

    def request(self, spec):
        body = spec.get("body")
        headers = dict(spec.get("headers", {}))
        if "json" in spec:
            body = json.dumps(spec["json"])
            headers.setdefault("content-type", "application/json")
        request = urllib.request.Request(
            request_url(self.origin, spec),
            data=None if body is None else body.encode(),
            method=spec.get("method", "GET" if body is None else "POST"),
            headers=headers,
        )
        try:
            with _opener().open(request, timeout=spec.get("timeout", 60)) as response:
                return _response(response.status, response.headers, response.read())
        except urllib.error.HTTPError as error:
            with error:
                return _response(error.code, error.headers, error.read())
        except OSError as error:
            raise StepFailure([f"the request failed: {error}"])

    def close(self):
        self.stop()
        self.log.close()


def _response(status, headers, data):
    """A response as specs see it. `headers` keeps the last value of a
    repeated header; `cookies` is every `Set-Cookie` line, in order."""
    text = data.decode(errors="replace")
    response = {"status": status, "headers": {k.lower(): v for k, v in headers.items()},
                "cookies": headers.get_all("set-cookie") or [], "text": text}
    try:
        response["json"] = json.loads(text)
    except ValueError:
        pass
    return response


def _wait(process, condition, seconds, phase, logs):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise StepFailure([f"the process exited during {phase}"], logs())
        value = condition()
        if value:
            return value
        time.sleep(0.02)
    raise StepFailure([f"timed out during {phase}"], logs())


# MARK: Specs


class StepFailure(Exception):
    def __init__(self, problems, logs=None):
        super().__init__("\n".join(problems))
        self.problems = problems
        self.logs = logs


def check(expect, response):
    problems = match(expect.get("status", 200), response["status"], "status")
    for key in ("json", "text", "headers", "cookies"):
        if key in expect:
            if key not in response:
                problems.append(f"{key}: the response has none; its text is {_short(response['text'])}")
            else:
                problems.extend(match(expect[key], response[key], key))
    if "sse" in expect:
        problems.extend(match(expect["sse"], parse_sse(response["text"]), "sse"))
    return problems


class Session:
    """A spec's world: its temporary directory, fake upstream and runtime."""

    def __init__(self, args, spec, root, live=False, port=None, extra_vars=()):
        self.upstream = None
        self.runtime = None
        self.cursor = 0
        self.saved = {}
        try:
            dev_vars = {}
            origin = ""
            if args.upstream and not live:
                self.upstream = Upstream(args.upstream, root)
                dev_vars.update({name: var_text(value) for name, value in self.upstream.vars.items()})
                origin = self.upstream.origin
            if not live:
                dev_vars.update({name: var_text(substitute(value, {"upstream": origin}))
                                 for name, value in spec.get("vars", {}).items()})
            for pair in extra_vars:
                name, _, value = pair.partition("=")
                dev_vars[name] = value
            self.runtime = Runtime(args.celld, args.project, root, dev_vars, port)
            self.runtime.start()
        except BaseException:
            self.close()
            raise

    def logs(self):
        parts = []
        if self.runtime is not None:
            parts.append("--- celld dev ---\n" + self.runtime.logs())
        if self.upstream is not None:
            parts.append("--- upstream ---\n" + self.upstream.logs())
        return "\n".join(parts)

    def run(self, step):
        step = substitute(step, self.saved)
        if step.get("restart"):
            self.runtime.restart()
        script = step.get("script", [])
        if script and self.upstream is None:
            raise StepFailure(["script: this example has no fake upstream"])
        for instruction in script if isinstance(script, list) else [script]:
            self.upstream.script(instruction)
        response = None
        if "request" in step:
            until = step.get("until")
            deadline = time.monotonic() + (until or {}).get("seconds", 0)
            while True:
                response = self.runtime.request(step["request"])
                problems = check(step.get("expect", {}), response)
                if not problems or until is None or time.monotonic() >= deadline:
                    break
                time.sleep(until.get("interval", 0.2))
        else:
            problems = []
        if "upstream" in step:
            if self.upstream is None:
                raise StepFailure(["upstream: this example has no fake upstream"])
            seen = self.upstream.requests(self.cursor)
            self.cursor += len(seen)
            mismatches = match(step["upstream"], seen, "upstream")
            if mismatches:
                mismatches.append(f"the upstream received {len(seen)} requests:")
                mismatches.extend(f"  {r['method']} {r['host']}{r['path']} {r['text'][:300]!r}"
                                  for r in seen)
            problems.extend(mismatches)
        if not problems:
            for name, path in step.get("save", {}).items():
                if response is None:
                    problems.append(f"save.{name}: the step made no request")
                    continue
                try:
                    self.saved[name] = extract(response, path)
                except KeyError:
                    problems.append(f"save.{name}: the response has no {path}")
        if problems:
            if response is not None:
                problems.append(f"the response was {response['status']}: {response['text'][:2000]}")
            raise StepFailure(problems)

    def close(self):
        try:
            if self.runtime is not None:
                self.runtime.close()
        finally:
            if self.upstream is not None:
                self.upstream.close()


def test(args, spec):
    steps = spec["steps"]
    with tempfile.TemporaryDirectory(prefix="celld-example-") as temporary:
        started = time.monotonic()
        try:
            session = Session(args, spec, Path(temporary))
        except StepFailure as failure:
            print(f"not ok - setup: {failure}\n{failure.logs or ''}", flush=True)
            return 1
        print(f"# {Path(args.spec).name}: {len(steps)} steps, celld ready in "
              f"{time.monotonic() - started:.1f}s", flush=True)
        try:
            for number, step in enumerate(steps, 1):
                begun = time.monotonic()
                name = step.get("name", f"step {number}")
                try:
                    session.run(step)
                except StepFailure as failure:
                    print(f"not ok {number} - {name}", flush=True)
                    for problem in failure.problems:
                        print(f"  {problem}", flush=True)
                    print(session.logs(), flush=True)
                    return 1
                print(f"ok {number} - {name} ({time.monotonic() - begun:.2f}s)", flush=True)
        finally:
            session.close()
    return 0


def dev(args, spec):
    temporary = None
    if args.state:
        root = Path(args.state).resolve()
        root.mkdir(parents=True, exist_ok=True)
    else:
        temporary = tempfile.TemporaryDirectory(prefix="celld-example-dev-")
        root = Path(temporary.name)
    session = Session(args, spec, root, live=args.live, port=args.port, extra_vars=args.var)
    try:
        print(f"example ready at {session.runtime.origin} (state in {root})")
        if session.upstream is not None:
            print(f"fake upstream at {session.upstream.origin}; its requests: "
                  f"{session.upstream.origin}/__upstream/requests")
        print("the spec's requests:")
        for step in spec["steps"]:
            request = step.get("request")
            if request is None:
                continue
            line = ["curl", "-sS", "-X", request.get("method", "POST" if "json" in request else "GET")]
            if "json" in request:
                line += ["-H", "content-type: application/json", "-d", json.dumps(request["json"])]
            line.append(request.get("url") or session.runtime.origin + request.get("path", "/"))
            print("  " + shlex.join(line))
        print("Ctrl-C stops it.", flush=True)
        session.runtime.process.wait()
    except KeyboardInterrupt:
        pass
    finally:
        session.close()
        if temporary is not None:
            temporary.cleanup()
    return 0


def interrupted(signum, _frame):
    """Unwind the cleanups before exiting when the runner cancels the test."""
    raise KeyboardInterrupt(f"received signal {signum}")


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("mode", choices=["test", "dev"])
    parser.add_argument("--celld", required=True, type=Path)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--upstream", help="the fake upstream's command line")
    parser.add_argument("--port", type=int, default=9876, help="dev: the Worker's port")
    parser.add_argument("--live", action="store_true", help="dev: no fake upstream")
    parser.add_argument("--state", help="dev: keep the project and its storage here")
    parser.add_argument("--var", action="append", default=[], metavar="NAME=VALUE",
                        help="dev: a Worker variable (repeatable)")
    args = parser.parse_args(argv)
    args.celld, args.project = args.celld.resolve(), args.project.resolve()
    spec = json.loads(args.spec.read_text())
    signal.signal(signal.SIGTERM, interrupted)
    return test(args, spec) if args.mode == "test" else dev(args, spec)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
