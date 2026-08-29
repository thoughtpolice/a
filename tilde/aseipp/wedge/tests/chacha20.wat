;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; ChaCha20 from RFC 8439 as a small complete program: a multi-value quarter
;; round, the twenty-round block function over sixteen locals, a streaming
;; XOR over linear memory, and a self-test against the RFC's test vectors.
(module
  (memory (export "memory") 1)

  ;; Fixed memory layout. The RFC vectors live in data segments and the
  ;; self-test writes its results after them.
  (global $key i32 (i32.const 0))              ;; 32 bytes
  (global $block_nonce i32 (i32.const 32))     ;; 12 bytes, RFC 8439 §2.3.2
  (global $stream_nonce i32 (i32.const 48))    ;; 12 bytes, RFC 8439 §2.4.2
  (global $expected_block i32 (i32.const 64))  ;; 64 bytes
  (global $plaintext i32 (i32.const 128))      ;; 114 bytes
  (global $ciphertext i32 (i32.const 256))     ;; 114 bytes
  (global $keystream i32 (i32.const 512))      ;; 64-byte scratch block
  (global $output i32 (i32.const 1024))

  (data (i32.const 0)
    "\00\01\02\03\04\05\06\07\08\09\0a\0b\0c\0d\0e\0f"
    "\10\11\12\13\14\15\16\17\18\19\1a\1b\1c\1d\1e\1f")
  (data (i32.const 32) "\00\00\00\09\00\00\00\4a\00\00\00\00")
  (data (i32.const 48) "\00\00\00\00\00\00\00\4a\00\00\00\00")
  (data (i32.const 64)
    "\10\f1\e7\e4\d1\3b\59\15\50\0f\dd\1f\a3\20\71\c4"
    "\c7\d1\f4\c7\33\c0\68\03\04\22\aa\9a\c3\d4\6c\4e"
    "\d2\82\64\46\07\9f\aa\09\14\c2\d7\05\d9\8b\02\a2"
    "\b5\12\9c\d1\de\16\4e\b9\cb\d0\83\e8\a2\50\3c\4e")
  (data (i32.const 128)
    "Ladies and Gentlemen of the class of '99: If I could offer you "
    "only one tip for the future, sunscreen would be it.")
  (data (i32.const 256)
    "\6e\2e\35\9a\25\68\f9\80\41\ba\07\28\dd\0d\69\81"
    "\e9\7e\7a\ec\1d\43\60\c2\0a\27\af\cc\fd\9f\ae\0b"
    "\f9\1b\65\c5\52\47\33\ab\8f\59\3d\ab\cd\62\b3\57"
    "\16\39\d6\24\e6\51\52\ab\8f\53\0c\35\9f\08\61\d8"
    "\07\ca\0d\bf\50\0d\6a\61\56\a3\8e\08\8a\22\b6\5e"
    "\52\bc\51\4d\16\cc\f8\06\81\8c\e9\1a\b7\79\37\36"
    "\5a\f9\0b\bf\74\a3\5b\e6\b4\0b\8e\ed\f2\78\5e\42"
    "\87\4d")

  ;; One quarter round over four state words, returned in the same order.
  (func $quarter_round
      (param $a i32) (param $b i32) (param $c i32) (param $d i32)
      (result i32 i32 i32 i32)
    (local.set $a (i32.add (local.get $a) (local.get $b)))
    (local.set $d (i32.rotl (i32.xor (local.get $d) (local.get $a)) (i32.const 16)))
    (local.set $c (i32.add (local.get $c) (local.get $d)))
    (local.set $b (i32.rotl (i32.xor (local.get $b) (local.get $c)) (i32.const 12)))
    (local.set $a (i32.add (local.get $a) (local.get $b)))
    (local.set $d (i32.rotl (i32.xor (local.get $d) (local.get $a)) (i32.const 8)))
    (local.set $c (i32.add (local.get $c) (local.get $d)))
    (local.set $b (i32.rotl (i32.xor (local.get $b) (local.get $c)) (i32.const 7)))
    (local.get $a) (local.get $b) (local.get $c) (local.get $d))

  ;; Writes the 64-byte keystream block for ($key, $counter, $nonce) to $out.
  ;; The key and nonce are re-read after the rounds, so $out must not overlap
  ;; them.
  (func $block (export "chacha20_block")
      (param $key i32) (param $counter i32) (param $nonce i32) (param $out i32)
    (local $x0 i32) (local $x1 i32) (local $x2 i32) (local $x3 i32)
    (local $x4 i32) (local $x5 i32) (local $x6 i32) (local $x7 i32)
    (local $x8 i32) (local $x9 i32) (local $x10 i32) (local $x11 i32)
    (local $x12 i32) (local $x13 i32) (local $x14 i32) (local $x15 i32)
    (local $rounds i32)

    (local.set $x0 (i32.const 0x61707865))  ;; "expa"
    (local.set $x1 (i32.const 0x3320646e))  ;; "nd 3"
    (local.set $x2 (i32.const 0x79622d32))  ;; "2-by"
    (local.set $x3 (i32.const 0x6b206574))  ;; "te k"
    (local.set $x4 (i32.load offset=0 (local.get $key)))
    (local.set $x5 (i32.load offset=4 (local.get $key)))
    (local.set $x6 (i32.load offset=8 (local.get $key)))
    (local.set $x7 (i32.load offset=12 (local.get $key)))
    (local.set $x8 (i32.load offset=16 (local.get $key)))
    (local.set $x9 (i32.load offset=20 (local.get $key)))
    (local.set $x10 (i32.load offset=24 (local.get $key)))
    (local.set $x11 (i32.load offset=28 (local.get $key)))
    (local.set $x12 (local.get $counter))
    (local.set $x13 (i32.load offset=0 (local.get $nonce)))
    (local.set $x14 (i32.load offset=4 (local.get $nonce)))
    (local.set $x15 (i32.load offset=8 (local.get $nonce)))

    (local.set $rounds (i32.const 10))
    (loop $double_round
      ;; Column round.
      (call $quarter_round (local.get $x0) (local.get $x4) (local.get $x8) (local.get $x12))
      (local.set $x12) (local.set $x8) (local.set $x4) (local.set $x0)
      (call $quarter_round (local.get $x1) (local.get $x5) (local.get $x9) (local.get $x13))
      (local.set $x13) (local.set $x9) (local.set $x5) (local.set $x1)
      (call $quarter_round (local.get $x2) (local.get $x6) (local.get $x10) (local.get $x14))
      (local.set $x14) (local.set $x10) (local.set $x6) (local.set $x2)
      (call $quarter_round (local.get $x3) (local.get $x7) (local.get $x11) (local.get $x15))
      (local.set $x15) (local.set $x11) (local.set $x7) (local.set $x3)
      ;; Diagonal round.
      (call $quarter_round (local.get $x0) (local.get $x5) (local.get $x10) (local.get $x15))
      (local.set $x15) (local.set $x10) (local.set $x5) (local.set $x0)
      (call $quarter_round (local.get $x1) (local.get $x6) (local.get $x11) (local.get $x12))
      (local.set $x12) (local.set $x11) (local.set $x6) (local.set $x1)
      (call $quarter_round (local.get $x2) (local.get $x7) (local.get $x8) (local.get $x13))
      (local.set $x13) (local.set $x8) (local.set $x7) (local.set $x2)
      (call $quarter_round (local.get $x3) (local.get $x4) (local.get $x9) (local.get $x14))
      (local.set $x14) (local.set $x9) (local.set $x4) (local.set $x3)

      (local.set $rounds (i32.sub (local.get $rounds) (i32.const 1)))
      (br_if $double_round (local.get $rounds)))

    ;; Add the initial state back in and serialize the words little-endian.
    (i32.store offset=0 (local.get $out) (i32.add (local.get $x0) (i32.const 0x61707865)))
    (i32.store offset=4 (local.get $out) (i32.add (local.get $x1) (i32.const 0x3320646e)))
    (i32.store offset=8 (local.get $out) (i32.add (local.get $x2) (i32.const 0x79622d32)))
    (i32.store offset=12 (local.get $out) (i32.add (local.get $x3) (i32.const 0x6b206574)))
    (i32.store offset=16 (local.get $out) (i32.add (local.get $x4) (i32.load offset=0 (local.get $key))))
    (i32.store offset=20 (local.get $out) (i32.add (local.get $x5) (i32.load offset=4 (local.get $key))))
    (i32.store offset=24 (local.get $out) (i32.add (local.get $x6) (i32.load offset=8 (local.get $key))))
    (i32.store offset=28 (local.get $out) (i32.add (local.get $x7) (i32.load offset=12 (local.get $key))))
    (i32.store offset=32 (local.get $out) (i32.add (local.get $x8) (i32.load offset=16 (local.get $key))))
    (i32.store offset=36 (local.get $out) (i32.add (local.get $x9) (i32.load offset=20 (local.get $key))))
    (i32.store offset=40 (local.get $out) (i32.add (local.get $x10) (i32.load offset=24 (local.get $key))))
    (i32.store offset=44 (local.get $out) (i32.add (local.get $x11) (i32.load offset=28 (local.get $key))))
    (i32.store offset=48 (local.get $out) (i32.add (local.get $x12) (local.get $counter)))
    (i32.store offset=52 (local.get $out) (i32.add (local.get $x13) (i32.load offset=0 (local.get $nonce))))
    (i32.store offset=56 (local.get $out) (i32.add (local.get $x14) (i32.load offset=4 (local.get $nonce))))
    (i32.store offset=60 (local.get $out) (i32.add (local.get $x15) (i32.load offset=8 (local.get $nonce)))))

  ;; XORs $length bytes at $input with the keystream for ($key, $counter,
  ;; $nonce) into $output, one 64-byte block at a time, using the 64 bytes at
  ;; $scratch for the keystream. $input and $output may be the same buffer.
  (func $xor (export "chacha20_xor")
      (param $key i32) (param $counter i32) (param $nonce i32)
      (param $input i32) (param $length i32) (param $output i32)
      (param $scratch i32)
    (local $chunk i32)
    (local $index i32)
    (block $done
      (loop $blocks
        (br_if $done (i32.eqz (local.get $length)))
        (call $block (local.get $key) (local.get $counter) (local.get $nonce) (local.get $scratch))
        (local.set $counter (i32.add (local.get $counter) (i32.const 1)))
        (local.set $chunk
          (select (local.get $length) (i32.const 64)
            (i32.lt_u (local.get $length) (i32.const 64))))
        (local.set $index (i32.const 0))
        (loop $bytes
          (i32.store8 (i32.add (local.get $output) (local.get $index))
            (i32.xor
              (i32.load8_u (i32.add (local.get $input) (local.get $index)))
              (i32.load8_u (i32.add (local.get $scratch) (local.get $index)))))
          (local.set $index (i32.add (local.get $index) (i32.const 1)))
          (br_if $bytes (i32.lt_u (local.get $index) (local.get $chunk))))
        (local.set $input (i32.add (local.get $input) (local.get $chunk)))
        (local.set $output (i32.add (local.get $output) (local.get $chunk)))
        (local.set $length (i32.sub (local.get $length) (local.get $chunk)))
        (br $blocks))))

  ;; Returns 1 when the $length bytes at $left and $right are equal.
  (func $memeq (param $left i32) (param $right i32) (param $length i32) (result i32)
    (block $differ
      (loop $next
        (if (i32.eqz (local.get $length)) (then (return (i32.const 1))))
        (br_if $differ
          (i32.ne (i32.load8_u (local.get $left)) (i32.load8_u (local.get $right))))
        (local.set $left (i32.add (local.get $left) (i32.const 1)))
        (local.set $right (i32.add (local.get $right) (i32.const 1)))
        (local.set $length (i32.sub (local.get $length) (i32.const 1)))
        (br $next)))
    (i32.const 0))

  ;; Reproduces the RFC 8439 vectors. Returns 0 on success, otherwise one bit
  ;; per failing check: 1 for the §2.3.2 keystream block, 2 for the §2.4.2
  ;; encryption, and 4 for decrypting that ciphertext back to the plaintext.
  (func $selftest (export "selftest") (result i32)
    (local $failures i32)
    (call $block (global.get $key) (i32.const 1) (global.get $block_nonce) (global.get $output))
    (if (i32.eqz (call $memeq (global.get $output) (global.get $expected_block) (i32.const 64)))
      (then (local.set $failures (i32.or (local.get $failures) (i32.const 1)))))

    (call $xor (global.get $key) (i32.const 1) (global.get $stream_nonce)
      (global.get $plaintext) (i32.const 114) (global.get $output) (global.get $keystream))
    (if (i32.eqz (call $memeq (global.get $output) (global.get $ciphertext) (i32.const 114)))
      (then (local.set $failures (i32.or (local.get $failures) (i32.const 2)))))

    (call $xor (global.get $key) (i32.const 1) (global.get $stream_nonce)
      (global.get $ciphertext) (i32.const 114) (global.get $output) (global.get $keystream))
    (if (i32.eqz (call $memeq (global.get $output) (global.get $plaintext) (i32.const 114)))
      (then (local.set $failures (i32.or (local.get $failures) (i32.const 4)))))

    (local.get $failures)))
