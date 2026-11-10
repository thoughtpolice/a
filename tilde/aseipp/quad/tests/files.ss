;; files.ss -- a project's files, and searching them as you type
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(define dir (test-temp-dir "files"))
(write-file! (path-join dir "a.txt") "one\ntwo needle here\n")
(write-file! (path-join dir "sub/b.txt") "Needle\nneedle again\n")
(write-file! (path-join dir "build.log") "needle\n")
(write-file! (path-join dir ".gitignore") "*.log\n")
(write-file! (path-join dir ".jj/repo/store") "needle\n")

;; The files are those the ignore files leave, and never jj's own.
(expect-equal "project files" (project-files dir 100) '(".gitignore" "a.txt" "sub/b.txt"))

(headless-start! 16 70)

;; space k g: the lines that match, as they are found; smart case, so
;; "needle" is any case.
(grep-picker! dir)
(type! "needle")
(run-until "the search's hits" (lambda () (= 3 (length (prompt-items (current-prompt))))))
(expect-equal "what grep found"
              (sort string<? (map caar (prompt-items (current-prompt))))
              '("a.txt:2: two needle here" "sub/b.txt:1: Needle" "sub/b.txt:2: needle again"))
(check "on screen" (on-screen? "a.txt:2: two needle here"))

;; A capital asks for that case; a pattern as it is typed may not be one yet.
(type! "[")
(check "not a pattern yet" (on-screen? "Not a pattern yet"))
(press! "backspace")
(press! "home")
(press! "delete")
(type! "N")
(run-until "a search with case" (lambda () (= 1 (length (prompt-items (current-prompt))))))
(press! "enter")
(expect-equal "enter opens the file" (buffer-name (current-buffer)) "b.txt")
(expect-equal "at the match" (sel-start (car (view-sels (current-view)))) 0)

;; A regular expression; enter goes to the line and column.
(grep-picker! dir)
(type! "ag[a-z]+n")
(run-until "a regex's hit" (lambda () (= 1 (length (prompt-items (current-prompt))))))
(press! "enter")
(expect-equal "line and column" (sel-start (car (view-sels (current-view)))) (+ 7 7))

;; Nothing found says so.
(grep-picker! dir)
(type! "absent")
(run-until "no match" (lambda () (on-screen? "No match")))
(press! "esc")
