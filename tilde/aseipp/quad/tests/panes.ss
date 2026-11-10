;; panes.ss -- panes: splitting a client's screen, focus, and their views
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 20 81)
(define c (current-client))
(define a (headless-buffer! "alpha one\nalpha two\n" 'text))

;; ctrl+w v: another pane beside this one, showing the same, focused.
(press! "ctrl+w" "v")
(expect-equal "two panes" (length (client-panes c)) 2)
(redraw!)
(define (row n) (list-ref (screen) n))
(check "a line between them" (char=? (string-ref (row 2) 40) #\x2502))
;; (Row 0 is the buffer line: there are several buffers.)
(check "both show the buffer" (and (string-contains (substring (row 1) 0 40) "alpha one")
                                   (string-contains (substring (row 1) 41 81) "alpha one")))
(press! "h")                            ; Ki: insert before
(redraw!)
(check "the cursor is the right pane's" (>= (cadr (screen-cursor)) 41))
(press! "esc")

;; Each pane has views of its own: another buffer in this one leaves that.
(define bee (new-buffer! "bee" "buzzing\n" fundamental-mode))
(switch-to-buffer! bee)
(redraw!)
(check "this pane shows the other buffer" (string-contains (substring (row 1) 41 81) "buzzing"))
(check "that pane still shows the first" (string-contains (substring (row 1) 0 40) "alpha one"))

;; ctrl+w j: the pane to the left.
(press! "ctrl+w" "j")
(expect-equal "focus moved left" (buffer-name (current-buffer)) (buffer-name a))
(press! "ctrl+w" "l")
(expect-equal "and back" (buffer-name (current-buffer)) "bee")

;; A click focuses the pane under the pointer.
(deliver! c (list "mouse" "press" 0 5 2 0))
(deliver! c (list "mouse" "release" 0 5 2 0))
(expect-equal "a click focuses its pane" (buffer-name (current-buffer)) (buffer-name a))

;; ctrl+w s: one under this one; three panes.
(press! "ctrl+w" "s")
(expect-equal "three panes" (length (client-panes c)) 3)
(redraw!)
(define (count-of s r)
  (let loop ([i 0] [n 0])
    (let ([j (string-contains (substring r i (string-length r)) s)])
      (if j (loop (+ i j 1) (+ n 1)) n))))
(check "each has a status line of its own" (= 3 (apply + (map (lambda (r) (count-of "NOR" r)) (screen)))))

;; A buffer killed while an unfocused pane shows it: that pane shows another.
(kill-buffer! bee)
(redraw!)
(check "no pane shows the killed buffer"
       (for-all (lambda (p) (not (eq? (view-buffer (pane-view-of c p)) bee))) (client-panes c)))

;; ctrl+w q closes a pane; ctrl+w o all but this one.
(press! "ctrl+w" "q")
(expect-equal "a pane closed" (length (client-panes c)) 2)
(press! "ctrl+w" "o")
(expect-equal "only this one" (length (client-panes c)) 1)
(press! "ctrl+w" "q")
(check "the only pane stays" (= 1 (length (client-panes c))))
(redraw!)
(check "drawn whole again" (not (char=? (string-ref (row 2) 40) #\x2502)))

;; A component in a pane: it draws itself, and takes the keys it wants;
;; the others reach the layers (ctrl+w), but no command edits behind it.
(define count 0)
(define counter
  (make-component 'counter
                  (lambda (canvas focused?)
                    (put-string! canvas 0 0 (format "count: ~a" count) (ui-face 'ui.text))
                    (and focused? (list 0 (+ 7 (string-length (number->string count))) 'bar)))
                  (lambda (key text) (and (string=? key "+") (begin (set! count (+ count 1)) #t)))))
(define before (buffer-contents))
(show-component! c counter 'right)
(press! "+" "+")
(redraw!)
(check "it draws itself" (exists (lambda (r) (string-contains r "count: 2")) (screen)))
(check "with its cursor" (>= (cadr (screen-cursor)) 41))
(press! "r" "r")
(expect-equal "keys it does not take edit nothing" (buffer-contents) before)
(press! "ctrl+w" "q")
(expect-equal "ctrl+w q closes it" (length (client-panes c)) 1)
(check "the view is focused again" (not (focused-component c)))
