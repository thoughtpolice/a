<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# burrow

Burrow carries authenticated byte streams and policy-controlled routed TCP over
iroh. It keeps the small `stdin`/`stdout` interface that makes a good OpenSSH
`ProxyCommand`, but the protocol is not tied to SSH: it also provides a
Tailcat-style one-way output pipe, selected server ports, local TCP listeners,
SOCKS5 CONNECT requests, explicit TCP exit routing, and path-aware pings.

Both peers keep durable Ed25519 identities. A shareable `br1...` address
contains the server ID, relay, and optional direct hints; it is routing
metadata, not an authorization token. The server still authenticates and
allowlists every client identity.

## Start a server

First print the client identity on the machine that will dial:

```text
burrow id
```

Then serve at home and allow that identity:

```text
burrow serve --allow <client-endpoint-id>
```

The server prints a self-contained `br1...` address. By default, `default`
forwards to `127.0.0.1:22`, and clients may explicitly select local port 22.
Configure more loopback ports with lists and ranges:

```text
burrow serve --allow <client-id> --ports 22,80,8000-8999
```

Use `--ports all` to expose every loopback TCP port to allowlisted clients.
This is broader than the default allowlist and still does not enable arbitrary
network destinations; that separately requires `--exit-node`.

`--target 127.0.0.1:2222` changes only the `default` route. Repeated
`--advertise IP:PORT` values add known externally reachable direct hints to the
printed address.

The global `--relay` defaults to iroh's NA-East production relay. Override it
for any command with, for example, `burrow --relay <URL> serve ...`; a printed
`br1...` address records the selected server relay for its clients.

## Connect and SSH

Raw stdin/stdout remains the default:

```text
burrow connect <br1-address>
burrow connect <br1-address> 8000
```

An OpenSSH configuration needs no Burrow-specific SSH implementation:

```text
Host home
    ProxyCommand burrow connect <br1-address>
```

A local TCP listener reuses one multiplexed server connection:

```text
burrow connect <br1-address> 8000 --listen 127.0.0.1:8080
```

Legacy bare endpoint IDs remain accepted. They use the global `--relay` and
any repeated `--addr IP:PORT` hints; a `br1...` address carries its own server
relay.

## One-shot pipe to stdout

`pipe` is a Tailcat-style one-way sink. It copies exactly one authenticated
client's stdin to the server process's stdout, then exits after that committed
stream reaches EOF and stdout has flushed successfully:

```text
# server; the br1 address is printed on stderr, leaving stdout as payload
burrow pipe --allow <client-id>

# client
printf 'hello\n' | burrow connect <br1-address>
```

The server address goes to stderr so binary data written by the remote client
is the only content on stdout. Server stdin is ignored and no payload travels
back to the client. Completion follows the byte stream, not the lifetime of its
underlying QUIC connection. `--advertise IP:PORT` adds direct address hints just
as it does for `serve`.

Only `default` is accepted, and the policy atomically lends the pipe once.
Other targets and requests after the first committed stream are denied. A
request whose abort reaches the server before it successfully writes the
positive acknowledgement returns the reservation, so a later client can still
claim it. The endpoint still requires `--allow`; the address is routing
metadata, not authorization.

## SOCKS5

Run a persistent loopback SOCKS proxy:

```text
burrow socks <br1-address>
```

Or launch one child with both `ALL_PROXY` and `all_proxy` set to an ephemeral
`socks5h://` listener:

```text
burrow socks <br1-address> -- curl https://example.com/
```

A self-contained address can instead be the requested hostname. In that mode
the fixed server is optional, and one SOCKS proxy can reuse bounded connections
to several Burrow servers:

```text
# child mode; the URL's br1 address chooses the server
burrow socks -- curl http://<br1-address>:8080/

# persistent dynamic proxy; prints its socks5h:// address
burrow socks
```

The port following a `br1...` hostname selects an allowed loopback port on
that named server. Address hostnames are case-sensitive and must fit in the
SOCKS5 name field (at most 255 bytes); ordinary addresses without a large set
of direct hints fit. CLI HTTP clients generally preserve them, but browsers
may lowercase hostnames and are not supported for this form.

With a fixed server, `server.burrow:<port>` selects one of its allowed loopback
ports. Ordinary DNS names are resolved by that Burrow server. Every ordinary
name or IP literal requires both a fixed server and its explicit `--exit-node`
flag; without either, those destinations are rejected:

```text
burrow serve --allow <client-id> --exit-node
```

That flag is intentionally powerful: every allowlisted client may request any
TCP destination reachable by the server. SOCKS authentication is not provided;
even a loopback listener may be usable by other local users.

SOCKS BIND and UDP ASSOCIATE are rejected. Burrow currently routes TCP byte
streams only.

## Inspect paths

```text
burrow ping <br1-address>
burrow ping <br1-address> --until-direct --timeout 10s
burrow parse <br1-address>
```

Ping reports the protocol round trip and iroh's selected relay or direct path.
`--until-direct` keeps probing until the deadline rather than treating a
working relay path as failure.

## Library boundary

The Burrow package's reusable [core library](core/) owns the versioned address
and request protocol, shared client connection manager, bounded server
admission, and cancellation-safe byte-stream splice. It accepts an
already-built iroh endpoint, so it does not choose a TLS provider, key storage,
relay, logging stack, or command-line policy.

The `tilde/aseipp/burrow` binary owns those application choices: BoringSSL,
durable identities, the endpoint allowlist, loopback/exit routing policy,
stdio and listener adapters, and SOCKS5. This is the useful part of Tailcat's
library/application split without copying its WireGuard and userspace-network
stack internals into an iroh-native tool.

## Protocol and resource model

Every QUIC bidirectional stream begins with a bounded version-1 request and a
structured response. Caller-supplied bytes are not written into the stream
until the server acknowledges authorization and target setup, so a failure
before that acknowledgement can be retried once without replaying caller
payload. A retry can still create a second target connection, and a target may
produce server-first activity before its acknowledgement reaches the client.

The server independently bounds pending handshakes, authenticated connections,
streams per connection, and streams across the process. It uses QUIC Retry
before expensive handshakes, imposes hard deadlines, and gives live
connections a nonzero application close on shutdown so truncated transfers do
not look like successful EOF.

Those bounds apply once iroh yields an incoming connection. In iroh 1.0.3,
the public endpoint API does not expose a way to tune its internal pre-accept
queue. Burrow continuously drains that queue, retries/refuses excess work,
and keeps its own handshake and connection tasks bounded, but enforcing an
absolute cap on the earlier internal queue requires an upstream API or a
patched dependency.

The current protocol carries bidirectional byte streams for routed TCP, while
the one-shot pipe deliberately exposes only a client-to-server output sink. A
built-in SSH server is unnecessary for the primary use case because
`ProxyCommand` reaches the machine's authenticated SSH service. UDP forwarding,
browser/WASM support, and DNS TXT aliases would each need their own protocol or
platform design and are not silently approximated by TCP exit mode.
