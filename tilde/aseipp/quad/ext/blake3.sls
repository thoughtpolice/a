;; blake3.sls -- hashing selections with BLAKE3, in the kernel's Rust half
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; An extension built on a Rust component: blake3 is a procedure of the
;; kernel's Rust half (kernel/lib.rs), from the library the build generates
;; from it, (quad native).
(library (quad ext blake3)
  (export blake3-hex)
  (import (chezscheme) (quad util) (quad native) (quad buffer) (quad editor)
          (quad commands))

  ;; The BLAKE3 hash of a string or bytevector, in lowercase hex.
  (define (blake3-hex data)
    (bytevector->hex (blake3 (if (string? data) (string->utf8 data) data))))

  (at-load
   (define-command 'hash-selection "Copy the BLAKE3 hash of the selections"
     (lambda ()
       (let ([hashes (map blake3-hex (sels-texts (current-buffer)))])
         (clipboard-push! hashes)
         (message "BLAKE3 ~a" (string-join hashes " ")))))
   (define-key (keymap-lookup-target space-keymap "l") "h" 'hash-selection "BLAKE3 Hash")))
