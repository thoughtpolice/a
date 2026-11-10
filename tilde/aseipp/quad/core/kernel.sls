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
          kernel-read-some kernel-write kernel-take-winch kernel-stop-requested? kernel-suspend
          kernel-poll kernel-unix-listen kernel-unix-connect kernel-accept kernel-close
          kernel-private-dir? kernel-same-file? kernel-poll-rw kernel-write-some
          kernel-lock kernel-file-key
          kernel-fork-detached
          quad-self-path kernel-hostname kernel-launched-as-app)
  (import (chezscheme))

  (define-syntax define-kernel
    (lambda (x)
      (syntax-case x ()
        [(_ name cname (arg ...) ret)
         (with-syntax ([(t ...) (generate-temporaries #'(arg ...))])
           #'(define name
               (let ([proc #f])
                 (lambda (t ...)
                   (unless proc (set! proc (foreign-procedure cname (arg ...) ret)))
                   (proc t ...)))))])))


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
  ;; Whether the process is asked to stop (SIGTERM, SIGHUP): waits
  ;; (kernel-poll, kernel-read-some) are cut short when it is.
  (define-kernel k-stop-requested "quad_stop_requested" () int)
  (define (kernel-stop-requested?) (= 1 (k-stop-requested)))
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
  (define-kernel k-poll-rw "quad_poll_rw" (u8* u8* int int u8*) int)
  (define-kernel k-write-some "quad_write_some" (int u8* int int) int)

  ;; Write what of bv, from start, socket fd takes now, without waiting:
  ;; the count written, 0 if none now, -1 on error.
  (define (kernel-write-some fd bv start)
    (k-write-some fd bv start (- (bytevector-length bv) start)))
  (define-kernel kernel-unix-listen "quad_unix_listen" (string) int)
  (define-kernel kernel-unix-connect "quad_unix_connect" (string) int)
  (define-kernel kernel-accept "quad_accept" (int) int)
  (define-kernel kernel-close "quad_close" (int) int)
  (define-kernel k-private-dir "quad_private_dir" (string) int)
  ;; Whether path is a directory of this user's alone (kernel.c).
  (define (kernel-private-dir? path) (= 1 (k-private-dir path)))
  (define-kernel k-same-file "quad_same_file" (string string) int)
  ;; Whether paths a and b name the same file, however spelled.
  (define (kernel-same-file? a b) (= 1 (k-same-file a b)))
  ;; Takes the lock at path, waiting for it: a descriptor to close to give
  ;; it back, or #f.
  (define-kernel k-lock "quad_lock" (string) int)
  (define (kernel-lock path) (let ([fd (k-lock path)]) (and (>= fd 0) fd)))
  ;; What file path is now, as a string to compare later; #f if none.
  (define-kernel k-file-key "quad_file_key" (string u8* int) int)
  (define (kernel-file-key path)
    (let* ([out (make-bytevector 64 0)] [n (k-file-key path out 64)])
      (and (>= n 0) (utf8->string (bytevector-truncate! out n)))))
  (define-kernel k-fork-detached "quad_fork_detached" (u8*) int)

  ;; Fork a process that goes on without the terminal (kernel.c): in the
  ;; parent, the child's pid and the read end of a pipe from it; in the
  ;; child, 0 and the write end; #f and #f if it could not.
  (define (kernel-fork-detached)
    (let* ([fd (make-bytevector 4 0)] [pid (k-fork-detached fd)])
      (if (< pid 0)
          (values #f #f)
          (values pid (bytevector-s32-native-ref fd 0)))))

  ;; Wait up to timeout-ms (-1: forever) for any of `fds` to be readable,
  ;; or any of `writes` to be writable: the two lists of those that are.
  (define (kernel-poll-rw fds writes timeout-ms)
    (let* ([all (append fds writes)]
           [n (length all)]
           [reads (length fds)]
           [in (make-bytevector (* 4 (max n 1)) 0)]
           [events (make-bytevector (* 4 (max n 1)) 0)]
           [ready (make-bytevector (* 4 (max n 1)) 0)])
      (let loop ([l all] [i 0])
        (unless (null? l)
          (bytevector-s32-native-set! in (* 4 i) (car l))
          (bytevector-s32-native-set! events (* 4 i) (if (< i reads) 1 2))
          (loop (cdr l) (+ i 1))))
      (let ([r (k-poll-rw in events n timeout-ms ready)])
        (if (<= r 0)
            (values '() '())
            (let loop ([l all] [i 0] [rs '()] [ws '()])
              (if (null? l)
                  (values (reverse rs) (reverse ws))
                  (let ([got (bytevector-s32-native-ref ready (* 4 i))])
                    (loop (cdr l) (+ i 1)
                          (if (= got 1) (cons (car l) rs) rs)
                          (if (= got 2) (cons (car l) ws) ws)))))))))

  ;; Wait up to timeout-ms (-1: forever) for any of `fds` to be readable;
  ;; returns those that are (or have hung up), '() on timeout or when a
  ;; signal came first.
  (define (kernel-poll fds timeout-ms)
    (let-values ([(reads writes) (kernel-poll-rw fds '() timeout-ms)])
      reads)))
