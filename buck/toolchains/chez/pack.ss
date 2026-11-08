;; pack.ss -- append boot files to a kernel, making a standalone program
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;;   scheme -q --libdirs DIR --script pack.ss OUT KERNEL NAME=BOOT ...
;;
;; where DIR holds chez/embed.sls
;;
;; with the boot files in load order, petite first.
(import (chezscheme) (chez embed))

(reset-handler (lambda () (exit 1)))

(let ([args (command-line-arguments)])
  (when (< (length args) 3)
    (errorf 'pack "usage: pack.ss OUT KERNEL NAME=BOOT ..."))
  (pack-executable
   (car args) (cadr args) #f
   (map (lambda (spec)
          (let loop ([i 0])
            (cond
             [(= i (string-length spec)) (errorf 'pack "expected NAME=BOOT, not ~a" spec)]
             [(char=? (string-ref spec i) #\=)
              (cons (substring spec 0 i) (substring spec (+ i 1) (string-length spec)))]
             [else (loop (+ i 1))])))
        (cddr args))))
