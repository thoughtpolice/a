;; markdown.sls -- Markdown: headings and code
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(library (quad ext markdown)
  (export markdown-syntax markdown-mode)
  (import (chezscheme) (quad util) (quad text) (quad syntax) (quad buffer)
          (quad editor) (quad commands))

  (define markdown-syntax
    (make-syntax 'markdown #f '() '() '() default-word-char? (keyword-table) '()
                 (lambda (text s e state emit)
                   (let ([line (text-substring text s e)])
                     (cond
                      [(string-prefix? "```" line)
                       (emit s e 'markup.raw)
                       (if (= state 0) 1 0)]
                      [(= state 1) (emit s e 'markup.raw) 1]
                      [(string-prefix? "#" line) (emit s e 'markup.heading) 0]
                      [else
                       ;; `code`
                       (let loop ([i 0])
                         (let ([a (string-index line #\` i)])
                           (when a
                             (let ([b (string-index line #\` (+ a 1))])
                               (when b
                                 (emit (+ s a) (+ s b 1) 'markup.raw)
                                 (loop (+ b 1)))))))
                       0])))
                 #f "  "))

  (define markdown-mode (define-major-mode! 'markdown markdown-syntax))

  (at-load
   (major-mode-hook-set! markdown-mode
                         (lambda (b)
                           (set-local! 'indent-unit "  " b)))
   (add-auto-mode! '("md" "markdown" "txt") 'markdown)))
