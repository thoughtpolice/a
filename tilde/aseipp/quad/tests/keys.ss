;; keys.ss -- decoding terminal input, and how layers take keys
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(define (bytes s) (bytevector->u8-list (string->utf8 s)))
(define (decode s)
  (let-values ([(evs rest) (decode-input (bytes s) #t)])
    (map (lambda (e)
           (cond [(key-event? e) (string-append (key-event->spec e) (if (eq? (key-event-kind e) 'release) "↑" ""))]
                 [(paste-event? e) (list 'paste (paste-event-text e))]
                 [(mouse-event? e) (list (mouse-event-kind e) (mouse-event-button e) (mouse-event-col e) (mouse-event-row e))]
                 [(clipboard-event? e) (list 'clipboard (clipboard-event-target e) (clipboard-event-text e))]
                 [(focus-event? e) (if (focus-event-in? e) 'focus-in 'focus-out)]
                 [else e]))
         evs)))

;; Legacy encodings.
(expect-equal "plain" (decode "aB;") '("a" "B" ";"))
(expect-equal "space" (decode " ") '("space"))
(expect-equal "controls" (decode "\x1;\x1a;\r\t\x7f;") '("ctrl+a" "ctrl+z" "enter" "tab" "backspace"))
(expect-equal "alt" (decode "\x1b;k\x1b;;") '("alt+k" "alt+;"))
(expect-equal "escape alone" (decode "\x1b;") '("esc"))
(expect-equal "arrows" (decode "\x1b;[A\x1b;[1;5C\x1b;OD") '("up" "ctrl+right" "left"))
(expect-equal "tilde keys" (decode "\x1b;[3~\x1b;[5;3~") '("delete" "alt+pageup"))
(expect-equal "backtab" (decode "\x1b;[Z") '("shift+tab"))
(expect-equal "utf-8" (decode "λé") '("λ" "é"))
(expect-equal "bracketed paste" (decode "\x1b;[200~hi\x1b;there\x1b;[201~x") '((paste "hi\x1b;there") "x"))

;; The kitty keyboard protocol: CSI codepoint:shifted ; mods:event ; text u
(expect-equal "kitty plain" (decode "\x1b;[97;;97u") '("a"))
(expect-equal "kitty shift" (decode "\x1b;[97:65;2;65u") '("A"))
(expect-equal "kitty shifted symbol" (decode "\x1b;[59:58;2;58u") '(":"))
(expect-equal "kitty alt" (decode "\x1b;[107;3u") '("alt+k"))
(expect-equal "kitty ctrl" (decode "\x1b;[122;5u") '("ctrl+z"))
(expect-equal "kitty release" (decode "\x1b;[114;1:3u") '("r↑"))
(expect-equal "kitty specials" (decode "\x1b;[13u\x1b;[27u\x1b;[127;3u\x1b;[13;2u") '("enter" "esc" "alt+backspace" "shift+enter"))
(expect-equal "kitty modifiers alone are dropped" (decode "\x1b;[57441;2u\x1b;[57441;1:3u") '())
(expect-equal "kitty arrows with events" (decode "\x1b;[1;1:3A") '("up↑"))
(expect-equal "kitty space" (decode "\x1b;[32;;32u") '("space"))

;; Mouse, focus and clipboard replies.
(expect-equal "sgr mouse" (decode "\x1b;[<0;10;5M\x1b;[<0;12;5m\x1b;[<64;1;1M\x1b;[<32;3;4M\x1b;[<35;7;2M")
              '((press 0 9 4) (release 0 11 4) (scroll-up 0 0 0) (drag 0 2 3) (move 0 6 1)))
(expect-equal "focus" (decode "\x1b;[I\x1b;[O") '(focus-in focus-out))
(expect-equal "osc 52 reply" (decode "\x1b;]52;c;aGVsbG8=\x1b;\\") '((clipboard "c" "hello")))
(expect-equal "osc 52 reply with bel" (decode "\x1b;]52;p;eA==\a") '((clipboard "p" "x")))

;; An incomplete sequence waits for the rest.
(let-values ([(evs rest) (decode-input (bytes "a\x1b;[1;5") #f)])
  (expect-equal "partial" (length evs) 1)
  (expect-equal "partial rest" (length rest) 5))

;; Momentary layers, kitty style: hold r and press l to delete rightwards,
;; repeatedly while held; tap r alone to delete one.
(headless-start! 24 80 #f #t)
(define (ev name kind) (make-key-event name 0 #f kind))
(headless-buffer! "a b c d e" 'text)
(press! "s" (ev "r" 'press) (ev "l" 'press) (ev "l" 'release) (ev "l" 'press) (ev "l" 'release) (ev "r" 'release))
(expect-equal "held layer repeats" (buffer-contents) "c d e")
(press! (ev "r" 'press) (ev "r" 'release))
(expect-equal "tap" (buffer-contents) "d e")
;; Held long enough, the layer shows its keys.
(press! (ev "r" 'press))
(set-var! 'legend-delay 0)
(redraw!)
(check "legend shows" (exists (lambda (row) (string-contains row "Delete >>")) (screen)))
(press! (ev "r" 'release))
(check "legend hides" (not (exists (lambda (row) (string-contains row "Delete >>")) (screen))))
;; Menus (space) stay open until a key is chosen, release or not.
(press! (ev "space" 'press) (ev "space" 'release))
(check "menu open" (active-layer))
(press! "esc")
(check "menu closed" (not (active-layer)))
