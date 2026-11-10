;; keymap.sls -- commands and keymaps
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; Named commands, and the keymaps that bind keys to them or to other
;; keymaps (layers); the editor core's second layer (see editor.sls).
(library (quad keymap)
  (export
          make-command command? command-name command-doc command-proc commands last-command
          this-command define-command find-command command-names run-command make-keymap
          keymap? keymap-name keymap-title keymap-bindings keymap-on-tap keymap-on-tap-set!
          keymap-momentary? keymap-momentary?-set! make-binding binding? binding-target
          binding-label binding-order define-key undefine-key! keymap-lookup
          keymap-lookup-target keymap-entries global-keymap normal-keymap insert-keymap
          prompt-keymap keymap-parent keymap-parent-set!
          key-scheme? key-scheme-name key-scheme-title key-scheme-doc key-scheme-keymap
          define-key-scheme! use-key-scheme! find-key-scheme key-scheme-names current-key-scheme)
  (import (chezscheme) (quad util) (quad event) (quad buffer) (quad client))

  ;; ---------------------------------------------------------------------------
  ;; Commands

  (define-record-type command (fields name doc proc))
  (define commands (make-eq-hashtable))
  (define the-last-command #f)
  (define the-this-command #f)
  (define (last-command) the-last-command)
  (define (this-command) the-this-command)

  (define (define-command name doc proc)
    (hashtable-set! commands name (make-command name doc proc))
    name)

  (define (find-command name) (hashtable-ref commands name #f))
  (define (command-names) (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b)))
                                (vector->list (hashtable-keys commands))))

  ;; Run a command (a name or a procedure). In normal mode each command is
  ;; one undo step; one that enters insert mode extends the step until the
  ;; insert session ends.
  (define (run-command c)
    (let* ([v (current-view)]
           [b (view-buffer v)]
           [proc (cond [(procedure? c) c]
                       [(find-command c) => command-proc]
                       [else (errorf 'run-command "no command named ~s" c)])])
      (set! the-this-command c)
      ;; A command brings the view back to the selection after scrolling
      ;; with the wheel; scrolling commands set free-scroll again.
      (view-local-set! v 'free-scroll #f)
      (let ([normal? (eq? (view-input-mode v) 'normal)])
        (when normal? (buffer-begin-group! b))
        (guard (e [#t (message-error "~a" (condition->string e))])
          (proc))
        (when (and normal? (eq? (current-view) v) (eq? (view-input-mode v) 'normal))
          (buffer-end-group! b)))
      (set! the-last-command c)
      (run-hooks 'post-command-hook c)))

  ;; ---------------------------------------------------------------------------
  ;; Keymaps
  ;;
  ;; A keymap maps key specs to bindings, each a target (a command name, a
  ;; procedure or a keymap) and a short label for the legend. A keymap bound
  ;; as a target is a layer: pressing its key enters it, and the next key is
  ;; looked up there. A momentary layer has an on-tap command: with the kitty
  ;; protocol it is active only while its key is held, and a tap with no other
  ;; key runs on-tap; on a legacy terminal, pressing its key twice does.
  ;;
  ;; A keymap may have a parent, which a key it does not bind is looked up
  ;; in: normal-keymap's is the key scheme's (below), so that what an init
  ;; file or an extension binds there wins whichever scheme is in use.

  (define-record-type keymap
    (fields name title bindings (mutable on-tap) (mutable momentary?) (mutable parent))
    (protocol
     (lambda (new)
       (case-lambda
        [(name) (new name (symbol->string name) (make-hashtable string-hash string=?) #f #f #f)]
        [(name title) (new name title (make-hashtable string-hash string=?) #f #f #f)]
        [(name title on-tap)
         (new name title (make-hashtable string-hash string=?) on-tap (and on-tap #t) #f)]))))

  (define-record-type binding (fields target label order))
  (define binding-counter 0)

  (define define-key
    (case-lambda
     [(km key target) (define-key km key target #f)]
     [(km key target label)
      (set! binding-counter (+ binding-counter 1))
      (hashtable-set! (keymap-bindings km) key
                      (make-binding target
                                    (or label
                                        (cond [(keymap? target) (keymap-title target)]
                                              [(symbol? target) (symbol->string target)]
                                              [else "λ"]))
                                    binding-counter))]))

  (define (undefine-key! km key) (hashtable-delete! (keymap-bindings km) key))

  (define (keymap-lookup km key)
    (or (hashtable-ref (keymap-bindings km) key #f)
        (let ([p (keymap-parent km)]) (and p (keymap-lookup p key)))))

  ;; What a key is bound to, or #f: handy for reaching into layers, as in
  ;; (define-key (keymap-lookup-target space-keymap "l") "d" 'my-command).
  (define (keymap-lookup-target km key)
    (let ([b (keymap-lookup km key)]) (and b (binding-target b))))

  ;; The bindings, as (key . binding), in the order they were defined: the
  ;; keymap's own, and its parent's that it does not bind itself.
  (define (keymap-entries km)
    (let-values ([(ks vs) (hashtable-entries (keymap-bindings km))])
      (let ([own (map cons (vector->list ks) (vector->list vs))]
            [inherited (let ([p (keymap-parent km)]) (if p (keymap-entries p) '()))])
        (sort (lambda (a b) (< (binding-order (cdr a)) (binding-order (cdr b))))
              (append own (remp (lambda (e) (hashtable-contains? (keymap-bindings km) (car e))) inherited))))))

  (define global-keymap (make-keymap 'global "Global"))
  (define normal-keymap (make-keymap 'normal "Normal"))
  (define insert-keymap (make-keymap 'insert "Insert"))
  (define prompt-keymap (make-keymap 'prompt "Prompt"))

  ;; ---------------------------------------------------------------------------
  ;; Key schemes
  ;;
  ;; A key scheme is a way to edit: Ki's (the default), Vim's, Helix's, each
  ;; an extension's. It has a keymap for normal mode, which becomes
  ;; normal-keymap's parent while the scheme is in use; insert mode, the
  ;; space menu, panes (ctrl+w) and prompts are the editor's, the same in
  ;; every scheme. The variable key-scheme names the one in use:
  ;;
  ;;   (set-var! 'key-scheme 'vim)
  ;;
  ;; activate, if not #f, runs as it comes into use (with no argument), and
  ;; deactivate as another does.

  (define-variable key-scheme 'ki
    "The way to edit, as an extension defines it: 'ki (the default), 'vim or 'helix")

  (define-record-type key-scheme (fields name title doc keymap activate deactivate))

  (define key-schemes '())
  (define active-scheme #f)

  (define (key-scheme-names) (map key-scheme-name key-schemes))
  (define (find-key-scheme name) (find (lambda (s) (eq? (key-scheme-name s) name)) key-schemes))
  (define (current-key-scheme) active-scheme)

  ;; Define a scheme: name, title (for people), doc, its normal-mode
  ;; keymap. In use at once if key-scheme names it.
  (define define-key-scheme!
    (case-lambda
     [(name title doc keymap) (define-key-scheme! name title doc keymap #f #f)]
     [(name title doc keymap activate deactivate)
      (let ([s (make-key-scheme name title doc keymap activate deactivate)])
        (set! key-schemes (append (remp (lambda (o) (eq? (key-scheme-name o) name)) key-schemes) (list s)))
        (when (eq? (get-var 'key-scheme) name) (use-key-scheme! name)))]))

  (define (use-key-scheme! name)
    (let ([s (find-key-scheme name)])
      (unless s (errorf 'key-scheme "no key scheme is named ~s (there are ~s)" name (key-scheme-names)))
      (unless (eq? s active-scheme)
        (when (and active-scheme (key-scheme-deactivate active-scheme)) ((key-scheme-deactivate active-scheme)))
        (set! active-scheme s)
        (keymap-parent-set! normal-keymap (key-scheme-keymap s))
        (when (key-scheme-activate s) ((key-scheme-activate s))))))

  (at-load
   (add-hook! 'variable-change-hook
              (lambda (name v)
                (when (and (eq? name 'key-scheme) (find-key-scheme v))
                  (use-key-scheme! v))))))
