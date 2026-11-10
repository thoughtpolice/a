;; json.ss -- JSON, and JSON-RPC with a subprocess
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

;; Reading.
(expect-equal "scalars" (map json-read-string '("1" "-2.5" "1e3" "true" "false" "null" "\"x\""))
              '(1 -2.5 1000.0 #t #f null "x"))
(expect-equal "an object" (json-read-string " {\"a\": [1, {\"b\": null}], \"c\": {}} ")
              '((a . #(1 ((b . null)))) (c)))
(expect-equal "empty array" (json-read-string "[ ]") '#())
(expect-equal "escapes" (json-read-string "\"a\\\"b\\\\c\\n\\t\\u00e9\\ud83d\\ude00\"")
              "a\"b\\c\n\té😀")
(expect-equal "UTF-8 passes through" (json-read-string "\"λ → ✓\"") "λ → ✓")
(check "trailing garbage is an error" (string? (error-message-of (lambda () (json-read-string "1 2")))))
(check "unterminated" (string? (error-message-of (lambda () (json-read-string "[1, 2")))))
(check "bad literal" (string? (error-message-of (lambda () (json-read-string "nul")))))

;; Writing.
(expect-equal "write" (json->string '((ok . #t) (n . 3) (x . 1.5) (s . "q\"\n\x1;") (a . #(1 null)) (o)))
              "{\"ok\":true,\"n\":3,\"x\":1.5,\"s\":\"q\\\"\\n\\u0001\",\"a\":[1,null],\"o\":{}}")
(expect-equal "lists of values are arrays" (json->string '("a" b 2)) "[\"a\",\"b\",2]")
(expect-equal "round trip" (json-read-string (json->string '((k . #("é" -1 0.25 #f)))))
              '((k . #("é" -1 0.25 #f))))

;; Paths.
(define v (json-read-string "{\"a\": {\"b\": [10, 20]}, \"n\": null}"))
(expect-equal "json-ref" (json-ref v 'a 'b 1) 20)
(expect-equal "json-ref missing" (json-ref v 'a 'z) #f)
(expect-equal "json-ref null" (json-ref v 'n) #f)

;; JSON-RPC, with cat for a peer: it echoes everything, so what quad sends
;; comes back to it. A request comes back as a request from the peer;
;; quad's reply comes back as the response to its own request, as they
;; share an id.
(headless-start! 10 40)
(define notes '())
(define results '())
(define status 'running)
(define rpc
  (jsonrpc-start '("cat") #f #f
                 (lambda (method params) (set! notes (cons (list method params) notes)))
                 (lambda (rpc id method params)
                   (jsonrpc-reply! rpc id `((echoed . ,method) (params . ,params))))
                 (lambda (s) (set! status s) (editor-stop!))))
(check "running" (jsonrpc-running? rpc))
(jsonrpc-notify! rpc "hello" '((n . 1)))
(jsonrpc-request! rpc "add" (vector 1 2)
                  (lambda (r)
                    (set! results (cons r results))
                    ;; Done: closing cat's input ends it.
                    (process-close-input! (jsonrpc-process rpc))))
(run-until "cat exits" (lambda () (not (eq? status 'running))))
(expect-equal "notification" notes '(("hello" ((n . 1)))))
(expect-equal "request and reply" results '(((echoed . "add") (params . #(1 2)))))
(expect-equal "exit status" status 0)
(check "stopped" (not (jsonrpc-running? rpc)))
(check "sending after exit is an error" (string? (error-message-of (lambda () (jsonrpc-notify! rpc "x" #f)))))

;; The same, framed as the Language Server Protocol has it: a header
;; giving the length in bytes. The text is longer than one read (64 KiB)
;; and not all ASCII, so a message arrives in pieces and its length in
;; bytes is not its length in characters.
(define big (apply string-append (map (lambda (i) "λ-😀-") (iota 20000))))
(set! results '())
(define framed-done? #f)
(define framed
  (jsonrpc-start '("cat") #f #f void
                 (lambda (rpc id method params) (jsonrpc-reply! rpc id params))
                 (lambda (s) (set! framed-done? #t) (editor-stop!))
                 'headers))
(jsonrpc-request! framed "echo" `((text . ,big))
                  (lambda (r) (set! results (cons r results)) (process-close-input! (jsonrpc-process framed))))
(run-until "the framed cat exits" (lambda () framed-done?))
(check "framed, in pieces" (equal? results `(((text . ,big)))))

;; Several messages in a read, the last not whole: each whole one is
;; taken out before what follows it moves up to wait for the rest.
(set! results '())
(define several-done? #f)
(define several
  (jsonrpc-start '("cat") #f #f void
                 (lambda (rpc id method params) (jsonrpc-reply! rpc id params))
                 (lambda (s) (set! several-done? #t) (editor-stop!))
                 'headers))
(for-each (lambda (i) (jsonrpc-request! several "echo" `((n . ,i)) (lambda (r) (set! results (cons r results)))))
          (iota 3))
(jsonrpc-request! several "echo" `((text . ,big))
                  (lambda (r) (set! results (cons r results)) (process-close-input! (jsonrpc-process several))))
(run-until "the cat of several exits" (lambda () several-done?))
(check "several, and one in pieces after them"
       (equal? (reverse results) `(((n . 0)) ((n . 1)) ((n . 2)) ((text . ,big)))))

;; A program that is not there.
(check "spawn failure" (string-contains (error-message-of (lambda () (spawn-process '("/nonexistent/quad-test") #f #f)))
                                        "/nonexistent/quad-test"))

;; A process that never ends is stopped, and its pending requests fail.
(define failed #f)
(define sleeper
  (jsonrpc-start '("sleep" "60") #f #f void void (lambda (s) (set! status s))))
(jsonrpc-request! sleeper "nothing" #f void (lambda (e) (set! failed (jsonrpc-error-message e))))
(jsonrpc-stop! sleeper 50)
(expect-equal "killed" status -9)
(expect-equal "pending request failed" failed "the server exited")
