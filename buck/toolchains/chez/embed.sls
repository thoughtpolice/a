;; embed.sls -- standalone executables: a kernel with boot files appended
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A standalone Chez Scheme program is a kernel (a C program linking Chez
;; Scheme's kernel, which calls chez_embed_register from embed.c) with its
;; boot files appended:
;;
;;   [kernel][boot 0]...[boot n-1][index][count u64][magic "CHEZBOOT"]
;;
;; with an index entry of (offset u64, length u64, name 16 bytes) per boot,
;; all little-endian. The boot files register in order, petite.boot first.
;; The build (pack.ss, chez.standalone) writes these, and so can a program at
;; run time, to make new executables from itself.
(library (chez embed)
  (export pack-executable read-boot-index executable-kernel-length
          extract-boot)
  (import (chezscheme))

  (define magic (string->utf8 "CHEZBOOT"))
  (define entry-len 32)

  (define (u64->bytes n)
    (let ([bv (make-bytevector 8 0)])
      (bytevector-u64-set! bv 0 n (endianness little))
      bv))

  (define (read-file path)
    (call-with-port (open-file-input-port path)
      (lambda (p)
        (let ([bv (get-bytevector-all p)])
          (if (eof-object? bv) (make-bytevector 0) bv)))))

  (define (read-region path off len)
    (call-with-port (open-file-input-port path)
      (lambda (p)
        (set-port-position! p off)
        (get-bytevector-n p len))))

  ;; The boot files appended to `path`, as a list of (name offset length),
  ;; or '() if it has none.
  (define (read-boot-index path)
    (let* ([size (call-with-port (open-file-input-port path) port-length)])
      (if (< size 16)
          '()
          (let ([tail (read-region path (- size 16) 16)])
            (if (not (bytevector=? (let ([m (make-bytevector 8)])
                                     (bytevector-copy! tail 8 m 0 8) m)
                                   magic))
                '()
                (let* ([count (bytevector-u64-ref tail 0 (endianness little))]
                       [index (read-region path (- size 16 (* count entry-len))
                                           (* count entry-len))])
                  (let loop ([i 0] [acc '()])
                    (if (= i count)
                        (reverse acc)
                        (let* ([base (* i entry-len)]
                               [name-bv (make-bytevector 16)])
                          (bytevector-copy! index (+ base 16) name-bv 0 16)
                          (loop (+ i 1)
                                (cons (list (let ([s (utf8->string name-bv)])
                                              (let trim ([n (string-length s)])
                                                (if (and (> n 0) (char=? (string-ref s (- n 1)) #\nul))
                                                    (trim (- n 1))
                                                    (substring s 0 n))))
                                            (bytevector-u64-ref index base (endianness little))
                                            (bytevector-u64-ref index (+ base 8) (endianness little)))
                                      acc)))))))))))

  ;; The length of the kernel image at the front of `path`.
  (define (executable-kernel-length path)
    (let ([index (read-boot-index path)])
      (if (null? index)
          (call-with-port (open-file-input-port path) port-length)
          (cadr (car index)))))

  ;; The bytes of the boot file named `name` appended to `path`.
  (define (extract-boot path name)
    (let ([e (assoc name (read-boot-index path))])
      (and e (read-region path (cadr e) (caddr e)))))

  ;; Write `out`: the first `kernel-len` bytes of `kernel` (all of it if #f),
  ;; then each boot in `boots`, a list of (name . bytevector-or-path).
  (define (pack-executable out kernel kernel-len boots)
    (let* ([kbytes (read-file kernel)]
           [klen (or kernel-len (bytevector-length kbytes))]
           [datas (map (lambda (b)
                         (if (bytevector? (cdr b)) (cdr b) (read-file (cdr b))))
                       boots)])
      (when (file-exists? out) (delete-file out))
      (call-with-port (open-file-output-port out)
        (lambda (p)
          (put-bytevector p kbytes 0 klen)
          (let loop ([ds datas] [off klen] [entries '()])
            (if (null? ds)
                (begin
                  (for-each
                   (lambda (e name)
                     (let ([nb (make-bytevector 16 0)]
                           [s (string->utf8 name)])
                       (when (> (bytevector-length s) 16)
                         (errorf 'pack-executable "boot name too long: ~a" name))
                       (bytevector-copy! s 0 nb 0 (bytevector-length s))
                       (put-bytevector p (u64->bytes (car e)))
                       (put-bytevector p (u64->bytes (cdr e)))
                       (put-bytevector p nb)))
                   (reverse entries) (map car boots))
                  (put-bytevector p (u64->bytes (length boots)))
                  (put-bytevector p magic))
                (begin
                  (put-bytevector p (car ds))
                  (loop (cdr ds) (+ off (bytevector-length (car ds)))
                        (cons (cons off (bytevector-length (car ds))) entries)))))))
      (chmod out #o755))))
