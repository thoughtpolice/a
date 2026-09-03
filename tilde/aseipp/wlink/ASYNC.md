<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# Async

wlink links the component model's async ABI ([Concurrency.md]): `async`
function types, lowered and lifted either way, with the canonical built-ins
over tasks, subtasks, waitable sets, streams and futures. The linked module
carries the runtime that keeps their state and schedules their tasks, so it
still runs on any core engine; a package with nothing async gets none of it
and links as before.

## What links

- **Calls.** An async function lowered synchronously or with `async`, into
  a function lifted synchronously, with a `callback`, or stackful (`async`
  without one), including strings, lists, resources and spilled parameters
  and results on every path, and `task.return`'s results into both kinds of
  caller.
- **Built-ins.** `task.return`, `task.cancel`, `context.get` and
  `context.set` (`i32` storage), `backpressure.inc` and `backpressure.dec`,
  `thread.yield`, `subtask.drop` and `subtask.cancel`, the `waitable-set`
  and `waitable` built-ins, and every `stream` and `future` built-in
  (`new`, `read`, `write`, both cancels and both drops), synchronous or
  `async`.
- **Streams and futures** between components, and between a component
  and the host, of any element type: the copy between two buffers converts
  strings, lists, owned handles and the ends of further streams and futures
  from the writer's memory and table to the reader's, as a call does.
- **Tables.** Each component instance numbers its handles, waitable sets,
  subtasks and ends from 1 in a table of its own, reusing the index freed
  last, as the canonical ABI's `Table` does; resources join the same index
  space in a package that is async.

Not linked: `error-context`, the `forward` built-ins, and the shared thread
built-ins (`thread.spawn-*`, `thread.available-parallelism`).

## How it runs

A static link has no stack switching. A task lifted with a callback runs
stackless: each time it waits or yields it returns to the scheduler, which
calls its callback once what it waits for has happened. Anything that must
block where it stands (a synchronous call of an async function that has not
returned, `waitable-set.wait`, a synchronous copy or cancel, the call of a
function lifted synchronously or stackful that blocks) runs the scheduler
on the native stack until its condition holds, running other tasks and,
when nothing else can run, asking the host to wait for its own work.

