;; kernel.sls -- the C kernel's primitives, for Scheme
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The kernel (kernel/kernel.c) registers each primitive with Sforeign_symbol
;; after the boot files load, so every foreign procedure here is resolved on
;; its first call. Outside the kernel (a plain Chez Scheme loading these
;; libraries) they are simply unavailable.
(library (quad kernel)
  (export kernel-available?
          kernel-isatty kernel-tty-raw kernel-tty-restore kernel-tty-size
          kernel-read kernel-write kernel-take-winch kernel-suspend
          kernel-poll kernel-unix-listen kernel-unix-connect kernel-accept kernel-close
          quad-self-path)
  (import (chezscheme))

  (define-syntax define-kernel
    (syntax-rules ()
      [(_ name cname (arg ...) ret)
       (define name
         (let ([proc #f])
           (lambda args
             (unless proc (set! proc (foreign-procedure cname (arg ...) ret)))
             (apply proc args))))]))

  ;; Whether this process is a quad kernel, with the primitives registered.
  (define (kernel-available?) (foreign-entry? "quad_self_path"))

  ;; The terminal (kernel.c).
  (define-kernel kernel-isatty "quad_isatty" (int) int)
  (define-kernel kernel-tty-raw "quad_tty_raw" (int) int)
  (define-kernel kernel-tty-restore "quad_tty_restore" (int) int)
  (define-kernel kernel-tty-size "quad_tty_size" (int) int)
  (define-kernel kernel-read "quad_read" (int u8* int int) int)
  (define-kernel kernel-write "quad_write" (int u8* int) int)
  (define-kernel kernel-take-winch "quad_take_winch" () int)
  (define-kernel kernel-suspend "quad_suspend" () void)
  (define-kernel quad-self-path "quad_self_path" () string)

  ;; Connections (kernel.c).
  (define-kernel k-poll "quad_poll" (u8* int int u8*) int)
  (define-kernel kernel-unix-listen "quad_unix_listen" (string) int)
  (define-kernel kernel-unix-connect "quad_unix_connect" (string) int)
  (define-kernel kernel-accept "quad_accept" (int) int)
  (define-kernel kernel-close "quad_close" (int) int)

  ;; Wait up to timeout-ms (-1: forever) for any of `fds` to be readable;
  ;; returns those that are (or have hung up), '() on timeout.
  (define (kernel-poll fds timeout-ms)
    (let* ([n (length fds)]
           [in (make-bytevector (* 4 (max n 1)) 0)]
           [ready (make-bytevector (* 4 (max n 1)) 0)])
      (let loop ([l fds] [i 0])
        (unless (null? l)
          (bytevector-s32-native-set! in (* 4 i) (car l))
          (loop (cdr l) (+ i 1))))
      (let ([r (k-poll in n timeout-ms ready)])
        (if (<= r 0)
            '()
            (let loop ([l fds] [i 0] [acc '()])
              (if (null? l)
                  (reverse acc)
                  (loop (cdr l) (+ i 1)
                        (if (= 1 (bytevector-s32-native-ref ready (* 4 i))) (cons (car l) acc) acc)))))))))
