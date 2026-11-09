;; init.ss -- tests of the example init file (docs/examples/init.ss)
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; `quad --test` runs the .ss files in tests/ beside your init file
;; (~/.config/quad/tests/, for ~/.config/quad/init.ss), in an editor with
;; the init file loaded. Copy this there with the
;; example init file, or write your own: everything quad exports is in
;; scope, and so are the testing library's procedures (core/testing.sls):
;; headless-start!, press!, check, expect-equal, on-screen? and more.

;; A client with a screen of 12 rows by 60 columns, as tests drive one.
(headless-start! 12 60)

;; The variables it sets.
(expect-equal "line numbers are relative" (get-var 'line-numbers) 'relative)

;; ctrl+u shouts the selection.
(headless-buffer! "hello world" 'text)
(set-sels! (current-buffer) (list (make-sel 0 5)))
(press! "ctrl+u")
(expect-equal "ctrl+u upcases the selection" (buffer-contents) "HELLO world")

;; The status line counts the lines.
(redraw!)
(check "the status line counts lines" (on-screen? "1 lines"))

;; Saving strips trailing whitespace.
(let ([path (path-join (test-temp-dir "init") "notes.txt")])
  (write-file! path "a  \nb\t\n")
  (switch-to-buffer! (open-file! path))
  (run-command 'save-force)            ; save would skip a buffer unchanged
  (expect-equal "saving strips trailing whitespace" (read-file-string path) "a\nb\n"))
