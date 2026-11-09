;; kernel.sls -- the C kernel's primitives, for Scheme
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; The kernel (kernel/kernel.c) registers each primitive with Sforeign_symbol
;; after the boot files load, so every foreign procedure here is resolved on
;; its first call. Outside the kernel (a plain Chez Scheme loading these
;; libraries) they are simply unavailable. The Rust half's procedures are
;; (quad native), generated from kernel/lib.rs.
(library (quad kernel)
  (export kernel-isatty kernel-tty-raw kernel-tty-restore kernel-tty-size kernel-tty-pixels
          kernel-read-some kernel-write kernel-take-winch kernel-suspend
          kernel-poll kernel-unix-listen kernel-unix-connect kernel-accept kernel-close
          kernel-fork-detached
          quad-self-path kernel-hostname kernel-launched-as-app)
  (import (chezscheme))

  (define-syntax define-kernel
    (syntax-rules ()
      [(_ name cname (arg ...) ret)
       (define name
         (let ([proc #f])
           (lambda args
             (unless proc (set! proc (foreign-procedure cname (arg ...) ret)))
             (apply proc args))))]))


  ;; The terminal (kernel.c).
  (define-kernel kernel-isatty "quad_isatty" (int) int)
  (define-kernel kernel-tty-raw "quad_tty_raw" (int) int)
  (define-kernel kernel-tty-restore "quad_tty_restore" (int) int)
  (define-kernel kernel-tty-size "quad_tty_size" (int) int)
  (define-kernel kernel-tty-pixels "quad_tty_pixels" (int) int)
  (define-kernel kernel-read "quad_read" (int u8* int int) int)
  (define-kernel kernel-write "quad_write" (int u8* int) int)
  (define-kernel kernel-take-winch "quad_take_winch" () int)
  (define-kernel kernel-suspend "quad_suspend" () void)
  (define-kernel quad-self-path "quad_self_path" () string)
  (define-kernel kernel-hostname "quad_hostname" () string)
  ;; 1 if macOS started this quad as an app (from Finder, the Dock or open),
  ;; which has no terminal, else 0.
  (define-kernel kernel-launched-as-app "quad_launched_as_app" () int)

  ;; What is readable on fd within timeout-ms (-1: however long it takes),
  ;; as a bytevector: empty when nothing came in time, or a signal came
  ;; first; #f at the end of input, or on an error.
  (define read-scratch (make-bytevector 65536))
  (define (kernel-read-some fd timeout-ms)
    (let ([n (kernel-read fd read-scratch (bytevector-length read-scratch) timeout-ms)])
      (cond
       [(= n -1) #f]
       [(<= n 0) (make-bytevector 0)]
       [else (let ([b (make-bytevector n)]) (bytevector-copy! read-scratch 0 b 0 n) b)])))

  ;; Connections (kernel.c).
  (define-kernel k-poll "quad_poll" (u8* int int u8*) int)
  (define-kernel kernel-unix-listen "quad_unix_listen" (string) int)
  (define-kernel kernel-unix-connect "quad_unix_connect" (string) int)
  (define-kernel kernel-accept "quad_accept" (int) int)
  (define-kernel kernel-close "quad_close" (int) int)
  (define-kernel k-fork-detached "quad_fork_detached" (u8*) int)

  ;; Fork a process that goes on without the terminal (kernel.c): in the
  ;; parent, the child's pid and the read end of a pipe from it; in the
  ;; child, 0 and the write end; #f and #f if it could not.
  (define (kernel-fork-detached)
    (let* ([fd (make-bytevector 4 0)] [pid (k-fork-detached fd)])
      (if (< pid 0)
          (values #f #f)
          (values pid (bytevector-s32-native-ref fd 0)))))

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