The canonical ABI's rules hold as written: backpressure and the exclusive
lock of each instance (which a stackful task does not take), a
synchronously typed call that may not block (it may only run its own
instance's ready tasks), borrows counted per task and lends returned when a
subtask's resolution is delivered, cancellation delivered to a task waiting
in its event loop as soon as its instance's lock is free, and the traps the
built-ins specify.

What differs follows from the waits nesting last in, first out:

- **A callee an async call started does not give control back while it
  blocks.** The canonical ABI returns a blocked callee's caller a subtask
  and lets it go on; here the callee's wait runs first, to its end. A wait
  that only its own caller could satisfy (by writing a future it reads, or
  calling the export that unblocks it) finds nothing to run and traps as a
  deadlock; one that yields while it waits spins.
- **The thread built-ins** (`thread.index`, `thread.new-indirect`, the
  `suspend`, `resume` and `promote` family) link, and trap when called:
  cooperative threads need stack switching.

## The host's side

A package with anything async exports `wlink:async:pump`, and its host
runs the scheduler with it: each call gives every task that is ready one
turn, and returns 1 while some task has something new to handle (an event,
a cancellation, the lock it waited for), so a host pumps in a loop until it
returns 0, or once a frame. A task that only yields gets a turn a pump, and
does not keep that loop going. The runtime traps with a reason
in the exported global `wlink:async:trap` (below).

**Async imports.** An import the component lowers with `async` is imported
with its subtask first, then the async lowered signature: at most four flat
parameters (else a pointer to them in the import's memory) and, when the
function returns something, the address its result goes to:

```
(func $fetch (param $subtask i32) (param $n i32) (param $out i32) (result i32))
```

The host reads the arguments during the call. It returns 2 when it has
written the result already, or 1 when it resolves the subtask later, by
writing the result and calling `wlink:async:resolve(subtask, 2)`; results
holding strings or lists are allocated with the import's
`wlink:import:I#F:realloc`, and resources are representations, as with
synchronous imports. An import lowered synchronously keeps the synchronous
signature, and the host implements it synchronously.

A package whose host runs async imports also imports:

- `wlink:async` / `wait` `(func (result i32))`: a synchronous wait cannot
  go on without the host's work. The host blocks until it has resolved at
  least one of its subtasks and returns nonzero, or returns 0 when it has
  nothing to finish, which traps as a deadlock.
- `wlink:async` / `cancel` `(func (param $subtask i32))`: a component
  cancels a subtask the host runs. The host resolves it (2 if it had
  returned meanwhile, or 4 for cancelled), during the call or later.

**Async exports.** The host calls an export lifted with a callback, or
stackful, with the lifted signature and gets a status back: 2 when the
call returned before the export did, or the task shifted left by 4 with 1
when it started and 0 when backpressure holds it back. The result reaches
the host through its import `wlink:task-return` / `F`, taking the task and
then `task.return`'s parameters: the flat values, or beyond sixteen a
pointer into the component's memory, valid for the call's duration. The
host cancels a task with `wlink:async:cancel(task)` and hears how it ended
through `wlink:task-return` or `wlink:async` / `task-cancelled`
`(func (param $task i32) (param $state i32))`, with 3 for cancelled before
it started (owned handles it passed were not taken) and 4 for cancelled
before it returned. An async export lifted synchronously keeps the
synchronous export ABI, and may block, waiting through `wait`.

**Streams and futures.** The host holds ends as a component does, in a
table of its own, and names them by their indices there; an end crosses
its edge wherever a function's parameters or results hold one, moving
between its table and the component's. The host's buffers are in the
exported memory `wlink:host`, which is its to manage, and it operates its
ends with these exports:

| Export | Signature | |
|---|---|---|
| `wlink:async:stream-new` | `() -> i64` | a new stream: the readable end's index in the low half, the writable end's in the high |
| `wlink:async:future-new` | `() -> i64` | likewise, a future |
| `wlink:async:read` | `(end, ptr, len) -> i32` | reads up to `len` elements into `ptr` |
| `wlink:async:write` | `(end, ptr, len) -> i32` | writes `len` elements from `ptr` |
| `wlink:async:cancel-read` | `(end) -> i32` | cancels the read `end` has pending |
| `wlink:async:cancel-write` | `(end) -> i32` | cancels the write `end` has pending |
| `wlink:async:drop` | `(end)` | drops either end |

A future's copies are of one element. A copy never blocks: it returns its
result as the canonical ABI's built-ins do (the count of elements copied
shifted left by 4, with 0 completed, 1 dropped or 2 cancelled), or -1
(`0xffffffff`) when it has to wait for the other end, and the result
arrives later through the import `wlink:async` / `event`
`(func (param $end i32) (param $code i32) (param $payload i32))`, with the
canonical event code (2 stream read, 3 stream write, 4 future read, 5
future write) and the result as its payload. A cancel returns the result
the cancelled copy ends with, and no event follows. Events arrive only
where the host lets the package run: during `wlink:async:pump`, and during
a call that blocks, before the runtime asks the host to `wait`; the host
may copy, cancel and drop from its handler. A package whose host holds
ends imports `wlink:async` / `wait`, which asks the host to do its part
(to read or write what a component waits for); it returns nonzero once it
has, or 0 when it has nothing to do, which traps as a deadlock.

The elements are in their canonical layout. Strings and lists the host
writes are in `wlink:host`; those it reads are allocated there with its
import `wlink:async` / `realloc`, the canonical `realloc` signature,
which a package imports only when an element holds one. Resources are
representations, as at every other edge of the host: an owned handle the
host reads is its to destroy, and one it writes is created in the
reader's table. A stream or future the host makes takes its type from the
first place its readable end crosses into a component; until then it
cannot be copied.

**Trap reasons** in `wlink:async:trap`:

| Code | Reason |
|---:|---|
| 1 | Deadlock: nothing can run, and the host has nothing to finish |
| 2 | A synchronously typed function would block |
| 3 | A handle index that is not live, or not of the kind a built-in takes |
| 4 | `task.return` or `task.cancel` where they are not allowed |
| 5 | A task returns while borrows it received are outstanding |
| 6 | A task exits without returning or confirming a cancellation |
| 7 | A callback returns an unknown code |
| 8 | A waitable set dropped while it has members or waiters |
| 9 | A subtask dropped, or cancelled, in the wrong state |
| 10 | A stream or future end used in a state that forbids it |
| 11 | A stream or future end of another type |
| 12 | A copy of a non-number element within one instance |
| 13 | Backpressure counted past its range |
| 14 | A waitable used synchronously while in a set, or by two waiters |
| 15 | A table past 2^28 entries, or out of memory |
| 16 | The host breaks the protocol |
| 17 | A stream or future buffer outside its memory, or misaligned |
| 18 | `task.return` of another result type, or through another memory |
| 19 | A thread built-in: cooperative threads need stack switching |

## Tests

- `:conformance-tests` runs the component model's async conformance tests
  (`:component-model-async-tests`): for every instance a script
  makes, a driver component makes the script's calls and checks their
  results and trap reasons, and WABT's interpreter runs the pair linked.
  The runs that need what a static link cannot give are listed there by
  line and reason, and must keep failing for it.
- `tests/async_server.wat` and `tests/async_client.wat` pass strings,
  lists and resources through async calls, a stream of strings between
  components, thread-local storage across callbacks, and calls in flight
  at once (`:run-async-*`).
- `tests/host_async.wat` and `tests/async_host.c` exercise the host's side
  through wasm2c, randomized rounds of it included (`:run-host-async`).
- `tests/host_streams.wat` and `tests/streams_host.c` do the same for
  streams and futures across the host's edge (`:run-host-streams`): numbers,
  strings, futures, owned handles and ends of further streams, each way,
  with callback tasks and with blocking copies the host serves from `wait`,
  cancellation, and drops heard of through events.

[Concurrency.md]: https://github.com/WebAssembly/component-model/blob/main/design/mvp/Concurrency.md
