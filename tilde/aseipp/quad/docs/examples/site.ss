;; site.ss -- an example of code compiled into a custom quad
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Built with `quad --build-exe quad-custom docs/examples/site.ss` (the
;; :quad-custom target). This is ordinary init-file code: all of quad is in
;; scope. The same file works as ~/.config/quad/init.ss.

(define-variable greeting "hello from a custom quad"
  "What the custom editor says when it starts.")

;; A command, bound under the space menu's context layer: space l d.
(define-command 'insert-date "Insert today's date at every cursor"
  (lambda ()
    (let ([d (current-date)])
      (insert-at-cursors!
       (format "~4,'0d-~2,'0d-~2,'0d" (date-year d) (date-month d) (date-day d))))))

(define-key (keymap-lookup-target space-keymap "l") "d" 'insert-date "Insert Date")

(add-hook! 'buffer-created-hook
           (lambda (b)
             (when (string=? (buffer-name b) "*scratch*")
               (message "~a" (get-var 'greeting)))))
