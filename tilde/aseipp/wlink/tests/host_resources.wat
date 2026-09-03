;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Resources at the package's edge. The host implements `stream`, whose
;; handles this component only holds and passes back; this component
;; implements `counter`, whose handles the host receives and hands back as
;; representations. The wasm2c host test drives both directions.
(component
  (import "host:res/streams" (instance $streams
    (export "stream" (type $stream (sub resource)))
    (export "open" (func (param "id" u32) (result (own $stream))))
    (export "read" (func (param "s" (borrow $stream)) (result u32)))))
  (alias export $streams "stream" (type $stream))
  (core module $d
    (global $destroyed (export "destroyed") (mut i32) (i32.const 0))
    (func (export "dtor") (param i32)
      global.get $destroyed
      local.get 0
      i32.add
      global.set $destroyed))
  (core instance $di (instantiate $d))
  (type $counter (resource (rep i32) (dtor (func $di "dtor"))))
  (core func $new (canon resource.new $counter))
  (core func $rep (canon resource.rep $counter))
  (core func $drop (canon resource.drop $counter))
  (core func $open (canon lower (func $streams "open")))
  (core func $read (canon lower (func $streams "read")))
  (core func $drop_stream (canon resource.drop $stream))
  (core module $m
    (import "env" "destroyed" (global $destroyed (mut i32)))
    (import "[export]host:res/counters" "[resource-new]counter" (func $new (param i32) (result i32)))
    (import "[export]host:res/counters" "[resource-rep]counter" (func $rep (param i32) (result i32)))
    (import "[export]host:res/counters" "[resource-drop]counter" (func $drop (param i32)))
    (import "host:res/streams" "open" (func $open (param i32) (result i32)))
    (import "host:res/streams" "read" (func $read (param i32) (result i32)))
    (import "host:res/streams" "[resource-drop]stream" (func $drop_stream (param i32)))
    (func (export "make") (param i32) (result i32)
      local.get 0
      call $new)
    (func (export "value") (param i32) (result i32)
      local.get 0)
    (func (export "consume") (param i32) (result i32) (local $value i32)
      local.get 0
      call $rep
      local.set $value
      local.get 0
      call $drop
      local.get $value)
    (func (export "destroyed") (result i32)
      global.get $destroyed)
    ;; probe(id): opens a host stream, reads it once, and drops it.
    (func (export "probe") (param i32) (result i32) (local $stream i32) (local $value i32)
      local.get 0
      call $open
      local.tee $stream
      call $read
      local.set $value
      local.get $stream
      call $drop_stream
      local.get $value))
  (core instance $i (instantiate $m
    (with "env" (instance (export "destroyed" (global $di "destroyed"))))
    (with "[export]host:res/counters" (instance
      (export "[resource-new]counter" (func $new))
      (export "[resource-rep]counter" (func $rep))
      (export "[resource-drop]counter" (func $drop))))
    (with "host:res/streams" (instance
      (export "open" (func $open))
      (export "read" (func $read))
      (export "[resource-drop]stream" (func $drop_stream))))))
  (func $make (param "n" u32) (result (own $counter)) (canon lift (core func $i "make")))
  (func $value (param "c" (borrow $counter)) (result u32) (canon lift (core func $i "value")))
  (func $consume (param "c" (own $counter)) (result u32) (canon lift (core func $i "consume")))
  (func $destroyed (result u32) (canon lift (core func $i "destroyed")))
  (func $probe (param "id" u32) (result u32) (canon lift (core func $i "probe")))
  (instance $exports
    (export "counter" (type $counter))
    (export "make" (func $make))
    (export "value" (func $value))
    (export "consume" (func $consume))
    (export "destroyed" (func $destroyed)))
  (export "host:res/counters" (instance $exports))
  (export "probe" (func $probe))
)
