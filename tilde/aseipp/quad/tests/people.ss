;; people.ss -- working together: people, their colors and names, following, chat
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 16 70)
(define a (current-client))
(define b (headless-client! 16 70))
(set-client-user! a "alice")
(set-client-user! b "bob")
(define buf (headless-buffer! "one two three\nfour five six\nseven eight\n" 'text))
(with-client b (lambda () (switch-to-buffer! buf)))
(redraw!)
(define (message-of c) (with-client c (lambda () (let ([m (current-message)]) (and m (cdr m))))))

;; Each has a name and a color of their own; each hears the other come.
(check "two colors" (not (= (client-color a) (client-color b))))
(expect-equal "alice heard bob come" (message-of a) "bob joined")
(check "both are people" (equal? (map client-user (people)) '("alice" "bob")))

;; Each sees the other: a name by their cursor's line, and who is here.
(check "alice sees bob" (= (screen-row-of a "◂ bob") 1))
(check "bob sees alice" (= (screen-row-of b "◂ alice") 1))
(check "with bob" (screen-row-of a "with bob"))
(use-client! b)
(press! "k")
(check "bob's name moves with him" (= (screen-row-of a "◂ bob") 2))

;; Following: alice keeps to bob's view, whatever he does, until a key.
(use-client! a)
(press! "space" "j" "l")
(check "the people" (and (current-prompt) (screen-row-of a "alice (you)") (screen-row-of a "bob  test:2")))
(type! "bob")
(press! "enter")
(check "following" (and (string-contains (list-ref (screen-of a) 14) "following bob")
                         (string-contains (list-ref (screen-of b) 14) "followed by alice")))
(define other (with-client b (lambda () (let ([o (new-buffer! "notes" "a\nb\nc\nd\n" fundamental-mode)])
                                          (switch-to-buffer! o) o))))
(use-client! b)
(press! "k" "k")
(redraw!)
(check "to his buffer" (eq? (with-client a current-buffer) other))
(check "to his place" (= (sel-start (with-client a (lambda () (view-primary (current-view)))))
                         (sel-start (with-client b (lambda () (view-primary (current-view)))))))
(use-client! a)
(press! "j")
(check "a key takes over" (and (not (string-contains (list-ref (screen-of a) 14) "following bob"))
                               (equal? (message-of a) "Stopped following bob")))

;; Saying something: everyone hears it, and it is in *chat*.
(press! "space" "j" "t")
(type! "hello there")
(press! "enter")
(expect-equal "bob heard" (message-of b) "alice: hello there")
(check "in the chat" (member "alice: hello there" (chat-lines)))
(press! "space" "j" "h")
(check "the chat buffer" (and (equal? (buffer-name (current-buffer)) "*chat*")
                              (string-contains (buffer-contents) "bob joined\nalice: hello there\n")))
(with-client b (lambda () (say! "bye")))
(check "the chat buffer keeps up" (string-contains (buffer-contents) "bob: bye\n"))

;; Leaving.
(use-client! b)
(press! "space" "j" "v")
(expect-equal "alice heard bob go" (message-of a) "bob left")
(check "one person" (equal? (map client-user (people)) '("alice")))
