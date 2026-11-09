;; markdown.sls -- Markdown: headings, code and links
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(library (quad ext markdown)
  (export markdown-syntax markdown-mode)
  (import (chezscheme) (quad util) (quad text) (quad syntax) (quad buffer)
          (quad editor) (quad commands) (quad link))

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

  ;; Inline links and images, [text](target "title") and ![alt](target):
  ;; the text and the target lead to the target (see link.sls).
  (define (markdown-links line)
    (let ([n (string-length line)])
      (let loop ([i 0] [acc '()])
        (let* ([a (string-index line #\[ i)]
               [b (and a (string-index line #\] (+ a 1)))]
               [c (and b (< (+ b 1) n) (char=? (string-ref line (+ b 1)) #\() (string-index line #\) (+ b 2)))])
          (cond
           [(not a) (reverse acc)]
           [(not c) (loop (+ a 1) acc)]
           [else
            ;; The target as written runs from ts to te, before any title.
            (let* ([ts (or (string-index line (lambda (ch) (not (char-whitespace? ch))) (+ b 2)) c)]
                   [te (min c (or (string-index line char-whitespace? ts) c))]
                   [written (substring line ts te)]
                   [target (if (and (string-prefix? "<" written) (string-suffix? ">" written))
                               (substring written 1 (- (string-length written) 1))
                               written)])
              (loop (+ c 1)
                    (if (string=? target "")
                        acc
                        (append (list (list ts te target 'ui.link))
                                (if (< (+ a 1) b) (list (list (+ a 1) b target 'markup.link)) '())
                                acc))))])))))

  (at-load
   (major-mode-hook-set! markdown-mode
                         (lambda (b)
                           (set-local! 'indent-unit "  " b)))
   (add-auto-mode! '("md" "markdown" "txt") 'markdown)
   (define-link-finder! 'markdown markdown-links)))
