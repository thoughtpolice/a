;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; The async runtime of a linked program: the component model's tasks,
;; subtasks, waitable sets, and stream and future ends, with the scheduler
;; that runs them, as one core module the linker splices into its output.
;;
;; The host is one more frame, after the package's: it holds stream and
;; future ends in a table of its own and operates them through the `host.*`
;; exports, with its buffers in a memory of its own. The events of its
;; copies queue, and reach it through `host-event` where nothing else is
;; under way: in `pump`, and before it is asked to wait.
;;
;; A static link has no stack switching, so every task runs stackless: a
;; callback-lifted task returns to the scheduler whenever it waits, and the
;; scheduler calls its callback again once what it waits for has happened.
;; A wait that cannot return (a synchronous call of an async function that
;; blocks, `waitable-set.wait`, a synchronous copy or cancel) runs the
;; scheduler on the native stack until its condition holds, asking the host
;; to wait for its own work when nothing else can run. Waits nest last in,
;; first out, so a wait that only something beneath it on the stack could
;; satisfy is a deadlock, and traps.
;;
;; Objects (resource handles, tasks, subtasks, waitable sets, stream and
;; future ends, and the adapters' bookkeeping) are the 64-byte entries of
;; the handle table's memory (`wlink:handles`), named by their index there;
;; word 0 names an entry's kind and word 8 the frame that owns it. What a
;; component sees is the canonical ABI's table of its own instance: each
;; frame numbers the objects it holds from 1, reusing the index freed last,
;; in a table of object indices in this module's `wlink:tables` memory.
;; Tasks and the adapters' records are never in one, as the canonical ABI
;; keeps its threads apart. The per-frame state (backpressure, the
;; exclusive lock, the table) and a scratch area live in `wlink:async`. The
;; linker supplies what differs per link: the callbacks, the thunks that
;; start and resolve each kind of call, the copies between stream buffers,
;; and the host's side of the edge.

(module
  (import "wlink" "handles" (memory $h 1))
  (import "wlink" "handle.add" (func $handle.add (param i32 i32 i32 i32 i32) (result i32)))
  (import "wlink" "handle.free" (func $handle.free (param i32)))
  ;; callback(lift, event, p1, p2) -> code
  (import "wlink" "callback" (func $dispatch.callback (param i32 i32 i32 i32) (result i32)))
  ;; start(task): a call deferred by backpressure starts
  (import "wlink" "start" (func $dispatch.start (param i32)))
  ;; resolve(task): `task.return`'s values, in the scratch area, reach the caller
  (import "wlink" "resolve" (func $dispatch.resolve (param i32)))
  ;; host-resolve(subtask): the host wrote an async import's result
  (import "wlink" "host-resolve" (func $dispatch.host-resolve (param i32)))
  ;; copy(src side, dst side, src ptr, src progress, dst ptr, dst progress, n)
  (import "wlink" "copy" (func $dispatch.copy (param i32 i32 i32 i32 i32 i32 i32)))
  ;; host-wait() -> progress: block for the host's pending work
  (import "wlink" "host-wait" (func $host.wait (result i32)))
  ;; host-cancel(subtask): cancel an async import the host is running
  (import "wlink" "host-cancel" (func $host.cancel (param i32)))
  ;; task-cancelled(task, state): a task the host started was cancelled
  (import "wlink" "task-cancelled" (func $host.task-cancelled (param i32 i32)))
  ;; host-frame() -> frame: the host's
  (import "wlink" "host-frame" (func $host.frame (result i32)))
  ;; host-side(type) -> side: the side the host's buffers of `type` are
  (import "wlink" "host-side" (func $host.side (param i32) (result i32)))
  ;; host-event(end, code, payload): an event of a copy the host made
  (import "wlink" "host-event" (func $host.event (param i32 i32 i32)))

  ;; The state memory: the scratch area for `task.return`'s flat values
  ;; (sixteen eight-byte slots from 0), then from 256 thirty-two bytes per
  ;; frame: its backpressure counter (0), the task holding its exclusive
  ;; lock (4), how many calls wait to enter it (8), and its table: where it
  ;; is (12), its capacity (16), its length (20), and the index freed last
  ;; (24). The linker sizes it.
  (memory $s 1)
  ;; The frames' tables, each an array of object indices (a free slot holds
  ;; the next free index with the top bit set), moved when it grows.
  (memory $t 1)

  ;; The current thread: its task (0 for a synchronous function), its
  ;; thread-local storage, and the frame of the innermost synchronously
  ;; typed call it runs under, which may not block (-1 for none).
  (global $cur_task (export "cur_task") (mut i32) (i32.const 0))
  (global $ctx0 (export "ctx0") (mut i32) (i32.const 0))
  (global $ctx1 (export "ctx1") (mut i32) (i32.const 0))
  (global $sync_frame (export "sync_frame") (mut i32) (i32.const -1))
  ;; The scheduler's list of tasks waiting to enter, yielding, or waiting,
  ;; in the order they started waiting.
  (global $head (mut i32) (i32.const 0))
  (global $tail (mut i32) (i32.const 0))
  ;; Bumped by every `pump`; a task that yields or waits again during one
  ;; runs in the next.
  (global $epoch (mut i32) (i32.const 0))
  ;; Async imports the host has started and not resolved.
  (global $host_pending (mut i32) (i32.const 0))
  ;; The payload of the event `take_event` delivered last.
  (global $p1 (mut i32) (i32.const 0))
  (global $p2 (mut i32) (i32.const 0))
  ;; The end of the tables' memory in use.
  (global $heap (mut i32) (i32.const 8))
  ;; The host's ends with events to deliver, linked through their word 20
  ;; as a set's pending waitables are, and how many ends the host holds.
  (global $host_head (mut i32) (i32.const 0))
  (global $host_tail (mut i32) (i32.const 0))
  (global $host_held (mut i32) (i32.const 0))
  ;; Why the runtime trapped last, for a host to report: see `$fail`.
  (global $trap (export "trap") (mut i32) (i32.const 0))

  ;; Object kinds, the first word of an entry. Resources are positive; the
  ;; adapters' scopes and lender records are -1 and -2.
  ;;   -3 waitable set   -4 subtask   -5 synchronous call   -6 task
  ;;   -7 saved arguments   -8 lend
  ;;   -9 stream readable  -10 stream writable
  ;;   -11 future readable -12 future writable
  ;; An object in a frame's table keeps its index there at 60.
  ;;
  ;; A waitable (subtask or end) keeps:
  ;;   4 state   12 pending event   16 waitable set   20 next pending in
  ;;   the set   24 a synchronous waiter
  ;; A subtask or synchronous call adds:
  ;;   28 task   32 lends   36 flags   40 result area   44 site   48 result
  ;; with flags 1 resolve delivered, 2 cancel requested, 4 the host runs
  ;; it, 8 exposed to its caller. Subtask states: 0 starting, 1 started,
  ;; 2 returned, 3 cancelled before starting, 4 cancelled before returning.
  ;; An end adds:
  ;;   28 other end   32 type   36 buffer   40 length   44 progress
  ;;   48 buffer side (0 for no buffer)   52 progress to report
  ;; with states 1 idle, 2 copying, 3 cancelling, 4 done.
  ;; A waitable set keeps:
  ;;   4 members   12 waiters   16 first pending   20 last pending
  ;; A task keeps:
  ;;   4 borrows (where a scope keeps them)   12 state   16 site
  ;;   20 subtask   24 context 0   28 context 1   32 callback code
  ;;   36 next in the scheduler's list   40 epoch   44 flags   48 lift
  ;;   52 result type   56 result memory   60 saved arguments
  ;; with flags 1 async (returns through `task.return`), 2 on the
  ;; scheduler's list, 4 the host called it, 8 kept by its caller, 16
  ;; exited while kept, 32 stackful (takes no lock); and states 1 initial,
  ;; 2 started, 3 cancel pending, 4 cancel delivered, 5 resolved. Callback
  ;; codes are 0 exit, 1 yield, 2 wait (on the set object in the high
  ;; bits), and here 3 wait to enter.
  ;; Saved arguments keep the next record at 4 and four values from 16.
  ;; A lend keeps the lent handle's address at 4 and the next lend at 20.
  ;; Everything an object refers to is an object index.

  ;; Traps, with a code in `trap`:
  ;;   1 deadlock   2 a synchronous function blocked   3 bad handle
  ;;   4 misplaced task.return or task.cancel   5 borrows outstanding
  ;;   6 a task exited unresolved   7 bad callback code
  ;;   8 waitable set in use   9 subtask not resolved   10 end state
  ;;   11 end type   12 non-number copy within one instance
  ;;   13 backpressure out of range   14 waitable in use by a waiter
  ;;   15 a table is full   16 host misuse   17 a buffer outside memory
  ;;   18 task.return type or memory   19 needs stack switching
  (func $fail (export "fail") (param $code i32)
    (global.set $trap (local.get $code))
    unreachable)

  (func $a (export "addr") (param $x i32) (result i32)
    (i32.add (i32.const 32) (i32.shl (local.get $x) (i32.const 6))))

  (func $frame (param $f i32) (result i32)
    (i32.add (i32.const 256) (i32.shl (local.get $f) (i32.const 5))))

  ;; A new object of `kind` owned by `owner`, every other field zero.
  (func $alloc (export "alloc") (param $kind i32) (param $owner i32) (result i32)
    (local $x i32)
    (local.set $x (call $handle.add (local.get $kind) (i32.const 0) (local.get $owner)
      (i32.const 0) (i32.const 0)))
    (memory.fill $h (i32.add (call $a (local.get $x)) (i32.const 12)) (i32.const 0)
      (i32.const 52))
    (local.get $x))

  ;; Frames' tables.

  ;; Puts object `x` in frame `f`'s table: its index there.
  (func $publish (export "handle.publish") (param $f i32) (param $x i32) (result i32)
    (local $fp i32) (local $l i32) (local $slot i32) (local $cap i32) (local $new i32)
    (local $end i32)
    (local.set $fp (call $frame (local.get $f)))
    (local.set $l (i32.load $s offset=24 (local.get $fp)))
    (if (local.get $l)
      (then
        (local.set $slot (i32.add (i32.load $s offset=12 (local.get $fp))
          (i32.shl (local.get $l) (i32.const 2))))
        (i32.store $s offset=24 (local.get $fp)
          (i32.and (i32.load $t (local.get $slot)) (i32.const 0x7fffffff))))
      (else
        ;; Index 0 is never handed out.
        (local.set $l (i32.load $s offset=20 (local.get $fp)))
        (if (i32.eqz (local.get $l)) (then (local.set $l (i32.const 1))))
        (if (i32.gt_u (local.get $l) (i32.const 0x0fffffff)) (then (call $fail (i32.const 15))))
        (local.set $cap (i32.load $s offset=16 (local.get $fp)))
        (if (i32.ge_u (local.get $l) (local.get $cap))
          (then
            (local.set $cap (select (i32.shl (local.get $cap) (i32.const 1)) (i32.const 16)
              (local.get $cap)))
            (local.set $new (global.get $heap))
            (local.set $end (i32.add (local.get $new) (i32.shl (local.get $cap) (i32.const 2))))
            (if (i32.gt_u (local.get $end) (i32.shl (memory.size $t) (i32.const 16)))
              (then
                (if (i32.eq (memory.grow $t (i32.shr_u
                        (i32.add (i32.sub (local.get $end) (i32.shl (memory.size $t) (i32.const 16)))
                          (i32.const 0xffff))
                        (i32.const 16)))
                      (i32.const -1))
                  (then (call $fail (i32.const 15))))))
            (memory.copy $t $t (local.get $new) (i32.load $s offset=12 (local.get $fp))
              (i32.shl (i32.load $s offset=20 (local.get $fp)) (i32.const 2)))
            (global.set $heap (local.get $end))
            (i32.store $s offset=12 (local.get $fp) (local.get $new))
            (i32.store $s offset=16 (local.get $fp) (local.get $cap))))
        (i32.store $s offset=20 (local.get $fp) (i32.add (local.get $l) (i32.const 1)))
        (local.set $slot (i32.add (i32.load $s offset=12 (local.get $fp))
          (i32.shl (local.get $l) (i32.const 2))))))
    (i32.store $t (local.get $slot) (local.get $x))
    (i32.store $h offset=60 (call $a (local.get $x)) (local.get $l))
    (local.get $l))

  ;; The object at index `l` of frame `f`'s table, trapping unless it holds
  ;; one.
  (func $lookup (export "handle.lookup") (param $f i32) (param $l i32) (result i32)
    (local $fp i32) (local $x i32)
    (local.set $fp (call $frame (local.get $f)))
    (if (i32.or (i32.eqz (local.get $l))
          (i32.ge_u (local.get $l) (i32.load $s offset=20 (local.get $fp))))
      (then (call $fail (i32.const 3))))
    (local.set $x (i32.load $t (i32.add (i32.load $s offset=12 (local.get $fp))
      (i32.shl (local.get $l) (i32.const 2)))))
    (if (i32.lt_s (local.get $x) (i32.const 0)) (then (call $fail (i32.const 3))))
    (local.get $x))

  ;; Takes the object at index `l` out of frame `f`'s table.
  (func $unpublish (export "handle.unpublish") (param $f i32) (param $l i32) (result i32)
    (local $fp i32) (local $x i32)
    (local.set $x (call $lookup (local.get $f) (local.get $l)))
    (local.set $fp (call $frame (local.get $f)))
    (i32.store $t (i32.add (i32.load $s offset=12 (local.get $fp)) (i32.shl (local.get $l) (i32.const 2)))
      (i32.or (i32.load $s offset=24 (local.get $fp)) (i32.const 0x80000000)))
    (i32.store $s offset=24 (local.get $fp) (local.get $l))
    (local.get $x))

  ;; The object of `kind` at index `l` of frame `f`'s table.
  (func $get (param $kind i32) (param $f i32) (param $l i32) (result i32)
    (local $x i32)
    (local.set $x (call $lookup (local.get $f) (local.get $l)))
    (if (i32.ne (i32.load $h (call $a (local.get $x))) (local.get $kind))
      (then (call $fail (i32.const 3))))
    (local.get $x))

  (func $end_kind (param $read i32) (param $future i32) (result i32)
    (i32.sub (i32.sub (i32.const -9) (i32.eqz (local.get $read)))
      (i32.shl (local.get $future) (i32.const 1))))

  ;; A waitable at index `l` of frame `f`'s table: a subtask or an end.
  (func $get_waitable (param $f i32) (param $l i32) (result i32)
    (local $x i32) (local $kind i32)
    (local.set $x (call $lookup (local.get $f) (local.get $l)))
    (local.set $kind (i32.load $h (call $a (local.get $x))))
    (if (i32.and (i32.ne (local.get $kind) (i32.const -4))
          (i32.or (i32.gt_s (local.get $kind) (i32.const -9))
            (i32.lt_s (local.get $kind) (i32.const -12))))
      (then (call $fail (i32.const 3))))
    (local.get $x))

  ;; Per-frame state.

  (func $has_backpressure (param $f i32) (result i32)
    (local $p i32)
    (local.set $p (call $frame (local.get $f)))
    (i32.or (i32.ne (i32.load $s (local.get $p)) (i32.const 0))
      (i32.ne (i32.load $s offset=4 (local.get $p)) (i32.const 0))))

  (func (export "backpressure.inc") (param $f i32)
    (local $p i32) (local $n i32)
    (local.set $p (call $frame (local.get $f)))
    (local.set $n (i32.add (i32.load $s (local.get $p)) (i32.const 1)))
    (if (i32.ge_u (local.get $n) (i32.const 65536)) (then (call $fail (i32.const 13))))
    (i32.store $s (local.get $p) (local.get $n)))

  (func (export "backpressure.dec") (param $f i32)
    (local $p i32)
    (local.set $p (call $frame (local.get $f)))
    (if (i32.eqz (i32.load $s (local.get $p))) (then (call $fail (i32.const 13))))
    (i32.store $s (local.get $p) (i32.sub (i32.load $s (local.get $p)) (i32.const 1))))

  ;; The scheduler's list.

  (func $list.push (param $t i32)
    (local $p i32)
    (local.set $p (call $a (local.get $t)))
    (i32.store $h offset=36 (local.get $p) (i32.const 0))
    (i32.store $h offset=44 (local.get $p)
      (i32.or (i32.load $h offset=44 (local.get $p)) (i32.const 2)))
    (if (global.get $tail)
      (then (i32.store $h offset=36 (call $a (global.get $tail)) (local.get $t)))
      (else (global.set $head (local.get $t))))
    (global.set $tail (local.get $t)))

  ;; Unlinks `t`, which follows `prev` (0 for the head).
  (func $list.unlink (param $prev i32) (param $t i32)
    (local $p i32) (local $next i32)
    (local.set $p (call $a (local.get $t)))
    (local.set $next (i32.load $h offset=36 (local.get $p)))
    (if (local.get $prev)
      (then (i32.store $h offset=36 (call $a (local.get $prev)) (local.get $next)))
      (else (global.set $head (local.get $next))))
    (if (i32.eq (global.get $tail) (local.get $t))
      (then (global.set $tail (local.get $prev))))
    (i32.store $h offset=36 (local.get $p) (i32.const 0))
    (i32.store $h offset=44 (local.get $p)
      (i32.and (i32.load $h offset=44 (local.get $p)) (i32.const -3))))

  (func $list.remove (param $t i32)
    (local $prev i32) (local $cur i32)
    (local.set $cur (global.get $head))
    (block $done
      (loop $next
        (br_if $done (i32.eqz (local.get $cur)))
        (if (i32.eq (local.get $cur) (local.get $t))
          (then
            (call $list.unlink (local.get $prev) (local.get $t))
            (br $done)))
        (local.set $prev (local.get $cur))
        (local.set $cur (i32.load $h offset=36 (call $a (local.get $cur))))
        (br $next))))

  ;; Waitable sets and events.

  (func $enqueue (param $s i32) (param $w i32)
    (local $sp i32)
    (local.set $sp (call $a (local.get $s)))
    (i32.store $h offset=20 (call $a (local.get $w)) (i32.const 0))
    (if (i32.load $h offset=20 (local.get $sp))
      (then (i32.store $h offset=20 (call $a (i32.load $h offset=20 (local.get $sp)))
        (local.get $w)))
      (else (i32.store $h offset=16 (local.get $sp) (local.get $w))))
    (i32.store $h offset=20 (local.get $sp) (local.get $w)))

  ;; Removes `w` from the pending queue of set `s`, where it must be.
  (func $dequeue (param $s i32) (param $w i32)
    (local $sp i32) (local $prev i32) (local $cur i32) (local $next i32)
    (local.set $sp (call $a (local.get $s)))
    (local.set $cur (i32.load $h offset=16 (local.get $sp)))
    (block $done
      (loop $scan
        (br_if $done (i32.eqz (local.get $cur)))
        (local.set $next (i32.load $h offset=20 (call $a (local.get $cur))))
        (if (i32.eq (local.get $cur) (local.get $w))
          (then
            (if (local.get $prev)
              (then (i32.store $h offset=20 (call $a (local.get $prev)) (local.get $next)))
              (else (i32.store $h offset=16 (local.get $sp) (local.get $next))))
            (if (i32.eq (i32.load $h offset=20 (local.get $sp)) (local.get $w))
              (then (i32.store $h offset=20 (local.get $sp) (local.get $prev))))
            (br $done)))
        (local.set $prev (local.get $cur))
        (local.set $cur (local.get $next))
        (br $scan))))

  (func $set_pending (param $w i32)
    (local $p i32)
    (local.set $p (call $a (local.get $w)))
    (if (i32.eqz (i32.load $h offset=12 (local.get $p)))
      (then
        (i32.store $h offset=12 (local.get $p) (i32.const 1))
        (if (i32.load $h offset=16 (local.get $p))
          (then (call $enqueue (i32.load $h offset=16 (local.get $p)) (local.get $w))))
        ;; The end of a copy the host made. An idle end keeps its event
        ;; for its next copy, as a component's does.
        (if (i32.and (i32.eq (i32.load $h offset=8 (local.get $p)) (call $host.frame))
              (i32.ge_u (i32.load $h offset=4 (local.get $p)) (i32.const 2)))
          (then (call $host_enqueue (local.get $w)))))))

  (func $host_enqueue (param $w i32)
    (i32.store $h offset=20 (call $a (local.get $w)) (i32.const 0))
    (if (global.get $host_tail)
      (then (i32.store $h offset=20 (call $a (global.get $host_tail)) (local.get $w)))
      (else (global.set $host_head (local.get $w))))
    (global.set $host_tail (local.get $w)))

  ;; Takes `w` off the host's queue, if it is there.
  (func $host_dequeue (param $w i32)
    (local $prev i32) (local $cur i32) (local $next i32)
    (local.set $cur (global.get $host_head))
    (block $done
      (loop $scan
        (br_if $done (i32.eqz (local.get $cur)))
        (local.set $next (i32.load $h offset=20 (call $a (local.get $cur))))
        (if (i32.eq (local.get $cur) (local.get $w))
          (then
            (if (local.get $prev)
              (then (i32.store $h offset=20 (call $a (local.get $prev)) (local.get $next)))
              (else (global.set $host_head (local.get $next))))
            (if (i32.eq (global.get $host_tail) (local.get $w))
              (then (global.set $host_tail (local.get $prev))))
            (br $done)))
        (local.set $prev (local.get $cur))
        (local.set $cur (local.get $next))
        (br $scan))))

  ;; Delivers the host's queued events: whether there were any. The host
  ;; may operate its ends as it hears of them.
  (func $host_flush (result i32)
    (local $w i32) (local $code i32) (local $any i32)
    (block $done
      (loop $next
        (local.set $w (global.get $host_head))
        (br_if $done (i32.eqz (local.get $w)))
        (local.set $code (call $take_event (local.get $w)))
        (call $host.event (global.get $p1) (local.get $code) (global.get $p2))
        (local.set $any (i32.const 1))
        (br $next)))
    (local.get $any))

  ;; Moves waitable `w` to set `s` (0 for none), carrying a pending event.
  (func $join (param $w i32) (param $s i32)
    (local $p i32) (local $old i32)
    (local.set $p (call $a (local.get $w)))
    (local.set $old (i32.load $h offset=16 (local.get $p)))
    (if (local.get $old)
      (then
        (i32.store $h offset=4 (call $a (local.get $old))
          (i32.sub (i32.load $h offset=4 (call $a (local.get $old))) (i32.const 1)))
        (if (i32.load $h offset=12 (local.get $p))
          (then (call $dequeue (local.get $old) (local.get $w))))))
    (i32.store $h offset=16 (local.get $p) (local.get $s))
    (if (local.get $s)
      (then
        (i32.store $h offset=4 (call $a (local.get $s))
          (i32.add (i32.load $h offset=4 (call $a (local.get $s))) (i32.const 1)))
        (if (i32.load $h offset=12 (local.get $p))
          (then (call $enqueue (local.get $s) (local.get $w)))))))

  ;; Returns the lends of a resolved subtask to its caller.
  (func $deliver_resolve (param $sp i32)
    (local $lend i32) (local $lp i32) (local $hp i32)
    (local.set $lend (i32.load $h offset=32 (local.get $sp)))
    (block $done
      (loop $next
        (br_if $done (i32.eqz (local.get $lend)))
        (local.set $lp (call $a (local.get $lend)))
        (local.set $hp (i32.load $h offset=4 (local.get $lp)))
        (i32.store $h offset=16 (local.get $hp)
          (i32.sub (i32.load $h offset=16 (local.get $hp)) (i32.const 1)))
        (call $handle.free (local.get $lend))
        (local.set $lend (i32.load $h offset=20 (local.get $lp)))
        (br $next)))
    (i32.store $h offset=32 (local.get $sp) (i32.const 0))
    (i32.store $h offset=36 (local.get $sp)
      (i32.or (i32.load $h offset=36 (local.get $sp)) (i32.const 1))))

  ;; Delivers the pending event of `w`, taking it off its set's queue:
  ;; returns the event code and leaves the payload in `p1` and `p2`.
  (func $take_event (param $w i32) (result i32)
    (local $p i32) (local $kind i32) (local $result i32) (local $read i32)
    (local.set $p (call $a (local.get $w)))
    (if (i32.load $h offset=16 (local.get $p))
      (then (call $dequeue (i32.load $h offset=16 (local.get $p)) (local.get $w))))
    (if (i32.eq (i32.load $h offset=8 (local.get $p)) (call $host.frame))
      (then (call $host_dequeue (local.get $w))))
    (i32.store $h offset=12 (local.get $p) (i32.const 0))
    (global.set $p1 (i32.load $h offset=60 (local.get $p)))
    (local.set $kind (i32.load $h (local.get $p)))
    (if (i32.eq (local.get $kind) (i32.const -4))
      (then
        (global.set $p2 (i32.load $h offset=4 (local.get $p)))
        (if (i32.ge_u (global.get $p2) (i32.const 2))
          (then (call $deliver_resolve (local.get $p))))
        (return (i32.const 1))))
    (local.set $read (i32.or (i32.eq (local.get $kind) (i32.const -9))
      (i32.eq (local.get $kind) (i32.const -11))))
    (i32.store $h offset=48 (local.get $p) (i32.const 0))
    (if (i32.ge_s (local.get $kind) (i32.const -10))
      (then
        ;; A stream: dropped over cancelled over completed.
        (if (i32.eqz (i32.load $h offset=28 (local.get $p)))
          (then
            (local.set $result (i32.const 1))
            (i32.store $h offset=4 (local.get $p) (i32.const 4)))
          (else
            (local.set $result
              (select (i32.const 2) (i32.const 0)
                (i32.eq (i32.load $h offset=4 (local.get $p)) (i32.const 3))))
            (i32.store $h offset=4 (local.get $p) (i32.const 1))))
        (global.set $p2 (i32.or (local.get $result)
          (i32.shl (i32.load $h offset=52 (local.get $p)) (i32.const 4))))
        (return (select (i32.const 2) (i32.const 3) (local.get $read)))))
    ;; A future: completed over dropped over cancelled, and done after
    ;; either of the first two.
    (if (i32.eq (i32.load $h offset=52 (local.get $p)) (i32.const 1))
      (then
        (local.set $result (i32.const 0))
        (i32.store $h offset=4 (local.get $p) (i32.const 4)))
      (else
        (if (i32.eqz (i32.load $h offset=28 (local.get $p)))
          (then
            (local.set $result (i32.const 1))
            (i32.store $h offset=4 (local.get $p) (i32.const 4)))
          (else
            (local.set $result (i32.const 2))
            (i32.store $h offset=4 (local.get $p) (i32.const 1))))))
    (global.set $p2 (local.get $result))
    (select (i32.const 4) (i32.const 5) (local.get $read)))

  (func (export "waitable-set.new") (param $f i32) (result i32)
    (call $publish (local.get $f) (call $alloc (i32.const -3) (local.get $f))))

  (func (export "waitable-set.drop") (param $f i32) (param $sl i32)
    (local $s i32) (local $sp i32)
    (local.set $s (call $get (i32.const -3) (local.get $f) (local.get $sl)))
    (local.set $sp (call $a (local.get $s)))
    (if (i32.or (i32.load $h offset=4 (local.get $sp)) (i32.load $h offset=12 (local.get $sp)))
      (then (call $fail (i32.const 8))))
    (drop (call $unpublish (local.get $f) (local.get $sl)))
    (call $handle.free (local.get $s)))

  (func (export "waitable.join") (param $f i32) (param $wl i32) (param $sl i32)
    (local $w i32) (local $s i32)
    (local.set $w (call $get_waitable (local.get $f) (local.get $wl)))
    (if (i32.load $h offset=24 (call $a (local.get $w))) (then (call $fail (i32.const 14))))
    (if (local.get $sl)
      (then (local.set $s (call $get (i32.const -3) (local.get $f) (local.get $sl)))))
    (call $join (local.get $w) (local.get $s)))

  ;; Returns the event code, the payload in `event.p1` and `event.p2`.
  (func (export "waitable-set.wait") (param $f i32) (param $sl i32) (result i32)
    (local $s i32) (local $sp i32)
    (local.set $s (call $get (i32.const -3) (local.get $f) (local.get $sl)))
    (local.set $sp (call $a (local.get $s)))
    (i32.store $h offset=12 (local.get $sp)
      (i32.add (i32.load $h offset=12 (local.get $sp)) (i32.const 1)))
    (call $run_until (i32.const 3) (local.get $s))
    (i32.store $h offset=12 (local.get $sp)
      (i32.sub (i32.load $h offset=12 (local.get $sp)) (i32.const 1)))
    (call $take_event (i32.load $h offset=16 (local.get $sp))))

  (func (export "waitable-set.poll") (param $f i32) (param $sl i32) (result i32)
    (local $sp i32)
    (local.set $sp (call $a (call $get (i32.const -3) (local.get $f) (local.get $sl))))
    (if (i32.eqz (i32.load $h offset=16 (local.get $sp)))
      (then
        (global.set $p1 (i32.const 0))
        (global.set $p2 (i32.const 0))
        (return (i32.const 0))))
    (call $take_event (i32.load $h offset=16 (local.get $sp))))

  (func (export "event.p1") (result i32) (global.get $p1))
  (func (export "event.p2") (result i32) (global.get $p2))

  ;; Context.

  (func (export "context.get") (param $slot i32) (result i32)
    (if (result i32) (local.get $slot)
      (then (global.get $ctx1))
      (else (global.get $ctx0))))

  (func (export "context.set") (param $slot i32) (param $value i32)
    (if (local.get $slot)
      (then (global.set $ctx1 (local.get $value)))
      (else (global.set $ctx0 (local.get $value)))))

  ;; Tasks.

  (func (export "task.new")
    (param $f i32) (param $lift i32) (param $site i32) (param $super i32)
    (param $flags i32) (param $rtype i32) (param $rmem i32) (result i32)
    (local $t i32) (local $p i32)
    (local.set $t (call $alloc (i32.const -6) (local.get $f)))
    (local.set $p (call $a (local.get $t)))
    (i32.store $h offset=12 (local.get $p) (i32.const 1))
    (i32.store $h offset=16 (local.get $p) (local.get $site))
    (i32.store $h offset=20 (local.get $p) (local.get $super))
    (i32.store $h offset=44 (local.get $p) (local.get $flags))
    (i32.store $h offset=48 (local.get $p) (local.get $lift))
    (i32.store $h offset=52 (local.get $p) (local.get $rtype))
    (i32.store $h offset=56 (local.get $p) (local.get $rmem))
    (if (local.get $super)
      (then (i32.store $h offset=28 (call $a (local.get $super)) (local.get $t))))
    (local.get $t))

  ;; A subtask (kind -4) or synchronous call (-5) of frame `f`.
  (func (export "call.new")
    (param $kind i32) (param $f i32) (param $site i32) (param $out i32) (param $flags i32)
    (result i32)
    (local $s i32) (local $p i32)
    (local.set $s (call $alloc (local.get $kind) (local.get $f)))
    (local.set $p (call $a (local.get $s)))
    (i32.store $h offset=36 (local.get $p) (local.get $flags))
    (i32.store $h offset=40 (local.get $p) (local.get $out))
    (i32.store $h offset=44 (local.get $p) (local.get $site))
    (local.get $s))

  (func (export "task.super") (param $t i32) (result i32)
    (i32.load $h offset=20 (call $a (local.get $t))))

  ;; Records that the handle at `address`, lent for the call `s` makes,
  ;; returns when it resolves.
  (func (export "lend") (param $s i32) (param $address i32)
    (local $lend i32) (local $sp i32)
    (local.set $sp (call $a (local.get $s)))
    (local.set $lend (call $alloc (i32.const -8) (i32.const 0)))
    (i32.store $h offset=4 (call $a (local.get $lend)) (local.get $address))
    (i32.store $h offset=20 (call $a (local.get $lend)) (i32.load $h offset=32 (local.get $sp)))
    (i32.store $h offset=32 (local.get $sp) (local.get $lend)))

  ;; Whether task `t`'s frame holds new calls back: by backpressure, or by
  ;; the lock a task that is not stackful must take.
  (func $held_back (param $t i32) (result i32)
    (local $tp i32) (local $fp i32)
    (local.set $tp (call $a (local.get $t)))
    (local.set $fp (call $frame (i32.load $h offset=8 (local.get $tp))))
    (i32.or (i32.ne (i32.load $s (local.get $fp)) (i32.const 0))
      (i32.and (i32.eqz (i32.and (i32.load $h offset=44 (local.get $tp)) (i32.const 32)))
        (i32.ne (i32.load $s offset=4 (local.get $fp)) (i32.const 0)))))

  ;; Whether task `t` may start now: nothing holds its frame back, and no
  ;; call already waits to enter it.
  (func (export "task.try-enter") (param $t i32) (result i32)
    (i32.and (i32.eqz (call $held_back (local.get $t)))
      (i32.eqz (i32.load $s offset=8
        (call $frame (i32.load $h offset=8 (call $a (local.get $t))))))))

  ;; Queues an async call that cannot start yet.
  (func (export "task.defer") (param $t i32)
    (local $fp i32)
    (local.set $fp (call $frame (i32.load $h offset=8 (call $a (local.get $t)))))
    (i32.store $s offset=8 (local.get $fp) (i32.add (i32.load $s offset=8 (local.get $fp)) (i32.const 1)))
    (i32.store $h offset=32 (call $a (local.get $t)) (i32.const 3))
    (call $list.push (local.get $t)))

  ;; A synchronous caller waits for its call to be allowed to start.
  (func (export "task.wait-enter") (param $t i32)
    (local $fp i32)
    (local.set $fp (call $frame (i32.load $h offset=8 (call $a (local.get $t)))))
    (i32.store $s offset=8 (local.get $fp) (i32.add (i32.load $s offset=8 (local.get $fp)) (i32.const 1)))
    (call $run_until (i32.const 1) (local.get $t))
    (i32.store $s offset=8 (local.get $fp) (i32.sub (i32.load $s offset=8 (local.get $fp)) (i32.const 1))))

  ;; Room for four more saved arguments of task `t`.
  (func (export "args.push") (param $t i32) (result i32)
    (local $r i32) (local $cur i32) (local $slot i32)
    (local.set $r (call $alloc (i32.const -7) (i32.const 0)))
    (local.set $slot (i32.add (call $a (local.get $t)) (i32.const 60)))
    (block $done
      (loop $next
        (local.set $cur (i32.load $h (local.get $slot)))
        (br_if $done (i32.eqz (local.get $cur)))
        (local.set $slot (i32.add (call $a (local.get $cur)) (i32.const 4)))
        (br $next)))
    (i32.store $h (local.get $slot) (local.get $r))
    (i32.add (call $a (local.get $r)) (i32.const 16)))

  ;; The values of the n-th record of saved arguments.
  (func (export "args.at") (param $t i32) (param $n i32) (result i32)
    (local $cur i32)
    (local.set $cur (i32.load $h offset=60 (call $a (local.get $t))))
    (block $done
      (loop $next
        (br_if $done (i32.eqz (local.get $n)))
        (local.set $cur (i32.load $h offset=4 (call $a (local.get $cur))))
        (local.set $n (i32.sub (local.get $n) (i32.const 1)))
        (br $next)))
    (i32.add (call $a (local.get $cur)) (i32.const 16)))

  (func $free_args (param $tp i32)
    (local $cur i32) (local $next i32)
    (local.set $cur (i32.load $h offset=60 (local.get $tp)))
    (block $done
      (loop $next
        (br_if $done (i32.eqz (local.get $cur)))
        (local.set $next (i32.load $h offset=4 (call $a (local.get $cur))))
        (call $handle.free (local.get $cur))
        (local.set $cur (local.get $next))
        (br $next)))
    (i32.store $h offset=60 (local.get $tp) (i32.const 0)))

  ;; The call's arguments are about to be lowered into the callee.
  (func (export "task.start") (param $t i32)
    (local $tp i32) (local $s i32)
    (local.set $tp (call $a (local.get $t)))
    (i32.store $h offset=12 (local.get $tp) (i32.const 2))
    (local.set $s (i32.load $h offset=20 (local.get $tp)))
    (if (local.get $s)
      (then
        (i32.store $h offset=4 (call $a (local.get $s)) (i32.const 1))
        (call $notify_call (local.get $s)))))

  ;; A subtask's state changed: an exposed one has a pending event.
  (func $notify_call (param $s i32)
    (if (i32.and (i32.load $h offset=36 (call $a (local.get $s))) (i32.const 8))
      (then (call $set_pending (local.get $s)))))

  ;; Enters the core code of task `t`, which holds its frame's lock while
  ;; it runs unless it is stackful. The caller keeps the thread it
  ;; interrupts.
  (func $enter (export "task.enter") (param $t i32)
    (local $tp i32)
    (local.set $tp (call $a (local.get $t)))
    (if (i32.eqz (i32.and (i32.load $h offset=44 (local.get $tp)) (i32.const 32)))
      (then (i32.store $s offset=4 (call $frame (i32.load $h offset=8 (local.get $tp)))
        (local.get $t))))
    (global.set $cur_task (local.get $t))
    (global.set $ctx0 (i32.load $h offset=24 (local.get $tp)))
    (global.set $ctx1 (i32.load $h offset=28 (local.get $tp))))

  (func $leave (export "task.leave") (param $t i32)
    (local $tp i32) (local $fp i32)
    (local.set $tp (call $a (local.get $t)))
    (local.set $fp (call $frame (i32.load $h offset=8 (local.get $tp))))
    (i32.store $h offset=24 (local.get $tp) (global.get $ctx0))
    (i32.store $h offset=28 (local.get $tp) (global.get $ctx1))
    (if (i32.eq (i32.load $s offset=4 (local.get $fp)) (local.get $t))
      (then (i32.store $s offset=4 (local.get $fp) (i32.const 0)))))

  (func $run_callback (param $t i32) (param $event i32) (param $p1 i32) (param $p2 i32)
    (result i32)
    (local $task i32) (local $c0 i32) (local $c1 i32) (local $code i32)
    (local.set $task (global.get $cur_task))
    (local.set $c0 (global.get $ctx0))
    (local.set $c1 (global.get $ctx1))
    (call $enter (local.get $t))
    (local.set $code (call $dispatch.callback
      (i32.load $h offset=48 (call $a (local.get $t)))
      (local.get $event) (local.get $p1) (local.get $p2)))
    (call $leave (local.get $t))
    (global.set $cur_task (local.get $task))
    (global.set $ctx0 (local.get $c0))
    (global.set $ctx1 (local.get $c1))
    (local.get $code))

  ;; What a callback task asked for, on returning from its entry or a
  ;; callback: exit, or wait on the scheduler's list.
  (func $after (export "task.after") (param $t i32) (param $code i32)
    (local $tp i32) (local $s i32)
    (local.set $tp (call $a (local.get $t)))
    (loop $again
      (if (i32.eqz (i32.and (local.get $code) (i32.const 15)))
        (then
          (call $exit (local.get $t))
          (return)))
      (if (i32.gt_u (i32.and (local.get $code) (i32.const 15)) (i32.const 2))
        (then (call $fail (i32.const 7))))
      ;; A cancellation requested meanwhile is delivered before waiting.
      (if (i32.eq (i32.load $h offset=12 (local.get $tp)) (i32.const 3))
        (then
          (i32.store $h offset=12 (local.get $tp) (i32.const 4))
          (local.set $code (call $run_callback (local.get $t) (i32.const 6) (i32.const 0)
            (i32.const 0)))
          (br $again)))
      (if (i32.eq (i32.and (local.get $code) (i32.const 15)) (i32.const 2))
        (then
          ;; The set by its object from here on.
          (local.set $s (call $get (i32.const -3) (i32.load $h offset=8 (local.get $tp))
            (i32.shr_u (local.get $code) (i32.const 4))))
          (i32.store $h offset=12 (call $a (local.get $s))
            (i32.add (i32.load $h offset=12 (call $a (local.get $s))) (i32.const 1)))
          (local.set $code (i32.or (i32.const 2) (i32.shl (local.get $s) (i32.const 4)))))))
    (i32.store $h offset=32 (local.get $tp) (local.get $code))
    (i32.store $h offset=40 (local.get $tp) (global.get $epoch))
    (call $list.push (local.get $t)))

  ;; The task's caller learns how the call ended.
  (func $resolve_super (param $t i32) (param $state i32)
    (local $tp i32) (local $s i32)
    (local.set $tp (call $a (local.get $t)))
    (local.set $s (i32.load $h offset=20 (local.get $tp)))
    (if (local.get $s)
      (then
        (i32.store $h offset=4 (call $a (local.get $s)) (local.get $state))
        (call $notify_call (local.get $s))
        (return)))
    (if (i32.and (i32.ne (i32.and (i32.load $h offset=44 (local.get $tp)) (i32.const 4))
            (i32.const 0))
          (i32.ge_u (local.get $state) (i32.const 3)))
      (then (call $host.task-cancelled (local.get $t) (local.get $state)))))

  ;; A synchronously lifted call returned its value.
  (func (export "task.resolve") (param $t i32)
    (local $tp i32)
    (local.set $tp (call $a (local.get $t)))
    (if (i32.load $h offset=4 (local.get $tp)) (then (call $fail (i32.const 5))))
    (i32.store $h offset=12 (local.get $tp) (i32.const 5))
    (call $resolve_super (local.get $t) (i32.const 2)))

  (func $exit (export "task.exit") (param $t i32)
    (local $tp i32) (local $s i32)
    (local.set $tp (call $a (local.get $t)))
    (if (i32.ne (i32.load $h offset=12 (local.get $tp)) (i32.const 5))
      (then (call $fail (i32.const 6))))
    (if (i32.load $h offset=4 (local.get $tp)) (then (call $fail (i32.const 5))))
    (local.set $s (i32.load $h offset=20 (local.get $tp)))
    (if (local.get $s)
      (then (i32.store $h offset=28 (call $a (local.get $s)) (i32.const 0))))
    (if (i32.and (i32.load $h offset=44 (local.get $tp)) (i32.const 2))
      (then (call $list.remove (local.get $t))))
    (call $free_args (local.get $tp))
    (if (i32.and (i32.load $h offset=44 (local.get $tp)) (i32.const 8))
      (then
        (i32.store $h offset=44 (local.get $tp)
          (i32.or (i32.load $h offset=44 (local.get $tp)) (i32.const 16)))
        (return)))
    (call $handle.free (local.get $t)))

  ;; The current task of frame `f`, which must return through `task.return`.
  (func $current_async (param $f i32) (result i32)
    (local $t i32) (local $tp i32)
    (local.set $t (global.get $cur_task))
    (if (i32.eqz (local.get $t)) (then (call $fail (i32.const 4))))
    (local.set $tp (call $a (local.get $t)))
    (if (i32.or (i32.ne (i32.load $h offset=8 (local.get $tp)) (local.get $f))
          (i32.eqz (i32.and (i32.load $h offset=44 (local.get $tp)) (i32.const 1))))
      (then (call $fail (i32.const 4))))
    (local.get $tp))

  ;; `task.return`, its flat values in the scratch area.
  (func (export "task.return") (param $f i32) (param $rtype i32) (param $rmem i32)
    (local $tp i32)
    (local.set $tp (call $current_async (local.get $f)))
    (if (i32.eq (i32.load $h offset=12 (local.get $tp)) (i32.const 5))
      (then (call $fail (i32.const 4))))
    (if (i32.or (i32.ne (i32.load $h offset=52 (local.get $tp)) (local.get $rtype))
          (i32.ne (i32.load $h offset=56 (local.get $tp)) (local.get $rmem)))
      (then (call $fail (i32.const 18))))
    (if (i32.load $h offset=4 (local.get $tp)) (then (call $fail (i32.const 5))))
    (call $dispatch.resolve (global.get $cur_task))
    (i32.store $h offset=12 (local.get $tp) (i32.const 5))
    (call $resolve_super (global.get $cur_task) (i32.const 2)))

  (func (export "task.cancel") (param $f i32)
    (local $tp i32)
    (local.set $tp (call $current_async (local.get $f)))
    (if (i32.ne (i32.load $h offset=12 (local.get $tp)) (i32.const 4))
      (then (call $fail (i32.const 4))))
    (if (i32.load $h offset=4 (local.get $tp)) (then (call $fail (i32.const 5))))
    (i32.store $h offset=12 (local.get $tp) (i32.const 5))
    (call $resolve_super (global.get $cur_task) (i32.const 4)))

  ;; The status an async caller gets once its call has started or waits to:
  ;; returned, freeing the subtask, or the subtask's state and its index in
  ;; the caller's table, where it goes now.
  (func (export "call.status") (param $s i32) (result i32)
    (local $sp i32) (local $state i32)
    (local.set $sp (call $a (local.get $s)))
    (local.set $state (i32.load $h offset=4 (local.get $sp)))
    (if (i32.ge_u (local.get $state) (i32.const 2))
      (then
        (call $deliver_resolve (local.get $sp))
        (call $free_call (local.get $s))
        (return (local.get $state))))
    (i32.store $h offset=36 (local.get $sp)
      (i32.or (i32.load $h offset=36 (local.get $sp)) (i32.const 8)))
    (i32.or (local.get $state)
      (i32.shl (call $publish (i32.load $h offset=8 (local.get $sp)) (local.get $s))
        (i32.const 4))))

  ;; A synchronous caller waits for its call to resolve and takes back its
  ;; lends; the thunk reads the result and frees the call.
  (func (export "call.wait") (param $s i32)
    (local $sp i32)
    (local.set $sp (call $a (local.get $s)))
    (if (i32.lt_u (i32.load $h offset=4 (local.get $sp)) (i32.const 2))
      (then (call $run_until (i32.const 2) (local.get $s))))
    (call $deliver_resolve (local.get $sp)))

  (func $free_call (export "call.free") (param $s i32)
    (local $t i32)
    (local.set $t (i32.load $h offset=28 (call $a (local.get $s))))
    (if (local.get $t)
      (then (i32.store $h offset=20 (call $a (local.get $t)) (i32.const 0))))
    (call $handle.free (local.get $s)))

  (func (export "call.out") (param $s i32) (result i32)
    (i32.load $h offset=40 (call $a (local.get $s))))

  (func (export "subtask.drop") (param $f i32) (param $l i32)
    (local $s i32)
    (local.set $s (call $get (i32.const -4) (local.get $f) (local.get $l)))
    (if (i32.eqz (i32.and (i32.load $h offset=36 (call $a (local.get $s))) (i32.const 1)))
      (then (call $fail (i32.const 9))))
    (call $join (local.get $s) (i32.const 0))
    (drop (call $unpublish (local.get $f) (local.get $l)))
    (call $free_call (local.get $s)))

  ;; Asks task `t` to stop: one still waiting to enter is cancelled before
  ;; it starts; one waiting in its event loop hears of it now.
  (func $request_cancellation (param $t i32)
    (local $tp i32) (local $fp i32)
    (local.set $tp (call $a (local.get $t)))
    (if (i32.eq (i32.load $h offset=12 (local.get $tp)) (i32.const 1))
      (then
        (call $list.remove (local.get $t))
        (local.set $fp (call $frame (i32.load $h offset=8 (local.get $tp))))
        (i32.store $s offset=8 (local.get $fp)
          (i32.sub (i32.load $s offset=8 (local.get $fp)) (i32.const 1)))
        (i32.store $h offset=12 (local.get $tp) (i32.const 5))
        (call $resolve_super (local.get $t) (i32.const 3))
        (call $exit (local.get $t))
        (return)))
    (i32.store $h offset=12 (local.get $tp) (i32.const 3))
    (if (i32.and (i32.load $h offset=44 (local.get $tp)) (i32.const 2))
      (then
        (if (call $ready (local.get $t) (i32.const 0))
          (then
            (call $list.remove (local.get $t))
            (call $step (local.get $t)))))))

  (func (export "subtask.cancel") (param $f i32) (param $l i32) (param $async i32)
    (result i32)
    (local $s i32) (local $sp i32) (local $flags i32)
    (local.set $s (call $get (i32.const -4) (local.get $f) (local.get $l)))
    (local.set $sp (call $a (local.get $s)))
    (local.set $flags (i32.load $h offset=36 (local.get $sp)))
    (if (i32.and (local.get $flags) (i32.const 3)) (then (call $fail (i32.const 9))))
    (if (i32.load $h offset=16 (local.get $sp)) (then (call $fail (i32.const 14))))
    (if (i32.lt_u (i32.load $h offset=4 (local.get $sp)) (i32.const 2))
      (then
        (i32.store $h offset=36 (local.get $sp) (i32.or (local.get $flags) (i32.const 2)))
        (i32.store $h offset=24 (local.get $sp) (i32.const 1))
        (if (i32.and (local.get $flags) (i32.const 4))
          (then (call $host.cancel (local.get $s)))
          (else (call $request_cancellation (i32.load $h offset=28 (local.get $sp)))))
        (if (i32.and (i32.eqz (local.get $async))
              (i32.lt_u (i32.load $h offset=4 (local.get $sp)) (i32.const 2)))
          (then (call $run_until (i32.const 2) (local.get $s))))
        (i32.store $h offset=24 (local.get $sp) (i32.const 0))
        (if (i32.lt_u (i32.load $h offset=4 (local.get $sp)) (i32.const 2))
          (then (return (i32.const -1))))))
    (drop (call $take_event (local.get $s)))
    (global.get $p2))

  ;; The scheduler.

  (func $ready (param $t i32) (param $use_epoch i32) (result i32)
    (local $tp i32) (local $code i32) (local $f i32)
    (local.set $tp (call $a (local.get $t)))
    (local.set $f (i32.load $h offset=8 (local.get $tp)))
    (local.set $code (i32.load $h offset=32 (local.get $tp)))
    (if (i32.eq (i32.and (local.get $code) (i32.const 15)) (i32.const 3))
      (then (return (i32.eqz (call $held_back (local.get $t))))))
    (if (i32.load $s offset=4 (call $frame (local.get $f))) (then (return (i32.const 0))))
    ;; A pump gives each task one turn: one that went back to waiting during
    ;; it waits for the next.
    (if (i32.and (local.get $use_epoch)
          (i32.eq (i32.load $h offset=40 (local.get $tp)) (global.get $epoch)))
      (then (return (i32.const 0))))
    (if (i32.eq (i32.and (local.get $code) (i32.const 15)) (i32.const 1))
      (then (return (i32.const 1))))
    (if (i32.eq (i32.load $h offset=12 (local.get $tp)) (i32.const 3))
      (then (return (i32.const 1))))
    (i32.ne (i32.load $h offset=16
      (call $a (i32.shr_u (local.get $code) (i32.const 4)))) (i32.const 0)))

  ;; Runs one turn of task `t`, just taken off the list.
  (func $step (param $t i32)
    (local $tp i32) (local $code i32) (local $s i32) (local $fp i32)
    (local $event i32) (local $p1 i32) (local $p2 i32)
    (local.set $tp (call $a (local.get $t)))
    (local.set $code (i32.load $h offset=32 (local.get $tp)))
    (if (i32.eq (i32.and (local.get $code) (i32.const 15)) (i32.const 3))
      (then
        (local.set $fp (call $frame (i32.load $h offset=8 (local.get $tp))))
        (i32.store $s offset=8 (local.get $fp)
          (i32.sub (i32.load $s offset=8 (local.get $fp)) (i32.const 1)))
        (call $dispatch.start (local.get $t))
        (return)))
    (if (i32.eq (i32.and (local.get $code) (i32.const 15)) (i32.const 2))
      (then
        (local.set $s (i32.shr_u (local.get $code) (i32.const 4)))
        (i32.store $h offset=12 (call $a (local.get $s))
          (i32.sub (i32.load $h offset=12 (call $a (local.get $s))) (i32.const 1)))))
    (if (i32.eq (i32.load $h offset=12 (local.get $tp)) (i32.const 3))
      (then
        (i32.store $h offset=12 (local.get $tp) (i32.const 4))
        (local.set $event (i32.const 6)))
      (else
        (if (local.get $s)
          (then
            (local.set $event (call $take_event
              (i32.load $h offset=16 (call $a (local.get $s)))))
            (local.set $p1 (global.get $p1))
            (local.set $p2 (global.get $p2))))))
    (call $after (local.get $t)
      (call $run_callback (local.get $t) (local.get $event) (local.get $p1) (local.get $p2))))

  ;; Runs one ready task, of frame `restrict` unless it is negative.
  (func $run_one (param $restrict i32) (param $use_epoch i32) (result i32)
    (local $prev i32) (local $t i32)
    (local.set $t (global.get $head))
    (block $none
      (loop $next
        (br_if $none (i32.eqz (local.get $t)))
        (if (i32.and
              (i32.or (i32.lt_s (local.get $restrict) (i32.const 0))
                (i32.eq (i32.load $h offset=8 (call $a (local.get $t))) (local.get $restrict)))
              (call $ready (local.get $t) (local.get $use_epoch)))
          (then
            (call $list.unlink (local.get $prev) (local.get $t))
            (call $step (local.get $t))
            (return (i32.const 1))))
        (local.set $prev (local.get $t))
        (local.set $t (i32.load $h offset=36 (call $a (local.get $t))))
        (br $next)))
    (i32.const 0))

  ;; Whether a wait's condition holds: 1 task `x` may enter, 2 call `x` is
  ;; resolved, 3 set `x` has an event, 4 waitable `x` has an event.
  (func $holds (param $cond i32) (param $x i32) (result i32)
    (local $p i32)
    (local.set $p (call $a (local.get $x)))
    (block $enter
      (block $resolved
        (block $set
          (block $pending
            (br_table $enter $enter $resolved $set $pending (local.get $cond)))
          (return (i32.load $h offset=12 (local.get $p))))
        (return (i32.ne (i32.load $h offset=16 (local.get $p)) (i32.const 0))))
      (return (i32.ge_u (i32.load $h offset=4 (local.get $p)) (i32.const 2))))
    (i32.eqz (call $held_back (local.get $x))))

  ;; Blocks the current thread until the condition holds, running whatever
  ;; else can run meanwhile. Under a synchronously typed call only that
  ;; call's frame may make progress, as the canonical ABI lets its ready
  ;; threads; otherwise anything may, the host included.
  (func $run_until (param $cond i32) (param $x i32)
    (loop $again
      (if (call $holds (local.get $cond) (local.get $x)) (then (return)))
      (if (i32.ge_s (global.get $sync_frame) (i32.const 0))
        (then
          (br_if $again (call $run_one (global.get $sync_frame) (i32.const 0)))
          (call $fail (i32.const 2))))
      (br_if $again (call $run_one (i32.const -1) (i32.const 0)))
      (br_if $again (call $host_flush))
      (if (i32.or (global.get $host_pending) (global.get $host_held))
        (then (br_if $again (call $host.wait))))
      (call $fail (i32.const 1))))

  (func (export "thread.yield") (result i32)
    (drop (call $run_one (global.get $sync_frame) (i32.const 0)))
    (i32.const 0))

  ;; Gives every task that is ready, or becomes ready meanwhile, one turn.
  ;; Returns whether a task has something new to handle, for the host to
  ;; pump again: a task that only yields gets its turn in the next pump,
  ;; and does not keep a host that pumps until this returns 0 pumping.
  (func (export "pump") (result i32)
    (local $t i32)
    (if (i32.or (global.get $cur_task)
          (i32.ge_s (global.get $sync_frame) (i32.const 0)))
      (then (call $fail (i32.const 16))))
    (global.set $epoch (i32.add (global.get $epoch) (i32.const 1)))
    (loop $again
      (br_if $again (call $host_flush))
      (br_if $again (call $run_one (i32.const -1) (i32.const 1))))
    (local.set $t (global.get $head))
    (block $none
      (loop $next
        (br_if $none (i32.eqz (local.get $t)))
        (if (i32.and (call $ready (local.get $t) (i32.const 0))
              (i32.eqz (call $only_yields (local.get $t))))
          (then (return (i32.const 1))))
        (local.set $t (i32.load $h offset=36 (call $a (local.get $t))))
        (br $next)))
    (i32.const 0))

  ;; Whether task `t` waits for nothing but its next turn: it yielded, and
  ;; no cancellation waits for it.
  (func $only_yields (param $t i32) (result i32)
    (local $tp i32)
    (local.set $tp (call $a (local.get $t)))
    (i32.and
      (i32.eq (i32.and (i32.load $h offset=32 (local.get $tp)) (i32.const 15)) (i32.const 1))
      (i32.ne (i32.load $h offset=12 (local.get $tp)) (i32.const 3))))

  ;; The host's side, which names subtasks and tasks by their objects.

  ;; An async import the host runs has started: it resolves it later.
  (func (export "host.started") (param $s i32) (result i32)
    (local $sp i32)
    (local.set $sp (call $a (local.get $s)))
    (i32.store $h offset=4 (local.get $sp) (i32.const 1))
    (i32.store $h offset=36 (local.get $sp)
      (i32.or (i32.load $h offset=36 (local.get $sp)) (i32.const 8)))
    (global.set $host_pending (i32.add (global.get $host_pending) (i32.const 1)))
    (i32.or (i32.const 1)
      (i32.shl (call $publish (i32.load $h offset=8 (local.get $sp)) (local.get $s))
        (i32.const 4))))

  ;; The host resolves an async import it started: 2 returned, its result
  ;; written, or 4 cancelled.
  (func (export "host.resolve") (param $s i32) (param $state i32)
    (local $sp i32)
    (if (i32.or (i32.eqz (local.get $s))
          (i32.gt_u (local.get $s) (i32.load $h (i32.const 0))))
      (then (call $fail (i32.const 16))))
    (local.set $sp (call $a (local.get $s)))
    (if (i32.or (i32.ne (i32.load $h (local.get $sp)) (i32.const -4))
          (i32.or (i32.eqz (i32.and (i32.load $h offset=36 (local.get $sp)) (i32.const 4)))
            (i32.ne (i32.load $h offset=4 (local.get $sp)) (i32.const 1))))
      (then (call $fail (i32.const 16))))
    (if (i32.eq (local.get $state) (i32.const 2))
      (then (call $dispatch.host-resolve (local.get $s)))
      (else
        (if (i32.or (i32.ne (local.get $state) (i32.const 4))
              (i32.eqz (i32.and (i32.load $h offset=36 (local.get $sp)) (i32.const 2))))
          (then (call $fail (i32.const 16))))))
    (i32.store $h offset=4 (local.get $sp) (local.get $state))
    (global.set $host_pending (i32.sub (global.get $host_pending) (i32.const 1)))
    (call $set_pending (local.get $s)))

  ;; The status of a call the host made: returned, or started or starting
  ;; with the task. Releases the task the host's call kept.
  (func (export "host.status") (param $t i32) (result i32)
    (local $tp i32) (local $state i32) (local $flags i32)
    (local.set $tp (call $a (local.get $t)))
    (local.set $state (i32.load $h offset=12 (local.get $tp)))
    (local.set $flags (i32.load $h offset=44 (local.get $tp)))
    (i32.store $h offset=44 (local.get $tp) (i32.and (local.get $flags) (i32.const -9)))
    (if (i32.and (local.get $flags) (i32.const 16))
      (then (call $handle.free (local.get $t))))
    (if (i32.eq (local.get $state) (i32.const 5))
      (then (return (i32.const 2))))
    (i32.or (select (i32.const 0) (i32.const 1) (i32.eq (local.get $state) (i32.const 1)))
      (i32.shl (local.get $t) (i32.const 4))))

  ;; The host asks a task it started to stop; it hears how the task ended
  ;; through `task-return` or `task-cancelled`.
  (func (export "host.cancel") (param $t i32)
    (local $tp i32) (local $state i32)
    (if (i32.or (i32.eqz (local.get $t))
          (i32.gt_u (local.get $t) (i32.load $h (i32.const 0))))
      (then (call $fail (i32.const 16))))
    (local.set $tp (call $a (local.get $t)))
    (local.set $state (i32.load $h offset=12 (local.get $tp)))
    (if (i32.or (i32.ne (i32.load $h (local.get $tp)) (i32.const -6))
          (i32.or (i32.eqz (i32.and (i32.load $h offset=44 (local.get $tp)) (i32.const 4)))
            (i32.and (i32.ne (local.get $state) (i32.const 1))
              (i32.ne (local.get $state) (i32.const 2)))))
      (then (call $fail (i32.const 16))))
    (call $request_cancellation (local.get $t)))

  ;; Streams and futures.

  (func (export "end.new") (param $f i32) (param $type i32) (param $future i32) (result i64)
    (call $end_new_of (local.get $f) (local.get $type) (local.get $future)))

  (func $end_new_of (param $f i32) (param $type i32) (param $future i32) (result i64)
    (local $r i32) (local $w i32) (local $rp i32) (local $wp i32)
    (local.set $r (call $alloc (call $end_kind (i32.const 1) (local.get $future)) (local.get $f)))
    (local.set $w (call $alloc (call $end_kind (i32.const 0) (local.get $future)) (local.get $f)))
    (local.set $rp (call $a (local.get $r)))
    (local.set $wp (call $a (local.get $w)))
    (i32.store $h offset=4 (local.get $rp) (i32.const 1))
    (i32.store $h offset=4 (local.get $wp) (i32.const 1))
    (i32.store $h offset=28 (local.get $rp) (local.get $w))
    (i32.store $h offset=28 (local.get $wp) (local.get $r))
    (i32.store $h offset=32 (local.get $rp) (local.get $type))
    (i32.store $h offset=32 (local.get $wp) (local.get $type))
    (i64.or (i64.extend_i32_u (call $publish (local.get $f) (local.get $r)))
      (i64.shl (i64.extend_i32_u (call $publish (local.get $f) (local.get $w))) (i64.const 32))))

  (func $get_end (param $f i32) (param $type i32) (param $l i32) (param $read i32)
    (param $future i32) (result i32)
    (local $e i32)
    (local.set $e (call $get (call $end_kind (local.get $read) (local.get $future))
      (local.get $f) (local.get $l)))
    (if (i32.ne (i32.load $h offset=32 (call $a (local.get $e))) (local.get $type))
      (then (call $fail (i32.const 11))))
    (local.get $e))

  ;; The side of the buffer of end `e`, the host's resolved by its type.
  (func $side (param $e i32) (result i32)
    (local $side i32)
    (local.set $side (i32.load $h offset=48 (call $a (local.get $e))))
    (if (result i32) (i32.eq (local.get $side) (i32.const 0x7fffffff))
      (then (call $host.side (i32.load $h offset=32 (call $a (local.get $e)))))
      (else (local.get $side))))

  (func $notify (param $e i32) (param $progress i32)
    (i32.store $h offset=52 (call $a (local.get $e)) (local.get $progress))
    (call $set_pending (local.get $e)))

  ;; `End.copy`: rendezvous with the other end's buffer, if it has one.
  (func $copy (param $e i32) (param $side i32) (param $ptr i32) (param $len i32)
    (param $read i32) (param $numberish i32)
    (local $ep i32) (local $o i32) (local $op i32) (local $remain i32) (local $n i32)
    (local.set $ep (call $a (local.get $e)))
    (i32.store $h offset=4 (local.get $ep) (i32.const 2))
    (local.set $o (i32.load $h offset=28 (local.get $ep)))
    ;; A dropped other end left its event already.
    (if (i32.eqz (local.get $o)) (then (return)))
    (local.set $op (call $a (local.get $o)))
    (if (i32.eqz (i32.load $h offset=48 (local.get $op)))
      (then
        (i32.store $h offset=48 (local.get $ep) (local.get $side))
        (i32.store $h offset=36 (local.get $ep) (local.get $ptr))
        (i32.store $h offset=40 (local.get $ep) (local.get $len))
        (i32.store $h offset=44 (local.get $ep) (i32.const 0))
        (return)))
    (local.set $remain (i32.sub (i32.load $h offset=40 (local.get $op))
      (i32.load $h offset=44 (local.get $op))))
    (if (i32.and (i32.ne (local.get $len) (i32.const 0)) (i32.ne (local.get $remain) (i32.const 0)))
      (then
        (if (i32.and (i32.eq (i32.load $h offset=8 (local.get $ep))
                (i32.load $h offset=8 (local.get $op)))
              (i32.eqz (local.get $numberish)))
          (then (call $fail (i32.const 12))))
        (local.set $n (select (local.get $len) (local.get $remain)
          (i32.lt_u (local.get $len) (local.get $remain))))
        (if (i32.eq (local.get $side) (i32.const 0x7fffffff))
          (then (local.set $side (call $host.side (i32.load $h offset=32 (local.get $ep))))))
        (if (local.get $read)
          (then (call $dispatch.copy (call $side (local.get $o)) (local.get $side)
            (i32.load $h offset=36 (local.get $op)) (i32.load $h offset=44 (local.get $op))
            (local.get $ptr) (i32.const 0) (local.get $n)))
          (else (call $dispatch.copy (local.get $side) (call $side (local.get $o))
            (local.get $ptr) (i32.const 0)
            (i32.load $h offset=36 (local.get $op)) (i32.load $h offset=44 (local.get $op))
            (local.get $n))))
        (i32.store $h offset=44 (local.get $op)
          (i32.add (i32.load $h offset=44 (local.get $op)) (local.get $n)))
        (call $notify (local.get $e) (local.get $n))
        (call $notify (local.get $o) (i32.load $h offset=44 (local.get $op)))
        (if (i32.eq (i32.load $h offset=44 (local.get $op)) (i32.load $h offset=40 (local.get $op)))
          (then (i32.store $h offset=48 (local.get $op) (i32.const 0))))
        (return)))
    (if (i32.or (i32.ne (local.get $len) (i32.const 0))
          (i32.and (local.get $read) (i32.eqz (local.get $remain))))
      (then
        (call $notify (local.get $o) (i32.const 0))
        (i32.store $h offset=48 (local.get $op) (i32.const 0))
        (i32.store $h offset=48 (local.get $ep) (local.get $side))
        (i32.store $h offset=36 (local.get $ep) (local.get $ptr))
        (i32.store $h offset=40 (local.get $ep) (local.get $len))
        (i32.store $h offset=44 (local.get $ep) (i32.const 0))
        (return)))
    (call $notify (local.get $e) (i32.const 0)))

  ;; `{stream,future}.{read,write}`: the copy's result, or -1 when an
  ;; async copy blocks.
  (func (export "end.copy")
    (param $f i32) (param $type i32) (param $l i32) (param $side i32) (param $ptr i32)
    (param $len i32) (param $async i32) (param $read i32) (param $future i32)
    (param $numberish i32) (result i32)
    (local $e i32) (local $ep i32)
    (local.set $e (call $get_end (local.get $f) (local.get $type) (local.get $l)
      (local.get $read) (local.get $future)))
    (local.set $ep (call $a (local.get $e)))
    (if (i32.ne (i32.load $h offset=4 (local.get $ep)) (i32.const 1))
      (then (call $fail (i32.const 10))))
    (if (i32.and (i32.ne (i32.load $h offset=16 (local.get $ep)) (i32.const 0))
          (i32.eqz (local.get $async)))
      (then (call $fail (i32.const 14))))
    (call $copy (local.get $e) (local.get $side) (local.get $ptr) (local.get $len)
      (local.get $read) (local.get $numberish))
    (if (i32.eqz (i32.load $h offset=12 (local.get $ep)))
      (then
        (if (local.get $async) (then (return (i32.const -1))))
        (i32.store $h offset=24 (local.get $ep) (i32.const 1))
        (call $run_until (i32.const 4) (local.get $e))
        (i32.store $h offset=24 (local.get $ep) (i32.const 0))))
    (drop (call $take_event (local.get $e)))
    (global.get $p2))

  (func (export "end.cancel")
    (param $f i32) (param $type i32) (param $l i32) (param $async i32) (param $read i32)
    (param $future i32) (result i32)
    (local $e i32) (local $ep i32)
    (local.set $e (call $get_end (local.get $f) (local.get $type) (local.get $l)
      (local.get $read) (local.get $future)))
    (local.set $ep (call $a (local.get $e)))
    (if (i32.ne (i32.load $h offset=4 (local.get $ep)) (i32.const 2))
      (then (call $fail (i32.const 10))))
    (if (i32.load $h offset=24 (local.get $ep)) (then (call $fail (i32.const 14))))
    (if (i32.and (i32.ne (i32.load $h offset=16 (local.get $ep)) (i32.const 0))
          (i32.eqz (local.get $async)))
      (then (call $fail (i32.const 14))))
    (i32.store $h offset=4 (local.get $ep) (i32.const 3))
    ;; Both ends belong to the linked program, so cancelling completes at once.
    (if (i32.eqz (i32.load $h offset=12 (local.get $ep)))
      (then (call $notify (local.get $e) (i32.const 0))))
    (drop (call $take_event (local.get $e)))
    (global.get $p2))

  (func (export "end.drop")
    (param $f i32) (param $type i32) (param $l i32) (param $read i32) (param $future i32)
    (call $end_drop (local.get $f) (local.get $type) (local.get $l) (local.get $read)
      (local.get $future)))

  (func $end_drop
    (param $f i32) (param $type i32) (param $l i32) (param $read i32) (param $future i32)
    (local $e i32) (local $ep i32) (local $o i32) (local $op i32) (local $state i32)
    (local.set $e (call $get_end (local.get $f) (local.get $type) (local.get $l)
      (local.get $read) (local.get $future)))
    (local.set $ep (call $a (local.get $e)))
    (local.set $state (i32.load $h offset=4 (local.get $ep)))
    (if (i32.or (i32.eq (local.get $state) (i32.const 2)) (i32.eq (local.get $state) (i32.const 3)))
      (then (call $fail (i32.const 10))))
    (if (i32.and (i32.and (local.get $future) (i32.eqz (local.get $read)))
          (i32.ne (local.get $state) (i32.const 4)))
      (then (call $fail (i32.const 10))))
    (local.set $o (i32.load $h offset=28 (local.get $ep)))
    (if (local.get $o)
      (then
        (local.set $op (call $a (local.get $o)))
        (i32.store $h offset=28 (local.get $op) (i32.const 0))
        (if (i32.and (i32.ne (i32.load $h offset=4 (local.get $op)) (i32.const 4))
              (i32.eqz (i32.load $h offset=12 (local.get $op))))
          (then (call $notify (local.get $o) (i32.const 0))))))
    (call $join (local.get $e) (i32.const 0))
    (drop (call $unpublish (local.get $f) (local.get $l)))
    (if (i32.eq (local.get $f) (call $host.frame))
      (then (global.set $host_held (i32.sub (global.get $host_held) (i32.const 1)))))
    (call $handle.free (local.get $e)))

  ;; Moves the readable end at index `l` of frame `from`'s table to frame
  ;; `to`'s, as lifting and lowering a stream or future value do: its index
  ;; there.
  (func (export "end.move")
    (param $from i32) (param $to i32) (param $l i32) (param $type i32) (param $future i32)
    (result i32)
    (local $e i32) (local $ep i32) (local $o i32)
    ;; An end the host made takes the type of the first place it crosses.
    (if (i32.eq (local.get $from) (call $host.frame))
      (then
        (local.set $e (call $get (call $end_kind (i32.const 1) (local.get $future))
          (local.get $from) (local.get $l)))
        (if (i32.eq (i32.load $h offset=32 (call $a (local.get $e))) (i32.const -1))
          (then
            (i32.store $h offset=32 (call $a (local.get $e)) (local.get $type))
            (local.set $o (i32.load $h offset=28 (call $a (local.get $e))))
            (if (local.get $o)
              (then (i32.store $h offset=32 (call $a (local.get $o)) (local.get $type))))))))
    (local.set $e (call $get_end (local.get $from) (local.get $type) (local.get $l)
      (i32.const 1) (local.get $future)))
    (local.set $ep (call $a (local.get $e)))
    (if (i32.ne (i32.load $h offset=4 (local.get $ep)) (i32.const 1))
      (then (call $fail (i32.const 10))))
    (if (i32.load $h offset=16 (local.get $ep)) (then (call $fail (i32.const 14))))
    (drop (call $unpublish (local.get $from) (local.get $l)))
    (i32.store $h offset=8 (local.get $ep) (local.get $to))
    (if (i32.eq (local.get $from) (call $host.frame))
      (then (global.set $host_held (i32.sub (global.get $host_held) (i32.const 1)))))
    (if (i32.eq (local.get $to) (call $host.frame))
      (then (global.set $host_held (i32.add (global.get $host_held) (i32.const 1)))))
    (call $publish (local.get $to) (local.get $e)))

  ;; The host's ends. It names them by its table's indices, and passes the
  ;; pointer and length of a buffer in its memory (one value for a future).
  ;; Its operations never block: a copy that cannot complete at once
  ;; returns -1, and its event comes through `host-event`.

  ;; A new stream or future: the readable end's index in the low bits, the
  ;; writable end's in the high. Its type is the one its readable end first
  ;; crosses into a component as.
  (func (export "host.stream-new") (result i64)
    (call $host_new (i32.const 0)))

  (func (export "host.future-new") (result i64)
    (call $host_new (i32.const 1)))

  (func $host_new (param $future i32) (result i64)
    (global.set $host_held (i32.add (global.get $host_held) (i32.const 2)))
    (call $end_new_of (call $host.frame) (i32.const -1) (local.get $future)))

  ;; The end at index `l` of the host's table, which must be of the kind the
  ;; operation takes: a readable end to read, a writable end to write.
  (func $host_end (param $l i32) (param $read i32) (result i32)
    (local $e i32) (local $kind i32)
    (local.set $e (call $lookup (call $host.frame) (local.get $l)))
    (local.set $kind (i32.load $h (call $a (local.get $e))))
    (if (i32.eqz (i32.or
          (i32.eq (local.get $kind) (call $end_kind (local.get $read) (i32.const 0)))
          (i32.eq (local.get $kind) (call $end_kind (local.get $read) (i32.const 1)))))
      (then (call $fail (i32.const 3))))
    (local.get $e))

  (func $is_future (param $e i32) (result i32)
    (i32.le_s (i32.load $h (call $a (local.get $e))) (i32.const -11)))

  (func (export "host.read") (param $l i32) (param $ptr i32) (param $len i32) (result i32)
    (call $host_copy (local.get $l) (local.get $ptr) (local.get $len) (i32.const 1)))

  (func (export "host.write") (param $l i32) (param $ptr i32) (param $len i32) (result i32)
    (call $host_copy (local.get $l) (local.get $ptr) (local.get $len) (i32.const 0)))

  ;; Reads (1) or writes (0) the end at index `l`: the copy's result, or -1
  ;; when it completes later.
  (func $host_copy (param $l i32) (param $ptr i32) (param $len i32) (param $read i32)
    (result i32)
    (local $e i32) (local $ep i32)
    (local.set $e (call $host_end (local.get $l) (local.get $read)))
    (local.set $ep (call $a (local.get $e)))
    (if (i32.and (call $is_future (local.get $e)) (i32.ne (local.get $len) (i32.const 1)))
      (then (call $fail (i32.const 17))))
    (if (i32.ne (i32.load $h offset=4 (local.get $ep)) (i32.const 1))
      (then (call $fail (i32.const 10))))
    ;; An end that has crossed nowhere has no type to copy by.
    (if (i32.eq (i32.load $h offset=32 (local.get $ep)) (i32.const -1))
      (then (call $fail (i32.const 11))))
    (call $copy (local.get $e) (i32.const 0x7fffffff) (local.get $ptr) (local.get $len)
      (local.get $read) (i32.const 1))
    (if (i32.eqz (i32.load $h offset=12 (local.get $ep)))
      (then (return (i32.const -1))))
    (drop (call $take_event (local.get $e)))
    (global.get $p2))

  (func (export "host.cancel-read") (param $l i32) (result i32)
    (call $host_cancel_copy (local.get $l) (i32.const 1)))

  (func (export "host.cancel-write") (param $l i32) (result i32)
    (call $host_cancel_copy (local.get $l) (i32.const 0)))

  ;; Cancels the copy the end at index `l` has pending: its result, which
  ;; takes the place of the copy's event.
  (func $host_cancel_copy (param $l i32) (param $read i32) (result i32)
    (local $e i32) (local $ep i32)
    (local.set $e (call $host_end (local.get $l) (local.get $read)))
    (local.set $ep (call $a (local.get $e)))
    (if (i32.ne (i32.load $h offset=4 (local.get $ep)) (i32.const 2))
      (then (call $fail (i32.const 10))))
    (i32.store $h offset=4 (local.get $ep) (i32.const 3))
    (if (i32.eqz (i32.load $h offset=12 (local.get $ep)))
      (then (call $notify (local.get $e) (i32.const 0))))
    (drop (call $take_event (local.get $e)))
    (global.get $p2))

  (func (export "host.drop") (param $l i32)
    (local $e i32) (local $kind i32)
    (local.set $e (call $lookup (call $host.frame) (local.get $l)))
    (local.set $kind (i32.load $h (call $a (local.get $e))))
    (if (i32.or (i32.gt_s (local.get $kind) (i32.const -9)) (i32.lt_s (local.get $kind) (i32.const -12)))
      (then (call $fail (i32.const 3))))
    (call $end_drop (call $host.frame) (i32.load $h offset=32 (call $a (local.get $e))) (local.get $l)
      (i32.or (i32.eq (local.get $kind) (i32.const -9)) (i32.eq (local.get $kind) (i32.const -11)))
      (call $is_future (local.get $e))))

  ;; A built-in that needs stack switching.
  (func (export "unsupported")
    (call $fail (i32.const 19)))
)
