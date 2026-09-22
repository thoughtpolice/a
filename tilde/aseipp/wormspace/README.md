<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# wormspace

WormSpace's write-once segments on celld: a small API of fixed-size segments of
write-once registers, from which consensus-shaped systems can be built without
writing any consensus code.

The abstraction is from Shin, Kim, Honoré, Vanzetto, Radhakrishnan,
Balakrishnan, and Shao, _Write-Once Registers: A Modular Foundation for Simple,
Verifiable Distributed Systems_, Yale technical report YALEU/DCS/TR1544 (2018).
The paper's write-once register (WOR) exposes `capture`, `write`, and `read`, and
its write-once segment (WOS) groups WORs for allocation and garbage collection.
The paper builds WormPaxos (Multi-Paxos), WormLog (a shared log), and WormTX (a
transaction coordinator) on top of that API alone.

Each segment here is one Durable Object (`class Segment`, binding `SEGMENTS`,
script `wormspace`), addressed by a client-chosen name. The paper's integer
`segno` becomes that name, and its single contiguous address space becomes a
[segment chain](#segment-chains): a naming and metadata convention with a
client-side helper, not a service.

Two of the paper's applications are built on top, using nothing but the
segment API and chains: [WormLog](#wormlog), a CORFU-style shared log with a
`Sequencer` cell (binding `SEQUENCERS`), and [WormPaxos](#wormpaxos), state
machine replication whose replicas are `Replica` cells (binding `REPLICAS`).

## Registers

A segment holds `size` registers at offsets `0..size-1`. Every register is, for
as long as it exists, in one of three states:

| State       | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `unwritten` | nobody has captured or written it (`round` 0)            |
| `captured`  | a round holds it, and only a write under that round lands |
| `written`   | its value is immutable, forever                          |

Each register is a single-shot Paxos instance, and the cell's single owner
stands in for the acceptor quorum. celld gives a cell exactly one active owner
with epoch fencing and acknowledges a write only once it is durable, so a quorum
of acceptors collapses into one serialized state machine:

| Paxos                     | Here                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| phase 1 (prepare, ballot) | `capture` takes the next round, `nextRound++`, for a range                 |
| promise                   | the effective round of an offset: the highest round whose range covers it |
| phase 2 (accept)          | `write` with `captureId` lands only if it is still the effective round     |
| chosen value              | a written register; later captures cannot touch it                         |
| learn                     | `read`                                                                     |

A write carrying `captureId = R` lands at an offset only if the register is
unwritten and its effective round is exactly `R`. If a later capture covered
the offset, the write is refused with `CAPTURE_STALE`, naming the round that
holds it. That is a steal, and stealing is the point: capture is a preemptible
lock, never a lease, and nothing in it expires.

## API

Every method returns a result object with an `ok` flag and, when `ok` is false,
a `code` and a `message`. Nothing throws for a domain outcome. The Durable
Object RPC methods and the HTTP routes are the same seven operations:

| Operation                                 | Route                                |
| ----------------------------------------- | ------------------------------------ |
| `status()`                                | `GET /v1/segments/{name}`            |
| `alloc({size, metadata, allocator?})`     | `POST /v1/segments/{name}/alloc`     |
| `capture({start, end?, owner?})`          | `POST /v1/segments/{name}/capture`   |
| `write({start, values, captureId})`       | `POST /v1/segments/{name}/write`     |
| `read({start, count?, maxBytes?})`        | `POST /v1/segments/{name}/read`      |
| `trim({through})`                         | `POST /v1/segments/{name}/trim`      |
| `listen({since, timeoutMs?})`             | `POST /v1/segments/{name}/listen`    |

Over HTTP the request is the JSON body and `metadata` and `values` are base64;
over RPC they are `Uint8Array`s. Segment names match
`^[a-z0-9][a-z0-9._-]{0,127}$`.

- `alloc` allocates the segment for the first caller and returns
  `{size, allocatedMs}`. Every later caller, including a replay of the winner,
  gets `ALREADY_ALLOCATED` carrying the winning `size`, `metadata`, `allocator`,
  and `allocatedMs`: the paper's `alloc` and `check` in one call.
- `capture` takes the next round for `[start, end)` (`end` defaults to
  `start + 1`) and returns `{captureId, start, end, alreadyWritten}`, where
  `alreadyWritten` counts registers in the range that no capture can affect. A
  range straddling the trim mark is clipped to start just past it, and the
  reply's `start` says so.
- `write` writes `values` to `start..start+values.length-1`, all or none, and
  returns `{start, end}`. The first offset that refuses decides the reply.
- `read` returns every register in the window with its `state` and `round`
  (the writing round for a written register, the effective round otherwise)
  and, when written, its `value`. Holes are reported, never skipped.
- `trim` deletes every register and capture at or below `through` and returns
  `{trimmedThrough, deleted}`. It is monotone and idempotent.
- `listen` waits for registers to be written and returns `{writes, changed}`;
  see [Listening](#listening).
- `status` reports `allocated`, `size`, `metadata`, `allocator`, `allocatedMs`,
  `nextRound`, `writtenCount` (written registers above the trim mark),
  `writes` (registers ever written, trimmed or not; it only grows),
  `captures` (stored capture rows), `trimmedThrough` (-1 before the first
  trim), and `databaseSize`.

| `code`              | Status | Meaning                                                           |
| ------------------- | ------ | ----------------------------------------------------------------- |
| —                   | 200    | `ok`                                                              |
| `INVALID`           | 400    | Malformed request, or a `captureId` that was never issued         |
| `OUT_OF_RANGE`      | 400    | An offset or range outside `0..size-1`                            |
| `TOO_LARGE`         | 413    | A value, batch, metadata, body, or the capture-row cap exceeded   |
| `UNALLOCATED`       | 409    | Nobody has allocated the segment                                  |
| `ALREADY_ALLOCATED` | 409    | Somebody already did; the reply says who and with what            |
| `ALREADY_WRITTEN`   | 409    | The register at `offset` is written; `sameValue` compares bytes   |
| `CAPTURE_STALE`     | 409    | `offset`'s effective `round` is not your `captureId`              |
| `TRIMMED`           | 410    | The position is at or below `trimmedThrough`                      |
| `UNAVAILABLE`       | 503    | celld could not reach the owner or prove a write; retry           |
| `INTERNAL`          | 500    | A bug                                                             |

An unknown route is 404. `UNAVAILABLE` and `INTERNAL` exist only on the HTTP
edge, and are classified exactly as the journal classifies them
(`retryableCause` in [src/http.ts](src/http.ts), copied from the journal):
celld's routing error, the "remote RPC transport failed" error a surviving node
throws while a crashed owner is still being dialled, "route RPC …:
RestoreFailed", and "route failed: DurabilityUnproven" are 503 with
`Retry-After: 1`; anything else thrown is 500.

## Listening

`listen` is the paper's `WOS_listen` as a bounded long poll, so a reader can
tail a segment without polling `read`:

```
writes = 0
loop:
  writes = listen({since: writes}).writes
  read(...) the registers it has not seen yet
```

Each segment keeps a counter, `writes`, of registers ever written: every
accepted `write` adds the number of registers it wrote, in the same
transaction, and nothing else moves it (a trim lowers `writtenCount`, never
`writes`). `listen({since, timeoutMs?})` answers at once with `changed: true`
when `writes > since`. Otherwise it parks until a write raises the counter past
`since` (`changed: true` and the new value) or `timeoutMs` passes
(`changed: false` and the current value). `timeoutMs` defaults to 10 seconds
and is at most 25 (`INVALID` above), and 0 makes it a poll. A `since` above the
counter is allowed: it parks until the next write, and its timeout hands back
the real value.

No listener learns of a write before it is durable. A parked listener is woken
by the write's own call once its `sync()` has returned, and a `listen` that
answers from the counter awaits `sync()` first, because the counter may include
a write that has committed and is still at its barrier.

A parked listener lives only in the memory of the cell that holds it, so it is
a hint, never a delivery guarantee:

- An evicted, moved, or restarted cell drops its listeners. The caller sees a
  transport error or a 503, and must ask again **from the same `since`**; the
  counter is durable, so nothing a reader has not seen is lost, only the wakeup.
- A `listen` never replaces reading. Read what the counter says is there.

Measured on celld 0.5.1: a parked listener returns within a millisecond of the
write's reply (about 50 ms after the write was sent, which is the durability
barrier), on the owner and through a peer node's tunnel alike; a 25-second park
completes normally both under `celld dev` and on a fleet whose
`CELLD_OPERATION_DEADLINE_MS` is 5 seconds, so that deadline does not bound a
parked call. On a graceful stop, celld cuts the parked HTTP connection after its
2-second drain grace, but the process does not exit until the parked call's
timer runs out: a parked `listen` delays shutdown by up to its remaining
timeout, which the 25-second cap keeps inside celld's 35-second graceful bound.

## Captures are ranges

Captures are stored as ranges, not per register: one row
`(round, start, end, owner, captured_ms)` per capture. The effective round of
an offset is `MAX(round)` over the rows covering it, or 0. So:

- A batch capture of a whole segment, the paper's sticky leader, is one row
  and one statement, however large the segment.
- A capture deletes every row lying entirely inside its own range: those rows
  can never be the effective round anywhere again. A leader that re-captures
  the whole segment on every takeover therefore keeps the table at one row.
- Written registers remember the round that wrote them, so no capture row is
  needed to explain a written register.
- At most 4096 rows are kept (`TOO_LARGE` beyond that, counting the rows the
  new capture would prune), which bounds every effective-round scan. A trim
  deletes the rows wholly at or below its mark.

## Replaying a write

A register is written at most once, so a write whose reply was lost needs no
operation table. Replay it with the same bytes:

- `ok` — it had not landed, and now has;
- `ALREADY_WRITTEN` with `sameValue: true` — it had landed (or someone wrote
  identical bytes, which for a write-once register is the same outcome);
- `ALREADY_WRITTEN` with `sameValue: false` — someone else won the register;
- `CAPTURE_STALE` — the capture was stolen before the write landed, so the
  write did not land.

A reader can equally settle it by reading the register back.

`ALREADY_WRITTEN` with `sameValue: true` is the one refusal that waits for a
durability barrier before it answers: the register it found may have been
committed by the very call whose reply was lost, and still be at its barrier,
and a replay takes that answer as proof the write landed. Every other refusal
tells a writer only that its own write did not land, which needs no barrier.

## The unsafe write

A write with `captureId: 0` is the paper's unsafe write: no capture round trip.
This service accepts it only on a register **no one has ever captured**
(effective round 0). That is stricter than the paper, where an unsafe write is
simply a write the application promises not to race; here, a capture always
wins over an unsafe writer, so mixing the two on the same register can never
lose a captured writer's promise.

## Segment chains

A segment is the unit celld places, fences, and moves, so it is also the unit of
sharding: one busy log in one giant segment would be one cell's worth of
throughput and storage forever. The paper's shared address space is therefore a
chain of same-sized segments, as a client-side convention in
[src/chain.ts](src/chain.ts). No Durable Object or route knows about it.

- Link `i` of chain `c` is the segment named `c.i` (decimal, unpadded, from 0),
  and global address `a` is offset `a % size` of link `a / size`
  (`chainAddress`, `chainPosition`).
- Every link's allocation metadata is the UTF-8 JSON
  `{"chain": c, "index": i, "size": s}`. A segment whose metadata does not
  decode to exactly those three fields is not a chain segment
  (`encodeChainMetadata`, `decodeChainMetadata`).
- The size is fixed for the whole chain, by whoever allocates link 0;
  `Chain.open` reads it back from there.
- Chain names match `^[a-z0-9][a-z0-9._-]{0,116}$`, leaving room for the dot
  and the ten digits of the largest index, `2^32 - 1`. With the largest
  segment, the last address is `2^48 - 1`, a safe integer.

`Chain` runs over a resolver `(name) => SegmentAPI`, so the same code runs in a
Worker (`(name) => env.SEGMENTS.getByName(name)`), in another Durable Object,
and in a Deno test over the fake segment:

- `allocate(index, allocator?)` allocates link `index` with the convention's
  metadata and size. Allocation is first-writer-wins per link, so any number of
  clients can race to extend a chain safely: one creates each link, and every
  other one (including a creator replaying a lost reply) gets
  `ALREADY_ALLOCATED`, which `allocate` checks against the chain and index and
  turns into `created: false`, or `CHAIN_MISMATCH` when some other segment holds
  the name. Links are allocated in order: `allocate(i)` is `UNALLOCATED` unless
  link `i - 1` exists, so a chain's links are always a prefix `0..n-1`. It
  replies with the link's `status`.
- `tail({fromIndex})` walks forward from a hint to the first unallocated link
  and returns the last allocated one with its status, or `null` for an empty
  chain. It costs one `status` per link walked, so pass the last index you know;
  a hint past the end walks back.

Transport failures are thrown through untouched, and both methods are safe to
repeat after one.

## Limits

Segment size `[1, 65536]`, metadata 64 KiB, allocator and owner names 1..128
characters, value 1 MiB, write batch 4 MiB and 1000 values, read `count` 1000
(default 100), read `maxBytes` 4 MiB (default 1 MiB), 4096 capture rows,
`listen` timeout 25 seconds (default 10), HTTP body 8 MiB. A read always returns at least one register, even if its value
alone exceeds `maxBytes`, and holes cost nothing against the budget; only the
values the budget admits are loaded from SQLite.

**v1 assumes a trusted network.** There is no authentication.

**There is no schema migration story yet.** The constructor creates the tables
with `CREATE TABLE IF NOT EXISTS` and nothing is deployed, so a column change
(like `writes` on `segment_meta`) simply edits the `CREATE TABLE`. A segment
created by an older version would keep its old table and fail to load.

## Entries

Both layers store the same thing in a register: one tag byte and what follows
it ([src/entry.ts](src/entry.ts)).

| Bytes           | Entry                                                      |
| --------------- | ---------------------------------------------------------- |
| `0x00` + payload | a record (WormLog) or a command (WormPaxos); may be empty |
| `0x01`          | a filled hole: a slot nobody will ever write               |

Anything else is not an entry: WormLog reads it back as `corrupt`, and every
WormPaxos replica skips it exactly as it skips a `noop`. Only the holder of a
segment's capture can write it, so a chain written only through these layers
never holds one. A payload is at most 1 MiB less the tag byte.

## WormLog

A shared log in the style of CORFU, as in TR1544 §4.2: clients append records
to a totally ordered log and read them by position. Log `l` is the segment
chain `l` plus one `Sequencer` Durable Object named `l`
([src/sequencer_core.ts](src/sequencer_core.ts),
[src/sequencer.ts](src/sequencer.ts)). Slot `s` of the log is global address
`s` of the chain. The client side ([src/wormlog.ts](src/wormlog.ts)) runs in
the Worker, over the sequencer's stub and the segment resolver, and in a Deno
test over the fakes.

**The round-trip argument.** CORFU's append is a token from a sequencer and a
write. Over plain write-once registers it would be three round trips: the
token, a capture of the slot, and the write. The paper's trick, which this
follows, is that the sequencer allocates each segment and captures all of it
before handing out any slot in it, and hands every appender the round it holds
along with the slot. An append is then:

1. `next()` on the sequencer: the slot, its segment and offset, and the round;
2. one `write` of the record under that round.

The first slot of each segment also pays for allocating the segment (in order,
through `Chain.allocate`) and capturing it, inside that one `next`. Under
`celld dev` an append takes about 42 ms (two durability barriers: the
sequencer's counter, then the register), and the first one in a segment about
130 ms.

The pieces:

- `next()` issues the next slot only once the counter that issued it is
  durable, so a slot is never issued twice, even across a crash of the
  sequencer's node.
- An appender whose write's reply is lost replays the same bytes, and
  `ALREADY_WRITTEN` with `sameValue: true` proves it landed. A slot somebody
  filled first (`sameValue: false`) costs a new token. `CAPTURE_STALE` means
  somebody captured the segment over the sequencer (an operator, say): the
  appender reports it with `recapture`, which takes a new round unless a newer
  one is already held, and takes a new token. A slot is never reused for a
  different record, and after 8 tokens the append gives up with `CONTENDED`.
- A token whose appender never writes (it crashed, or the token's reply was
  lost) leaves its slot `pending`. `fill(slot)` closes it: the sequencer writes
  the hole entry under its own round. Filling a slot that holds a record
  changes nothing and says so (`hole: false`), and a slow appender whose slot
  was filled gets `ALREADY_WRITTEN` and moves on. The paper lets any client
  fill a hole; here the one holder of the capture does, so no capture is ever
  stolen to fill one.
- `read(from, count?)` reports every issued slot in the window as `value`
  (with the record), `hole`, `pending`, or `corrupt`, reading each segment the
  window touches. Slots at or past `next` are not reported.
- `trim(through)` trims every segment up to the slot (whole segments below it,
  part of the one holding it) and then records the mark on the sequencer, so a
  trim interrupted in between is redone whole by the next one.
- `listen(from, since, timeoutMs?)` is the segment `listen` on the segment
  holding `from`, with that segment's `writes` counter; `UNALLOCATED` means the
  log has not reached that segment yet.
- `init(size)` fixes the segment size (default 4096, anything from 1 to
  65536) before the first slot is issued; after that, or if link 0 already
  exists with another size, it is `CONFLICT`. Small sizes make tests cross
  segment boundaries cheaply.

**What is simpler than the paper, and why.** The paper's sequencer is soft
state: a hint that can be lost, after which a new one must rebuild the tail by
scanning, and CORFU needs a seal-and-recover protocol for it. Here the
sequencer is a cell: celld gives it exactly one owner, fences the old one, and
acknowledges its counter only once it is durable, so there is no recovery
protocol, and a sequencer restarted on another node carries on from its next
slot. There is no reconfiguration either: the paper replaces failed
wormservers with Vertical Paxos, and here the acceptor set is celld's single
owner of each segment, which celld itself moves.

**Guarantees.** A `200` from `append` means the record is at exactly that slot,
once. A `503` means the outcome is unknown: the record may have landed, and
appending it again may put it in the log twice, so appends are at least once
across a `503` (records that must not repeat carry their own identity). Every
record in the log was sent by some append, and every append attempt writes at
most one slot.

| Operation                             | Route                                  |
| ------------------------------------- | -------------------------------------- |
| `init({size})`                        | `POST /v1/wormlog/{log}/init`          |
| `append({value})`                     | `POST /v1/wormlog/{log}/append`        |
| `read({from, count?})`                | `POST /v1/wormlog/{log}/read`          |
| `tail()`                              | `POST /v1/wormlog/{log}/tail`          |
| `fill({slot})`                        | `POST /v1/wormlog/{log}/fill`          |
| `trim({through})`                     | `POST /v1/wormlog/{log}/trim`          |
| `listen({from, since, timeoutMs?})`   | `POST /v1/wormlog/{log}/listen`        |

Log names are chain names. `value` and each read entry's `value` are base64.
`append` answers `{slot, attempts}`; `read` answers `{entries, next,
trimmedThrough, size}`; `tail` and `trim` answer `{log, size, next,
trimmedThrough}`; `fill` answers `{slot, hole}`.

## WormPaxos

State machine replication over a chain, as in TR1544 §4.1: the command
sequence is the chain's address space, replicas learn it by reading in order,
and they propose by writing the next free address. There is no consensus code
here beyond what a segment already is: each address is a write-once register,
so whatever lands there is the command at that position for every replica.

Replica group `g` is the segment chain `g`. Each replica is a `Replica`
Durable Object named `g.<replica>` ([src/replica_core.ts](src/replica_core.ts),
[src/replica.ts](src/replica.ts)), with replica names matching
`^[a-z0-9][a-z0-9_-]{0,31}$`. Its state machine is a key/value table, `kv(key
TEXT PRIMARY KEY, value BLOB)`, and commands are the UTF-8 JSON
`{"op":"set","key":k,"value":v}`, `{"op":"del","key":k}`, and `{"op":"noop"}`
(keys 1..1024 characters, values strings). Its meta row holds `applied`, the
global address of the next command to apply, and its leadership, if any: the
segment it holds a batch capture on, the round, and its private view of the
next free offset there.

- `learn({maxCommands?})` reads forward from `applied` and applies every
  written entry in order, stopping at the first register nobody has written
  (`blocked`) or at the end of the allocated chain. A `set` or `del` changes
  the table; a `noop`, a hole entry, or anything that is not a command changes
  nothing, identically on every replica. Each window read is applied and
  committed with the meta row in one transaction.
- `propose({command})` is sticky. A replica that leads, and has applied
  everything up to its own tail, writes the command at the tail under its
  round and nothing else: **one round trip to one segment**, which is the
  paper's argument for sticky leadership. Otherwise it learns to the tail and
  takes over the segment holding `applied`: allocates it if the chain ends
  there, captures the whole segment (a new round, which fences every older
  writer at its next write), writes `noop` under the new round into every
  unwritten register below the highest written one, learns through them, and
  then writes. A refused write means somebody took over in the meantime: the
  replica drops its leadership and starts again, up to 8 times, and then
  answers `CONTENDED`. A lost reply is replayed with the same bytes, as
  anywhere else. When the segment fills, the next proposal takes over the next
  link. The proposer applies its own command before it answers, so it reads
  its own writes; the answer is `{address, term, applied}`, where `term` is the
  round, which is per segment (a new link's rounds start at 1 again).
- `get({key})` reads the local table (the RPC method is `lookup`: `get` is a
  reserved member of every Durable Object stub). It is as fresh as the
  replica's last `learn` or `propose`; learn first for a read that must see
  another replica's writes.
- `state()` reports `applied`, `leader`, `size` (the chain's, `null` before
  link 0 exists), and `preferredSize`.
- `init({size})` sets the size this replica creates link 0 with, if it is the
  one to; once the chain exists its size is link 0's, and `init` with another
  size is `CONFLICT`. A replica that preferred another size adopts the chain's.

Leadership is kept exactly as long as nothing surprises it: a learner that
applies the register at its own tail advances the tail if that register was
written under its round or an earlier one (its own write, or one that landed
before its capture), and drops the leadership if a later round wrote it. A
replica leads only while `applied` is exactly its tail. Every proposal by a
replica that does not lead is a steal, which is a policy, not a rule: the
paper leaves "who calls capture" to the application, and forwarding proposals
to the current leader would be a client-side change.

Under `celld dev` a sticky proposal takes about 43 ms (the segment write's
barrier and the replica's own), and a takeover by a replica that had learned
nothing about 225 ms. A call through the Replica cell to a segment costs no
measurable time over the Worker calling the segment directly (a `learn` at the
tail and a plain segment `read` both take under 5 ms): the cost of these layers
is their durability barriers, not the extra hop.

**What is simpler than the paper, and why.** No reconfiguration, for the same
reason as WormLog. The paper's flexible durability (trimming the address space
once enough replicas have applied it, or a snapshot exists) is not here yet:
replicas never trim, and a replica whose next address was trimmed by an
operator answers `TRIMMED`.

**Holes.** A replica here writes strictly at its tail and never writes past a
register it has not settled, so the holes the takeover fills come from writers
that do: a leader that pipelines several proposals and crashes mid-batch, or
any other client of the segments. The fill is still the takeover's job,
because a hole must be closed before anything behind it can be applied, and a
`noop` under the new round is the paper's answer.

| Operation              | Route                                         |
| ---------------------- | --------------------------------------------- |
| `init({size})`         | `POST /v1/wormpaxos/{group}/{replica}/init`    |
| `propose({command})`   | `POST /v1/wormpaxos/{group}/{replica}/propose` |
| `learn({maxCommands?})` | `POST /v1/wormpaxos/{group}/{replica}/learn`  |
| `get({key})`           | `POST /v1/wormpaxos/{group}/{replica}/get`     |
| `state()`              | `POST /v1/wormpaxos/{group}/{replica}/state`   |

The route names the replica; a body cannot redirect a call to another cell.

## Layer mechanics and limits

Both layers share their discipline with the segment cell, plus two rules for
code that calls other cells:

- **One call at a time per cell.** `Sequencer` and `Replica` methods read their
  meta, call segments, and write their meta back, and two calls on one
  instance would interleave at every `await`. Every public method goes through
  one promise chain per instance ([src/serial.ts](src/serial.ts)), which a
  rejection never breaks. The chain is not state: an evicted instance loses it
  with the calls waiting on it, whose callers see a transport error.
- **Bounded repetition.** A segment call that throws one of celld's retryable
  errors (`retryableCause`) is repeated up to five times, with a short pause,
  and only for calls that are safe to repeat: reads, captures, allocations,
  and writes replayed with identical bytes. Past that, the error reaches the
  caller, and over HTTP it is a `503`.
- The stores are synchronous interfaces with two implementations: SQLite in
  the Durable Object (each commit one `transactionSync`, `sync()` awaited
  outside it and only after a commit) and Maps in the Deno tests.

Every code the layers answer with is one of the segment's, plus `CONFLICT`
(409), `CHAIN_MISMATCH` (409), and `CONTENDED` (503, with `Retry-After`: a
bounded loop gave up and nothing it tried took effect). An unknown route is
404, a malformed log, group, or replica name 400.

**Known limit: a read can see a register before it is durable.** A segment's
`read` reports what is committed, which includes a write still at its
durability barrier. Both layers therefore follow every segment window in which
they saw a written register with a zero-timeout `listen` on the same segment,
which answers only after a barrier; only then does WormLog report the records
or a replica apply the commands. That closes the gap as long as the same owner
answers both calls. If the owner crashes between them and the new owner
restored the segment without that write, a WormLog reader could report a
record that is then gone (and the slot later filled), and a replica could apply
a command that another one later overwrites at the same address, diverging.
Closing it for good needs a read that itself waits for a barrier before it
answers (a `durable` flag on `read`, costing one barrier per read), which is a
change to the segment API; it is the first follow-up. The fakes cannot
produce it (they are always durable), and no fleet run so far has.

## How the journal maps onto segments

[The journal](../journal/README.md) is a fenced, totally ordered log, and it is
now built on segments: its cell keeps only the lease, the term, the marks, and
a table of links, while the records live in a chain of segments the journal
owns through whole-link captures. Its README has the design. What it keeps
from its original shape, and why:

- The journal keeps its timed lease in front of the segments rather than
  turning leadership into a capture. Its clients are external writers that
  want `LEASE_HELD`, `NOT_LEADER`, and a deadline they can reason about; a
  capture would give them fencing but no liveness policy. The capture is the
  journal cell's own fence on its links.
- Appends stay server-sequenced. The journal assigns `seq`, so its clients
  never see holes; batches never span a link (the journal seals a link and
  starts the batch in the next one), so every batch is one atomic write.
- Its `SEQ_MISMATCH` proof stays on the surface; underneath, a lost reply is
  settled by write-once: a replay that finds its own bytes has landed, and the
  journal reconciles its head from the segment before deciding again.

What building on segments would look like WITHOUT that veneer is WormPaxos
above: `alloc` first-writer-wins as election, a batch capture as a sticky lease
without a clock, client-chosen offsets, and holes a deposed leader leaves
behind that the next one fills with no-ops. Both shapes run on the same cell.

## Layout

| File                             |                                                             |
| -------------------------------- | ----------------------------------------------------------- |
| [src/types.ts](src/types.ts)     | Requests, result unions, limits                             |
| [src/core.ts](src/core.ts)       | Every decision, as pure transitions over the meta row and a view |
| [src/http.ts](src/http.ts)       | Routes, base64, the status map, and `retryableCause`       |
| [src/chain.ts](src/chain.ts)     | Segment chains: names, addresses, metadata, and `Chain`     |
| [src/segment.ts](src/segment.ts) | The segment Durable Object                                  |
| [src/entry.ts](src/entry.ts)     | The entry codec both layers write into registers            |
| [src/serial.ts](src/serial.ts)   | The per-instance call queue and bounded retry of transient errors |
| [src/sequencer_core.ts](src/sequencer_core.ts) | WormLog's sequencer, over a store interface and the resolver |
| [src/sequencer.ts](src/sequencer.ts) | The `Sequencer` Durable Object: SQLite around the core   |
| [src/wormlog.ts](src/wormlog.ts) | The WormLog client: append, read, fill, trim, listen        |
| [src/replica_core.ts](src/replica_core.ts) | WormPaxos: commands, learning, sticky proposals, takeover |
| [src/replica.ts](src/replica.ts) | The `Replica` Durable Object: SQLite around the core        |
| [src/layers_http.ts](src/layers_http.ts) | Routes, base64, and the status map for both layers  |
| [src/index.ts](src/index.ts)     | Worker entry point and dispatch                             |

Only the three Durable Object files import `cloudflare:workers`; everything
else is pure and runs in the Deno tests.

The [BUILD](BUILD) file splits these into celld libraries (see the
[toolchain README](../../../buck/toolchains/celld/README.md#typescript-units)),
and code in one imports another only through its specifiers:

| Library | Files | Exports |
| --- | --- | --- |
| `:segment` | `types`, `core`, `http`, `serial`, `segment` | `@wormspace/segment` (the `Segment` class), `@wormspace/segment/{core,http,serial,types}` |
| `:layers` | `chain`, `entry`, `sequencer_core`, `wormlog`, `replica_core`, `layers_http` | `@wormspace/layers/<file>` for each |
| `:testing` | `tests/fake_segment.ts`, `tests/random.ts` | `@wormspace/testing/fake_segment`, `@wormspace/testing/random` |

`:worker` bundles `index.ts` with the `Sequencer` and `Replica` classes, which
nothing else imports. The journal depends on `:segment` and `:testing`. Tests
assert with `@celld/assert` (`root//src/celld/assert`).

Decisions here depend on register state, so each transition that needs it takes
an explicit view: the Durable Object asks `captureScope`, `writeScope`, or
`trimScope` what to load, loads it inside the same `transactionSync` in a
bounded number of statements, and hands it to the transition. A test builds the
same view from a model.

## Tests

```console
$ buck2 test tilde//aseipp/wormspace/...
$ buck2 run tilde//aseipp/wormspace:deploy -- --dry-run --json
$ buck2 run tilde//aseipp/wormspace:dev -- --port 8787   # poke at it by hand
```

| Target           | What it covers                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `:core-test`     | every transition case by case: allocation, rounds, steals, unsafe writes, replays, batch atomicity, trims, limits, the `writes` counter, `planListen` |
| `:model-test`    | 100 seeds × 300 steps of four writers stealing and replaying, checked against an independent model after every step |
| `:fake-segment-test` | the fake segment replaying every model sequence step for step, its RPC-like edges and faults, and its `listen` |
| `:chain-test`    | chain names, address arithmetic and its bounds, metadata, first-writer-wins allocation, mismatches, `tail`       |
| `:http-test`     | routes, base64, per-operation decoding, the status map, `retryableCause`                                          |
| `:runtime-test`  | the real service under `celld dev`, including across a supervisor restart, and `listen` parked, released, timed out, and at its 25-second cap; WormLog across a segment boundary, a stolen segment, fills, trims, and `listen`; two replicas converging across steals and a boundary; the sequencer and a replica across a restart |
| `:fleet-test`    | celld in fleet mode on [chaos3](../../../src/chaos3/README.md): healthy, a `storage-v1` chaos campaign with a `listen` tail, and a crash takeover |
| `:deploy-test`   | the packaged project deploys                                                                                     |
| `:entry-test`    | the entry codec: tags, holes, bounds, copies                                                                      |
| `:wormlog-test`  | the sequencer and the WormLog client over the fakes: slots, `init`, concurrency across boundaries, lost tokens and fills, lost and thrown writes, stale captures and operator steals, reads and their barriers, trims, `listen`, restarts |
| `:wormlog-model-test` | 100 seeds of 2-4 concurrent appenders with a filler, an operator stealing segments, and a reader, under injected throws, lost replies, stale refusals, and outages |
| `:replica-test`  | WormPaxos over the fakes: commands, the one-write sticky proposal, steals, convergence, crashed and pipelining leaders' holes, lost replies, unknown outcomes, rollover, serialised concurrent proposals, sizes, restarts |
| `:replica-model-test` | 60 seeds of 2-3 replicas proposing, learning, and restarting concurrently, with a crashed pipelining leader, injected faults, and outages, checked against the registers after every operation |
| `:layers-http-test` | both layers' routes, decoding, base64, and status map                                                        |
| `:wormlog-fleet-test` | three appenders under a `storage-v1` campaign and a SIGKILL of the node, every pending slot filled, audited against the ledgers, then again from the bucket alone |
| `:wormpaxos-fleet-test` | two replicas on two nodes proposing at once under a `storage-v1` campaign, the node serving one of them SIGKILLed halfway, audited against the chain |

The model test keeps storage (a reducer over outcomes, read back through the
same views the Durable Object builds) apart from the semantics (every round
ever granted, and the first value accepted at each offset), and asserts after
every step that they agree: written values never change, every accepted write's
`captureId` was the effective round at each of its offsets, every
`CAPTURE_STALE` names the real effective round, every `sameValue` is right,
rounds are strictly increasing, `writtenCount`, `writes`, and the trim mark are
right, and pruned capture rows never change an effective round.

[tests/fake_segment.ts](tests/fake_segment.ts) is an in-memory `SegmentAPI`
for testing what is built on segments: `FakeSegment` keeps the Durable Object's
three tables and implements every method by building the same views and
running the same `core.*` transitions, applying each outcome in the Durable
Object's order; requests and results are structured clones, as over RPC; and
`listen` parks on a real timer. `FakeSegments` hands out the
`(name) => SegmentAPI` resolver, logs every call, and consults a `faults` hook
before each one, which can answer in the segment's place (say, a
`CAPTURE_STALE`), throw what celld throws for an unreachable owner, or perform
the call and then lose its reply. `:fake-segment-test` runs the model test's
generator and replays every sequence against the fake, requiring identical
results, status, tables, and read-back at every step.

The layer model tests take the registers themselves as the truth. WormLog's
checks that every acknowledged append reads back at its slot byte for byte, no
two acknowledgements share a slot, every record in the log was sent, appears
once, and is either acknowledged there or belongs to an append that threw, a
fill that reports a hole never lands on an acknowledged slot, a slot a reader
has seen as a record or a hole never changes, and after a final round of fills
the log is dense below `next`. WormPaxos's checks, after every replica
operation, that the replica's `applied` prefix is entirely written and its
table is exactly the replay of that prefix (so replicas at equal `applied`
agree), and at the end that no command is in the chain twice, every
acknowledged proposal is at its address, no address was acknowledged twice, a
`CONTENDED` proposal is nowhere, and every replica catches up to the same
table. Both count the interesting outcomes and fail if a run never reached
one.

The fleet test uses the shared harness in this package (`:fleet-harness`,
[tests/celld_fleet.py](tests/celld_fleet.py)) with its own client and a
sticky-leader workload. The chaos scenario runs two
leaders that alternately steal the whole segment from each other, asserts the
loser's next write is `CAPTURE_STALE` every time, and audits the bucket-restored
segment against both ledgers: every acknowledged register holds its bytes under
its round, every round belongs to one leader, and nothing is stored that nobody
sent. At every turn a reader parks a `listen` from the count landed so far and
must be released by that turn's writes, repeating on any transport error; and
the final `writes` must equal the registers landed. The failover scenario kills
the owning node outright and requires the leader's round to keep working on the
survivor, with 503s and never a 500.

## Follow-ups

- `listen` over hibernatable WebSockets, for readers that want a stream rather
  than a long poll.
- A `read` that waits for a durability barrier before answering, so the layers
  need no `listen` after a read and the one known limit above is gone.
- WormPaxos snapshots and trimming, the paper's flexible durability.
- Forwarding proposals to the current leader instead of stealing, and
  pipelined proposals (one batch write for several commands).
- WormTX, the paper's third application.
- A `durable` flag on `read`, so a reader never sees a register before its
  barrier even across an owner change (the journal and both layers currently
  follow reads with a zero-timeout `listen` instead).
