# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""HTTP clients for the WormLog and WormPaxos routes, for the fleet scenarios.

Every call returns `(status, body)` or raises `celld_fleet.Unreachable`; the
scenarios decide what a status means. Log records are bytes here and base64 on
the wire. The chain readers go around both layers, straight to the segment
routes, so an audit trusts nothing but the registers.
"""

import base64
import json
import urllib.error
import urllib.request

from celld_fleet import Unreachable, resilient


class LayerClient:
    """POST-only JSON over loopback, never through a proxy."""

    def __init__(self, origin, timeout=30):
        self.origin = origin
        self.timeout = timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def retarget(self, origin):
        self.origin = origin
        return self

    def call(self, path, body=None, timeout=None, method="POST"):
        data = None if method == "GET" else json.dumps(body or {}).encode()
        request = urllib.request.Request(
            self.origin + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=timeout or self.timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                raw = error.read()
            try:
                return error.code, json.loads(raw)
            except ValueError:
                return error.code, {"raw": raw.decode(errors="replace")}
        except Exception as error:  # noqa: BLE001 - URLError, timeout, reset, EOF
            raise Unreachable(f"{path} -> {error!r}") from error

    def segment_read(self, name, start, count=1000):
        return self.call(f"/v1/segments/{name}/read", {"start": start, "count": count})

    def segment_status(self, name):
        return self.call(f"/v1/segments/{name}", method="GET")


class LogClient(LayerClient):
    def __init__(self, origin, name, timeout=30):
        super().__init__(origin, timeout)
        self.name = name

    def op(self, operation, body=None, timeout=None):
        return self.call(f"/v1/wormlog/{self.name}/{operation}", body, timeout)

    def init(self, size):
        return self.op("init", {"size": size})

    def append(self, value):
        return self.op("append", {"value": base64.b64encode(value).decode()})

    def read(self, start, count=1000):
        return self.op("read", {"from": start, "count": count})

    def tail(self):
        return self.op("tail")

    def fill(self, slot):
        return self.op("fill", {"slot": slot})


class ReplicaClient(LayerClient):
    def __init__(self, origin, group, replica, timeout=60):
        super().__init__(origin, timeout)
        self.group = group
        self.replica = replica

    def op(self, operation, body=None):
        return self.call(f"/v1/wormpaxos/{self.group}/{self.replica}/{operation}", body)

    def init(self, size):
        return self.op("init", {"size": size})

    def propose(self, command):
        return self.op("propose", {"command": command})

    def learn(self):
        return self.op("learn")

    def get(self, key):
        return self.op("get", {"key": key})

    def state(self):
        return self.op("state")


def settled(call, *args, what=None, budget=180.0):
    """`resilient`, then insist on a 200."""
    status, body = resilient(call, *args, budget=budget)
    if status != 200:
        raise AssertionError(f"{what or getattr(call, '__name__', call)}{args} -> {status} {body}")
    return body


def read_log(client):
    """Every issued slot of the log, as (slot, state, bytes or None), paged."""
    tail = settled(client.tail)
    position = tail["trimmedThrough"] + 1
    entries = []
    while position < tail["next"]:
        page = settled(client.read, position)
        if not page["entries"]:
            break
        for entry in page["entries"]:
            value = base64.b64decode(entry["value"]) if "value" in entry else None
            entries.append((entry["slot"], entry["state"], value))
        position = page["entries"][-1]["slot"] + 1
    return entries, tail


def read_chain(client, group, size):
    """Every register of a WormPaxos chain, straight from the segments.

    Returns a list with, per address, `"pending"` or the decoded command (a
    dict), or `None` for a written register that is not a command.
    """
    registers = []
    index = 0
    while True:
        status = settled(client.segment_status, f"{group}.{index}")
        if not status["allocated"]:
            return registers
        position = 0
        while position < size:
            window = settled(client.segment_read, f"{group}.{index}", position)
            for register in window["registers"]:
                if register["state"] != "written":
                    registers.append("pending")
                    continue
                raw = base64.b64decode(register["value"])
                command = None
                if raw[:1] == b"\x00":
                    try:
                        command = json.loads(raw[1:].decode())
                    except ValueError:
                        command = None
                registers.append(command)
            position = window["registers"][-1]["offset"] + 1
        index += 1


def replay(commands):
    """The key/value table a replica holds after applying `commands`."""
    table = {}
    for command in commands:
        if not isinstance(command, dict):
            continue
        if command.get("op") == "set":
            table[command["key"]] = command["value"]
        elif command.get("op") == "del":
            table.pop(command["key"], None)
    return table
