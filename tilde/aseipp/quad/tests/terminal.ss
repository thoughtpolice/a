;; terminal.ss -- what the screen shows, and the mouse
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(headless-start! 12 60)
(headless-buffer! "(define (square x)\n  (* x x))\n" 'scheme)

;; The gutter numbers lines; the status line shows the mode and position.
(check "gutter" (string-prefix? "   1 (define" (screen-row 1)))
(check "status mode" (string-contains (screen-row 10) "NOR"))
(check "status selection mode" (string-contains (screen-row 10) "CHAR"))
(check "status position" (string-contains (screen-row 10) "1:1"))
(check "bufferline lists buffers" (string-contains (screen-row 0) "test"))
(press! "a")
(check "status follows selection mode" (string-contains (screen-row 10) "LINE"))
(press! "h")
(check "insert mode" (string-contains (screen-row 10) "INS"))
(press! "esc")

;; Menus draw a legend with their keys.
(press! "space")
(check "space legend" (exists (lambda (r) (string-contains r "Command")) (screen)))
(check "legend border" (exists (lambda (r) (string-contains r "╭")) (screen)))
(press! "esc")

;; Pickers float in the middle, filtering as you type.
(press! "space" "k" "f")
(check "picker" (exists (lambda (r) (string-contains r "Buffers")) (screen)))
(type! "mess")
(check "picker filters" (exists (lambda (r) (string-contains r "*Messages*")) (screen)))
(check "picker count" (exists (lambda (r) (string-contains r "1/1")) (screen)))
(press! "esc")
(check "picker closed" (not (current-prompt)))

;; The command palette runs commands by name.
(press! "space" "space")
(type! "select-word")
(press! "enter")
(expect-equal "palette ran the command" (view-selection-mode (current-view)) 'word)

;; The mouse: click selects the unit under the pointer, in screen cells.
;; Row 1 is the first text line (row 0 holds the buffer tabs); the text
;; starts after the five-column gutter.
(define (mouse kind button col row) (make-mouse-event kind button col row 0))
(press! (mouse 'press 0 14 1) (mouse 'release 0 14 1))
(expect-equal "click selects a word" (primary-text) "square")
;; Drag extends.
(press! (mouse 'press 0 6 1) (mouse 'drag 0 15 1) (mouse 'release 0 15 1))
(expect-equal "drag" (primary-text) "define (square")
(expect-equal "drag sets the primary selection" (primary-selection) "define (square")
;; Double-click: a word; triple-click: a line.
(press! (mouse 'press 0 10 2) (mouse 'release 0 10 2) (mouse 'press 0 10 2))
(expect-equal "double click" (primary-text) "x")
(press! (mouse 'release 0 10 2) (mouse 'press 0 10 2) (mouse 'release 0 10 2))
(expect-equal "triple click" (primary-text) "(* x x))")
;; Alt-click adds a cursor.
(press! "s" (make-mouse-event 'press 0 6 1 mod-alt))
(expect-equal "alt click" (length (view-sels (current-view))) 2)
(press! "esc")
;; The wheel scrolls without moving the selection.
(headless-buffer! (apply string-append (map (lambda (i) (format "line ~a\n" i)) (iota 100))) 'text)
(press! (mouse 'scroll-down 0 0 1) (mouse 'scroll-down 0 0 1))
(expect-equal "wheel" (view-top (current-view)) 6)
(check "wheel keeps selection" (= 0 (sel-start (car (view-sels (current-view))))))
(press! "l")
(expect-equal "moving brings the view back" (view-top (current-view)) 0)

;; Copying hands the text to the client's system clipboard.
(press! "s" "c" "c")
(expect-equal "system clipboard" (car (client-received (current-client))) '("clipboard-set" "c" "line"))

;; Wide characters take two cells.
(headless-buffer! "日本語 text" 'text)
(check "wide" (string-contains (screen-row 1) "日本語 text"))
