;; jj.ss -- the jj extension: the gutter's marks, the status line, blame,
;; the jj menu, and a repository left as it was
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; $QUAD_JJ is the jj to run (BUILD gives third-party's), with a config of
;; the test's own, so that nothing of the user's is read.

(define jj (getenv "QUAD_JJ"))
(define dir (test-temp-dir "jj"))
(define repo (path-join dir "repo"))
(write-file! (path-join dir "config.toml") "[user]\nname = \"Tess Ter\"\nemail = \"tess@example.com\"\n")
(putenv "JJ_CONFIG" (path-join dir "config.toml"))
(set-var! 'jj-program jj)

;; Run jj in the repository, its output to a file; its output.
(define (jj! . args)
  (let ([out (path-join dir "out.txt")])
    (unless (= 0 (system (format "cd '~a' && '~a' --quiet ~a > '~a' 2>&1" repo jj
                                 (apply string-append (map (lambda (a) (string-append "'" a "' ")) args))
                                 out)))
      (printf "FAIL jj ~a: ~a\n" args (read-file-string out))
      (exit 1))
    (read-file-string out)))

(mkdir repo)
(jj! "git" "init")
(write-file! (path-join repo "f.txt") "one\ntwo\nthree\nfour\n")
(write-file! (path-join repo ".gitignore") "ignored.txt\n")
(jj! "commit" "-m" "the first lines")
(jj! "bookmark" "create" "main" "-r" "@-")
(jj! "describe" "-m" "working on it")
(define (op-head) (jj! "--ignore-working-copy" "op" "log" "-n" "1" "--no-graph" "-T" "id"))
(define op-before (op-head))

(headless-start! 20 120)
(define b (open-file! (path-join repo "f.txt")))
(switch-to-buffer! b)
(run-until "the base" (lambda () (vector? (jj-hunks b))))
(check "no changes yet" (equal? (jj-hunks b) (vector)))
(run-until "the working copy's change" (lambda () (jj-info b)))
(redraw!)
(check "the status line: the change, its bookmark-less id, its description"
       (and (on-screen? (string-append "@ " (cdr (assq 'id (jj-info b)))))
            (on-screen? "working on it")))

;; Edits: a line added, one changed, one deleted -- marked as they happen.
(define (row-of s) (screen-row-of s))
(define (mark-of s) (let ([r (row-of s)]) (and r (string-ref (screen-row r) (- (string-contains (screen-row r) s) 1)))))
(buffer-insert! b (text-line-start (buffer-text b) 1) "added\n")
(redraw!)
(expect-equal "added" (jj-hunks b) (vector (vector 1 0 1 1)))
(expect-equal "marked ▎" (mark-of "added") #\▎)
(let ([t (buffer-text b)])
  (buffer-edit! b (list (list (text-line-start t 3) (text-line-end t 3) "THREE")))
  (buffer-delete! b (text-line-start t 4) (text-line-start t 5)))
(redraw!)
(expect-equal "changed and deleted" (jj-hunks b) (vector (vector 1 0 1 1) (vector 2 2 3 1)))
(expect-equal "changed: ▎" (mark-of "THREE") #\▎)

;; The menu: the next change, its diff, putting it back.
(goto-line! 1)
(press! "space" "g" "n")
(expect-equal "next change" (text-line-of (buffer-text b) (sel-start (view-primary (current-view)))) 1)
(press! "space" "g" "n")
(expect-equal "and the next" (text-line-of (buffer-text b) (sel-start (view-primary (current-view)))) 3)
;; Vim's ]c [c and Helix's ]g [g, round the end.
(define (line-now) (text-line-of (buffer-text b) (sel-start (view-primary (current-view)))))
(set-var! 'key-scheme 'vim)
(goto-line! 1)
(press! "]" "c")
(expect-equal "Vim's ]c" (line-now) 1)
(press! "[" "c")
(expect-equal "Vim's [c, round the start" (line-now) 3)
(set-var! 'key-scheme 'helix)
(goto-line! 1)
(press! "]" "g" "]" "g")
(expect-equal "Helix's ]g" (line-now) 3)
(set-var! 'key-scheme 'ki)
(press! "space" "g" "d")
(check "its diff" (and (on-screen? "- three") (on-screen? "- four") (on-screen? "+ THREE")))
(press! "esc")
(press! "space" "g" "r")
(expect-equal "put back" (buffer-string b) "one\nadded\ntwo\nthree\nfour\n")
(press! "space" "g" "p" "space" "g" "r")
(expect-equal "all put back" (buffer-string b) "one\ntwo\nthree\nfour\n")
(check "no changes" (equal? (jj-hunks b) (vector)))
;; A line deleted is marked on the line after it.
(buffer-delete! b (text-line-start (buffer-text b) 1) (text-line-start (buffer-text b) 2))
(redraw!)
(expect-equal "deleted" (jj-hunks b) (vector (vector 1 1 1 0)))
(expect-equal "deleted: ▔ on the line after" (mark-of "three") #\▔)
(buffer-insert! b (text-line-start (buffer-text b) 1) "two\n")
;; At the end, with no newline after it: the newline before stands for it.
(buffer-edit! b (list (list (- (text-length (buffer-text b)) 1) (text-length (buffer-text b)) "\nfive")))
(goto-line! 5)
(press! "space" "g" "r")
(expect-equal "a last line put back" (buffer-string b) "one\ntwo\nthree\nfour\n")

;; Blame: who changed each line, beside it.
(press! "space" "g" "b")
(run-until "blame" (lambda () (redraw!) (on-screen? "Tess Ter")))
(check "blame names the change" (on-screen? (string-append (substring (jj! "--ignore-working-copy" "log" "-r" "@-" "--no-graph" "-T" "change_id.shortest(8)") 0 8) " Tess")))
(goto-line! 2)
(press! "space" "g" "a")
(check "who changed this line" (on-screen? "the first lines"))
(press! "space" "g" "b")
(redraw!)
(check "blame off" (not (on-screen? "Tess Ter")))

;; jj status, in a buffer.
(press! "space" "g" "s")
(run-until "status" (lambda () (equal? (buffer-name (current-buffer)) "*jj status*")))
(check "jj status" (string-contains (buffer-contents) "Working copy"))
(switch-to-buffer! b)

;; A new file is all added; an ignored one, unmarked; one with no file
;; too. (Not a file outside the repository: the test's own directory may
;; be in one, as Buck's is.)
(write-file! (path-join repo "new.txt") "fresh\nlines\n")
(write-file! (path-join repo "ignored.txt") "not jj's\n")
(define n (open-file! (path-join repo "new.txt")))
(define i (open-file! (path-join repo "ignored.txt")))
(define o (new-buffer! "no file" "text\n" fundamental-mode))
(run-until "new and ignored" (lambda () (and (buffer-local n 'jj-base #f) (buffer-local i 'jj-base #f))))
(expect-equal "a new file: added" (jj-hunks n) (vector (vector 0 0 0 3)))
(check "an ignored file: unmarked" (not (jj-hunks i)))
(check "no file: no repository" (and (not (jj-root o)) (not (jj-hunks o))))

;; quad read the repository, but changed nothing in it.
(expect-equal "the operation log as it was" (op-head) op-before)

;; The repository changing elsewhere: the marks follow, once quad looks.
(buffer-insert! b 0 "zero\n")
(save-buffer! b)
(jj! "commit" "-m" "zero")
(press! (make-focus-event #t))
(run-until "the new base" (lambda () (equal? (jj-hunks b) (vector))))
(run-until "the new change" (lambda () (redraw!) (on-screen? "(empty)")))
(check "an empty working copy" (cdr (assq 'empty? (jj-info b))))
