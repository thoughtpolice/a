;; clients.ss -- several clients on one editor
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 12 60)
(define a (current-client))
(define b (headless-client! 10 40))
(define buf (headless-buffer! "one two three\nfour five six\n" 'text))
(with-client b (lambda () (switch-to-buffer! buf)))
(redraw!)

;; Each client draws its own screen, at its own size.
(check "a sees the buffer" (exists (lambda (r) (string-contains r "one two three")) (screen-of a)))
(check "b sees the buffer" (exists (lambda (r) (string-contains r "one two three")) (screen-of b)))
(expect-equal "a's size" (length (screen-of a)) 12)
(expect-equal "b's size" (length (screen-of b)) 10)
(expect-equal "b's width" (string-length (car (screen-of b))) 40)

;; Each has its own selections and modes.
(use-client! b)
(press! "a" "l")
(expect-equal "b moved" (primary-text) "four five six")
(use-client! a)
(press! "s" "p")
(expect-equal "a moved independently" (primary-text) "three")
(check "a's mode" (string-contains (list-ref (screen-of a) 10) "WORD"))
(check "b's mode" (string-contains (list-ref (screen-of b) 8) "LINE"))
;; Each sees the other is here.
(check "presence" (string-contains (list-ref (screen-of a) 10) "+1"))

;; An edit by one remaps the other's selections.
(press! "y" "g" "g")
(type! "ONE")
(press! "esc")
(expect-equal "a's edit" (buffer-contents) "ONE two three\nfour five six\n")
(use-client! b)
(expect-equal "b's selection followed the text" (primary-text) "four five six")
(press! "h")
(type! "> ")
(press! "esc")
(expect-equal "b's edit" (buffer-contents) "ONE two three\n> four five six\n")
(use-client! a)
(check "a sees b's edit" (exists (lambda (r) (string-contains r "> four five six")) (screen-of a)))
(expect-equal "a still on its word" (primary-text) "ONE")

;; Prompts and messages are per client.
(press! "space" "space")
(check "a has a prompt" (current-prompt))
(check "b does not" (with-client b (lambda () (not (current-prompt)))))
(check "b's screen has no picker" (not (exists (lambda (r) (string-contains r "Command")) (screen-of b))))
(press! "esc")

;; The clipboard history is shared: b pastes what a copied.
(press! "c" "c")
(use-client! b)
(press! "s" "v" "v")
(expect-equal "shared clipboard" (buffer-contents) "ONE two three\nONE four five six\n")
(expect-equal "only a's system clipboard was set"
              (filter (lambda (m) (equal? (car m) "clipboard-set")) (client-received b)) '())

;; Undo restores the selections of whoever undoes.
(press! "z" "z")
(expect-equal "undo" (buffer-contents) "ONE two three\n> four five six\n")

;; Buffers are shared, but which one each client shows is its own.
(use-client! a)
(define other (new-buffer! "other" "elsewhere" fundamental-mode))
(switch-to-buffer! other)
(redraw!)
(check "a shows other" (exists (lambda (r) (string-contains r "elsewhere")) (screen-of a)))
(check "b still shows buf" (not (exists (lambda (r) (string-contains r "elsewhere")) (screen-of b))))
(press! "e" "m")
(check "switching back keeps a's selection" (exists (lambda (r) (string-contains r "ONE")) (screen-of a)))
;; Killing a buffer moves every client off it.
(with-client b (lambda () (switch-to-buffer! other)))
(kill-buffer! other)
(check "b moved off the killed buffer" (not (eq? (with-client b current-buffer) other)))

;; Popups are per client too: shown over the view, at the right, with long
;; lines wrapped and the last lines showing. Escape hides one.
(use-client! a)
(define popup-lines
  (list (cons "first, which scrolls away" 'ui.popup)
        (cons (string-append "a long line that wraps " (make-string 30 #\x) " end") 'ui.popup.info)))
(define (more-lines n) (map (lambda (i) (cons (format "line ~a" i) 'ui.popup)) (iota n)))
(show-popup! (make-popup "Notes" (lambda () popup-lines) "esc hide"))
(redraw!)
(define (a-has? s) (exists (lambda (r) (string-contains r s)) (screen-of a)))
(check "a's popup" (and (a-has? "Notes") (a-has? "first, which") (a-has? "esc hide")))
(check "wrapped" (and (a-has? "a long line that wraps") (a-has? "xxx end")))
(check "b sees no popup" (not (exists (lambda (r) (string-contains r "Notes")) (screen-of b))))
(set! popup-lines (append popup-lines (more-lines 20)))
(redraw!)
(check "the last lines show" (and (a-has? "line 19") (not (a-has? "first, which"))))
(press! "esc")
(check "escape hides it" (and (not (current-popup)) (not (a-has? "Notes"))))

;; A dialog reads text in a centered window, the hint showing until there
;; is text, which wraps inside it; the cursor follows.
(define said #f)
(read-string-dialog "Suggest" "say something" (lambda (s) (set! said s)))
(redraw!)
(define (row-of s) (let loop ([rs (screen-of a)] [i 0])
                     (cond [(null? rs) #f] [(string-contains (car rs) s) i] [else (loop (cdr rs) (+ i 1))])))
(check "a dialog" (and (a-has? "Suggest") (a-has? "say something") (a-has? "⏎ send")))
(check "in the middle, not the bottom row" (< 0 (row-of "Suggest") 6))
(check "the title is centered" (let ([r (list-ref (screen-of a) (row-of "Suggest"))])
                                 (< 0 (string-contains r "╭") 10)))
(type! "the quick brown fox jumps over the lazy dog and then it runs away again")
(check "the hint goes" (not (a-has? "say something")))
(check "it wraps at a space" (and (a-has? "the quick brown fox jumps over the lazy dog and ")
                                  (= (row-of "then it runs away again") (+ 1 (row-of "the quick brown")))))
(expect-equal "the cursor follows" (screen-cursor)
              (let ([r (row-of "then it runs")])
                (list r (+ (string-contains (list-ref (screen-of a) r) "then it runs")
                           (string-length "then it runs away again"))
                      "bar")))
(press! "enter")
(expect-equal "accepted" said "the quick brown fox jumps over the lazy dog and then it runs away again")
(check "and gone" (not (a-has? "Suggest")))

;; A client quitting leaves the editor running for the others.
(use-client! b)
(press! "space" "j" "v")
(check "b is gone" (not (memq b (clients))))
(check "the editor runs on" (editor-running?))
(expect-equal "b was told" (car (client-received b)) '("bye" "detached"))
(use-client! a)
(press! "space" "j" "v")
(check "the last client quitting stops the editor" (not (editor-running?)))
