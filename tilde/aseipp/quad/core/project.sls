;; project.sls -- projects: configuration kept in a repository, once trusted
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; A project is a directory with a .quad/ directory in it, whose init.ss
;; configures the editor for the project's files: their variables, the
;; language servers they use, commands of their own. Opening a file loads
;; the configuration of every project the file is in, outermost first.
;;
;; That configuration is code, and comes with the repository, so quad runs
;; it only once you trust it, as Helix and VS Code ask before they do. The
;; first time, quad asks; you can read the code, or have an AI review it
;; first (project-reviewer-set!; the codex extension provides one, which
;; reads the code without any tools to act with). Trust is kept by hash of
;; .quad/'s contents, in project-trust-file: a change to them asks again.
;; Files outside .quad/ that the configuration relies on -- a list of
;; commands it runs, say -- can be named in .quad/files, a path relative to
;; the project per line: they are hashed and reviewed with it.
;;
;; In .quad/init.ss, everything quad exports is in scope, and so is:
;;
;;   (project-root)                   this project's directory
;;   (project-path "buck/tool")       a path in it
;;   (project-set! 'tab-width 4)      a variable, for the project's buffers
;;   (project-buffer-hook! proc)      (proc buffer) for each of its buffers
;;   (project-add-hook! 'hook proc)   add-hook!, undone when it reloads
;;
;; and the language server extension scopes the servers it defines to the
;; project's files.
(library (quad project)
  (export project-config-roots project-visit! project-roots project-state project-review
          project-root project-path project-set! project-buffer-hook! project-add-hook!
          project-loading project-of project-buffer? project-hash project-config-files
          project-trusted? project-trust! project-forget! project-reload! project-ask!
          project-reviewer-set! project-reviewer)
  (import (chezscheme) (quad util) (quad buffer) (quad editor) (quad commands) (quad native))

  (define-variable project-config #t
    "Whether projects' .quad/ configuration loads, once trusted (quad -q turns it off)")
  (define-variable project-trust-file #f
    "The file keeping trusted projects, or #f for $XDG_STATE_HOME/quad/trusted")

  ;; ---------------------------------------------------------------------------
  ;; Projects

  ;; state: unknown (not yet asked), pending (to ask once a client is
  ;; here), asking, loaded, declined (for this session), failed.
  (define-record-type proj
    (fields root (mutable state) (mutable hooks) (mutable vars) (mutable buffer-hooks)
            (mutable review)))

  (define projects (make-hashtable string-hash string=?))   ; root -> proj

  (define (project-config-roots)
    (let-values ([(roots ps) (hashtable-entries projects)]) (sort-strings (vector->list roots))))
  (define (project-state root) (let ([p (hashtable-ref projects root #f)]) (and p (proj-state p))))
  (define (project-review root) (let ([p (hashtable-ref projects root #f)]) (and p (proj-review p))))

  (define (config-dir root) (path-join root ".quad"))
  (define (config-file root) (path-join root ".quad/init.ss"))

  ;; The directories path is in that are projects, outermost first.
  (define (project-roots path)
    (let loop ([dir (if (guard (e [#t #f]) (file-directory? path)) path (path-dirname path))] [acc '()])
      (let* ([acc (if (file-exists? (config-file dir)) (cons dir acc) acc)]
             [up (path-dirname dir)])
        (if (or (string=? dir "/") (string=? dir "") (string=? up dir))
            acc
            (loop up acc)))))

  (define (under? root path)
    (and path (or (string=? path root) (string-prefix? (path-join root "") path))))

  ;; The loaded projects buffer b is in, outermost first.
  (define (loaded-for path)
    (filter (lambda (root) (let ([p (hashtable-ref projects root #f)]) (and p (eq? (proj-state p) 'loaded))))
            (if path (project-roots path) '())))

  ;; The project being loaded, while its init.ss runs.
  (define project-loading (make-parameter #f))

  ;; The innermost loaded project path (default: the current buffer's file,
  ;; else the working directory) is in, or #f.
  (define project-of
    (case-lambda
     [() (project-of (or (and (current-buffer) (buffer-path (current-buffer))) (current-directory)))]
     [(path) (let ([l (loaded-for path)]) (and (pair? l) (car (last-pair* l))))]))

  ;; This project's directory: the one loading, else the current buffer's.
  (define (project-root) (or (project-loading) (project-of)))

  (define (project-path rel)
    (let ([root (project-root)])
      (unless root (errorf 'project-path "not in a project"))
      (path-join root rel)))

  (define (project-buffer? b . root)
    (under? (if (pair? root) (car root) (project-root)) (buffer-path b)))

  (define (loading-proj who)
    (let ([root (project-loading)])
      (unless root (errorf who "only a project's .quad/init.ss can say this"))
      (hashtable-ref projects root #f)))

  (define (project-buffers root) (filter (lambda (b) (under? root (buffer-path b))) (buffers)))

  ;; Variable name is value in this project's buffers, as set-local! makes
  ;; it, now and as they open.
  (define (project-set! name value)
    (let ([p (loading-proj 'project-set!)])
      (get-var name #f)                 ; it must exist
      (proj-vars-set! p (append (remp (lambda (e) (eq? (car e) name)) (proj-vars p)) (list (cons name value))))
      (for-each (lambda (b) (set-local! name value b)) (project-buffers (proj-root p)))))

  ;; (proc buffer) for each of this project's buffers, now and as they open.
  (define (project-buffer-hook! proc)
    (let ([p (loading-proj 'project-buffer-hook!)])
      (proj-buffer-hooks-set! p (append (proj-buffer-hooks p) (list proc)))
      (for-each (lambda (b) (run-guarded proc b)) (project-buffers (proj-root p)))))

  ;; add-hook!, undone when the project reloads or is forgotten.
  (define (project-add-hook! name proc)
    (let ([p (loading-proj 'project-add-hook!)])
      (proj-hooks-set! p (cons (cons name proc) (proj-hooks p)))
      (add-hook! name proc)))

  (define (run-guarded proc . args)
    (guard (e [#t (message-error "Project: ~a" (condition->string e))])
      (apply proc args)))

  ;; A buffer opening in loaded projects gets their variables and hooks.
  (define (buffer-opened! b)
    (for-each (lambda (root)
                (let ([p (hashtable-ref projects root #f)])
                  (for-each (lambda (e) (set-local! (car e) (cdr e) b)) (proj-vars p))
                  (for-each (lambda (h) (run-guarded h b)) (proj-buffer-hooks p))))
              (loaded-for (buffer-path b))))

  ;; ---------------------------------------------------------------------------
  ;; Trust: the hash of .quad/'s contents, kept per project root

  ;; .quad/'s files, and those .quad/files names, as (relative-path .
  ;; contents) pairs, in order.
  (define (project-config-files root)
    (append (quad-files root) (named-files root)))

  ;; The paths .quad/files names: relative, inside the project.
  (define (named-files root)
    (let ([list-file (path-join (config-dir root) "files")])
      (if (file-exists? list-file)
          (filter-map (lambda (line)
                        (let ([rel (string-trim line)])
                          (and (not (string=? rel "")) (not (string-prefix? "#" rel))
                               (if (or (string-prefix? "/" rel) (member ".." (string-split rel #\/)))
                                   (cons rel "[not read: .quad/files names only paths inside the project]")
                                   (cons rel (let ([f (path-join root rel)])
                                               (if (file-exists? f) (guard (e [#t ""]) (read-file-string f)) "[missing]")))))))
                      (string-split (read-file-string list-file) #\newline))
          '())))

  (define (quad-files root)
    (let walk ([rel ""])
      (let* ([dir (path-join (config-dir root) rel)]
             [names (sort-strings (guard (e [#t '()]) (directory-list dir)))])
        (apply append
               (map (lambda (n)
                      (let ([r (if (string=? rel "") n (path-join rel n))] [full (path-join dir n)])
                        (cond
                         [(guard (e [#t #f]) (file-directory? full)) (walk r)]
                         [else (list (cons (path-join ".quad" r) (guard (e [#t ""]) (read-file-string full))))])))
                    names)))))

  ;; The hash of a project's configuration, which trust is recorded by: in
  ;; uppercase hex, as the trust files written so far have it.
  (define (project-hash root)
    (string-upcase
     (bytevector->hex
      (blake3 (string->utf8
               (apply string-append
                      (map (lambda (f) (format "~a\x0;~a\x0;~a" (car f) (string-length (cdr f)) (cdr f)))
                           (project-config-files root))))))))

  (define (trust-file)
    (or (get-var 'project-trust-file #f)
        (path-join (or (getenv "XDG_STATE_HOME") (path-join (or (getenv "HOME") "/tmp") ".local/state"))
                   "quad/trusted")))

  ;; Lines of "HASH ROOT".
  (define (read-trust)
    (let ([f (trust-file)])
      (if (file-exists? f)
          (filter-map (lambda (line)
                        (let ([sp (string-index line #\space)])
                          (and sp (cons (substring line (+ sp 1) (string-length line)) (substring line 0 sp)))))
                      (string-split (read-file-string f) #\newline))
          '())))

  (define (write-trust! entries)
    (let ([f (trust-file)])
      (let mkdir-p ([d (path-dirname f)])
        (unless (or (string=? d "") (file-exists? d)) (mkdir-p (path-dirname d)) (mkdir d)))
      (write-file-string f (apply string-append (map (lambda (e) (format "~a ~a\n" (cdr e) (car e))) entries)))))

  (define (project-trusted? root)
    (let ([e (assoc root (read-trust))]) (and e (string=? (cdr e) (project-hash root)))))

  (define (trust-store! root)
    (write-trust! (append (remp (lambda (e) (string=? (car e) root)) (read-trust))
                          (list (cons root (project-hash root))))))

  ;; ---------------------------------------------------------------------------
  ;; Loading

  (define (project! root)
    (or (hashtable-ref projects root #f)
        (let ([p (make-proj root 'unknown '() '() '() #f)])
          (hashtable-set! projects root p)
          p)))

  ;; Load the configuration of the projects path is in that are trusted,
  ;; and ask about the others.
  (define (project-visit! path)
    (when (get-var 'project-config #f)
      (for-each (lambda (root)
                  (let ([p (project! root)])
                    (when (memq (proj-state p) '(unknown pending))
                      (if (project-trusted? root) (load! p) (ask-later! p)))))
                (project-roots path))))

  (define (unload! p)
    (run-hooks 'project-unload-hook (proj-root p))
    (for-each (lambda (h) (remove-hook! (car h) (cdr h))) (proj-hooks p))
    (proj-hooks-set! p '())
    (proj-vars-set! p '())
    (proj-buffer-hooks-set! p '()))

  (define (load! p)
    (let ([root (proj-root p)])
      (when (eq? (proj-state p) 'loaded) (unload! p))
      (proj-state-set! p 'loaded)
      (let ([ok? (parameterize ([project-loading root])
                   (guard (e [#t (message-error "Error in ~a: ~a" (config-file root) (condition->string e)) #f])
                     (load (config-file root) (lambda (x) (eval x (quad-environment))))
                     #t))])
        (unless ok? (proj-state-set! p 'failed))
        (run-hooks 'project-load-hook root)
        (when ok? (message "Loaded ~a" (config-file root))))))

  (define (project-reload! root)
    (let ([p (project! root)])
      (cond
       [(not (file-exists? (config-file root))) (unload! p) (proj-state-set! p 'declined)]
       [(project-trusted? root) (load! p)]
       [else (when (eq? (proj-state p) 'loaded) (unload! p)) (proj-state-set! p 'pending) (project-ask! root)])))

  (define (project-trust! root)
    (trust-store! root)
    (load! (project! root)))

  (define (project-forget! root)
    (write-trust! (remp (lambda (e) (string=? (car e) root)) (read-trust)))
    (let ([p (project! root)])
      (when (eq? (proj-state p) 'loaded) (unload! p))
      (proj-state-set! p 'declined)))

  ;; ---------------------------------------------------------------------------
  ;; Asking

  ;; (reviewer root files k): review the files, ((path . text) ...), of
  ;; root's .quad/, then (k text), or (k #f message) if it could not.
  (define reviewer #f)
  (define (project-reviewer-set! f) (set! reviewer f))
  (define (project-reviewer) reviewer)

  (define queue '())                    ; projects waiting to be asked about

  (define (ask-later! p)
    (proj-state-set! p 'pending)
    (unless (memq p queue) (set! queue (append queue (list p))))
    (next-question!))

  (define (asking?) (exists (lambda (p) (eq? (proj-state p) 'asking)) (hashtable-values* projects)))
  (define (hashtable-values* h) (let-values ([(ks vs) (hashtable-entries h)]) (vector->list vs)))

  ;; Run thunk as the current client, or any: #f, without running it,
  ;; when there is none to ask.
  (define (as-asker thunk)
    (and (pair? (clients)) (begin (with-client-or-any (current-client) thunk) #t)))

  (define (next-question!)
    (when (and (pair? queue) (pair? (clients)) (not (asking?)))
      (let ([p (car queue)])
        (set! queue (cdr queue))
        (ask-trust! p))))

  ;; Ask about root now, as the current client.
  (define (project-ask! root)
    (let ([p (project! root)])
      (set! queue (remq p queue))
      (ask-trust! p)))

  (define (summary root)
    (let* ([files (project-config-files root)]
           [lines (apply + (map (lambda (f) (length (string-split (cdr f) #\newline))) files))])
      (format "~a has a .quad/ configuration (~a file~a, ~a line~a: ~a). quad would run its code, and \
whatever that code runs, with your permissions, as it runs your own init file. Trust it only if you \
trust where the repository came from; a change to these files asks again."
              root (length files) (if (= (length files) 1) "" "s") lines (if (= lines 1) "" "s")
              (string-join (map car files) ", "))))

  (define (ask-trust! p)
    (let ([root (proj-root p)])
      (proj-state-set! p 'asking)
      (unless (as-asker
               (lambda ()
                 (pick "Trust this project?"
                       (append
                        '(("Trust it, and load its configuration" . trust))
                        (if (proj-review p)
                            '(("Read the review" . read))
                            (if reviewer '(("Have an AI review its code first (it gets no tools)" . review)) '()))
                        '(("Show me its code" . show) ("Not now" . later)))
                       (lambda (choice) (decided! p choice))
                       'picker
                       (if (proj-review p)
                           (string-append (review-headline (proj-review p)) "\n\n" (summary root))
                           (summary root)))))
        ;; No one to ask yet: once a client attaches.
        (proj-state-set! p 'pending)
        (unless (memq p queue) (set! queue (append queue (list p)))))))

  (define (review-headline text)
    (let ([first (car (string-split (string-append text "\n") #\newline))])
      (format "AI review, which read it without tools (advice only: the code could be written to \
mislead it): ~a" (string-trim first))))

  (define (decided! p choice)
    (let ([root (proj-root p)])
      (case choice
        [(trust) (trust-store! root) (load! p) (next-question!)]
        [(review) (review! p)]
        [(read) (show-review! p) (proj-state-set! p 'declined) (next-question!)]
        [(show)
         (proj-state-set! p 'declined)
         (for-each (lambda (f)
                     (let ([b (open-file! (path-join root (car f)))])
                       (buffer-read-only?-set! b #t)
                       (switch-to-buffer! b)))
                   (reverse (project-config-files root)))
         (message "When you have read it: space space project-trust")
         (next-question!)]
        [else (proj-state-set! p 'declined) (message "Not loading ~a" (config-file root)) (next-question!)])
      (unless (memq choice '(trust review)) (run-hooks 'project-declined-hook root))))

  (define (review! p)
    (let ([root (proj-root p)] [client (current-client)])
      (message "Reviewing ~a/.quad/ ..." root)
      (reviewer root (project-config-files root)
                (case-lambda
                 [(text) (proj-review-set! p text) (with-client* client (lambda () (ask-trust! p)))]
                 [(no why) (with-client* client
                             (lambda () (message-error "The review failed: ~a" why) (ask-trust! p)))]))))

  (define (with-client* c thunk)
    (when (pair? (clients)) (with-client-or-any c thunk)))

  (define (show-review! p)
    (show-text-buffer! "*project review*"
                       (format "# AI review of ~a/.quad/\n\nThe reviewer read the code without tools, as \
untrusted text. Its verdict is advice: code can be written to mislead a reviewer.\n\n~a\n\nTo trust it: space space project-trust\n"
                               (proj-root p) (proj-review p))
                       'markdown))

  ;; ---------------------------------------------------------------------------
  ;; Commands

  (define (here-root)
    (let* ([path (or (and (current-buffer) (buffer-path (current-buffer))) (current-directory))]
           [roots (project-roots path)])
      (and (pair? roots) (car (last-pair* roots)))))

  (at-load
   (add-hook! 'before-open-file-hook project-visit!)
   (add-hook! 'find-file-hook buffer-opened!)
   (add-hook! 'client-attach-hook (lambda (c) (next-question!)))
   (define-command 'project-trust "Ask again whether to trust this project's .quad/"
     (lambda () (let ([r (here-root)]) (if r (project-ask! r) (message "Not in a project (no .quad/ above)")))))
   (define-command 'project-reload "Load this project's .quad/init.ss again"
     (lambda () (let ([r (here-root)]) (if r (project-reload! r) (message "Not in a project (no .quad/ above)")))))
   (define-command 'project-forget "Stop trusting this project"
     (lambda () (let ([r (here-root)])
                  (if r (begin (project-forget! r) (message "No longer trusting ~a" r))
                      (message "Not in a project (no .quad/ above)")))))
   (define-command 'project-info "The projects known, and whether they are loaded"
     (lambda ()
       (message "~a" (if (null? (project-config-roots))
                         "No projects"
                         (string-join (map (lambda (r) (format "~a (~a)" r (project-state r))) (project-config-roots))
                                      "; ")))))))
