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
          prompt-keymap)
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

  (define-record-type keymap
    (fields name title bindings (mutable on-tap) (mutable momentary?))
    (protocol
     (lambda (new)
       (case-lambda
        [(name) (new name (symbol->string name) (make-hashtable string-hash string=?) #f #f)]
        [(name title) (new name title (make-hashtable string-hash string=?) #f #f)]
        [(name title on-tap)
         (new name title (make-hashtable string-hash string=?) on-tap (and on-tap #t))]))))

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

  (define (keymap-lookup km key) (hashtable-ref (keymap-bindings km) key #f))

  ;; What a key is bound to, or #f: handy for reaching into layers, as in
  ;; (define-key (keymap-lookup-target space-keymap "l") "d" 'my-command).
  (define (keymap-lookup-target km key)
    (let ([b (keymap-lookup km key)]) (and b (binding-target b))))

  ;; The bindings, as (key . binding), in the order they were defined.
  (define (keymap-entries km)
    (let-values ([(ks vs) (hashtable-entries (keymap-bindings km))])
      (sort (lambda (a b) (< (binding-order (cdr a)) (binding-order (cdr b))))
            (map cons (vector->list ks) (vector->list vs)))))

  (define global-keymap (make-keymap 'global "Global"))
  (define normal-keymap (make-keymap 'normal "Normal"))
  (define insert-keymap (make-keymap 'insert "Insert"))
  (define prompt-keymap (make-keymap 'prompt "Prompt")))
