;; paths.ss -- paths and file: URIs, by Unix's rules and by Windows', on
;; any host (path-style picks the rules)
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(define-syntax unix
  (syntax-rules () [(_ e ...) (parameterize ([path-style 'unix]) e ...)]))
(define-syntax windows
  (syntax-rules () [(_ e ...) (parameterize ([path-style 'windows]) e ...)]))

;; Calls (f) with environment variable var set to value, then as it was.
(define (with-env var value f)
  (let ([old (getenv var)])
    (dynamic-wind
      (lambda () (putenv var value))
      f
      (lambda () (putenv var (or old ""))))))

;; ---------------------------------------------------------------------------
;; Unix: as quad has always had them

(unix
 (expect-equal "unix: join" (map (lambda (a) (path-join a "b")) '("" "/" "/a" "/a/" "a"))
               '("b" "/b" "/a/b" "/a/b" "a/b"))
 (expect-equal "unix: basename" (map path-basename '("" "/" "/a" "/a/b" "a" "a/" "/a/b.c"))
               '("" "" "a" "b" "a" "" "b.c"))
 (expect-equal "unix: dirname" (map path-dirname '("" "/" "//" "/a" "/a/b" "a" "a/" "a//b" "/a/"))
               '("." "/" "/" "/" "/a" "." "a" "a/" "/a"))
 (expect-equal "unix: a backslash is a name's" (path-basename "a\\b") "a\\b")
 (expect-equal "unix: absolute" (map absolute-path? '("/" "/a" "a" "" "C:/a" "\\a"))
               '(#t #t #f #f #f #f))
 (expect-equal "unix: roots" (map path-anchor '("/a" "a" "C:/a")) '("/" "" ""))
 (expect-equal "unix: parts" (path-parts "a//b/../c") '("a" "" "b" ".." "c"))
 (expect-equal "unix: normalized as it is" (path-normalize "c:\\a") "c:\\a")
 (expect-equal "unix: native as it is" (path->native "/a/b") "/a/b")
 (expect-equal "unix: absolute already" (absolute-path "/x/y" "/w") "/x/y")
 (expect-equal "unix: from a directory" (absolute-path "y" "/w") "/w/y")
 (expect-equal "unix: from the working directory" (absolute-path "y") (path-join (current-directory) "y"))
 (when (getenv "HOME") (expect-equal "unix: ~/" (expand-home "~/x") (path-join (getenv "HOME") "x")))
 (expect-equal "unix: ~\\ is a name" (expand-home "~\\x") "~\\x")
 (expect-equal "unix: path to URI" (path->file-uri "/a b/c:d/é") "file:///a%20b/c%3Ad/%C3%A9")
 (expect-equal "unix: URI to path" (file-uri->path "file:///a%20b/%C3%A9") "/a b/é")
 (expect-equal "unix: argv as it is" (program-argv '("sh" "-c" "x")) '("sh" "-c" "x")))

;; ---------------------------------------------------------------------------
;; Windows

(windows
 (expect-equal "windows: separators" (map path-separator? '(#\/ #\\ #\:)) '(#t #t #f))
 (expect-equal "windows: roots"
               (map path-anchor '("C:/a" "c:\\a" "C:a" "C:" "/a" "\\a" "//srv/share/a" "\\\\srv\\share" "a" ""))
               '("C:/" "c:\\" "C:" "C:" "/" "\\" "//srv/share/" "\\\\srv\\share" "" ""))
 (expect-equal "windows: absolute"
               (map absolute-path? '("C:/a" "c:\\" "C:a" "C:" "/a" "\\a" "//srv/share" "\\\\srv\\s" "a" ""))
               '(#t #t #f #f #f #f #t #t #f #f))
 (expect-equal "windows: normalized" (map path-normalize '("c:\\Users\\a" "\\\\srv\\share\\x" "a/b\\c"))
               '("C:/Users/a" "//srv/share/x" "a/b/c"))
 (expect-equal "windows: native" (path->native "C:/Users/a b") "C:\\Users\\a b")
 (expect-equal "windows: join" (map (lambda (a) (path-join a "b")) '("" "C:/" "C:\\x\\" "C:/x" "a"))
               '("b" "C:/b" "C:\\x\\b" "C:/x/b" "a/b"))
 (expect-equal "windows: basename" (map path-basename '("C:/a/b.txt" "C:\\a\\b" "C:/" "C:b" "//srv/share/x" "a"))
               '("b.txt" "b" "" "b" "x" "a"))
 (expect-equal "windows: dirname"
               (map path-dirname '("C:/a/b" "C:\\a\\b" "C:/a" "C:/" "C:a" "C:" "//srv/share/x" "//srv/share/" "/a" "a" "a\\b"))
               '("C:/a" "C:\\a" "C:/" "C:/" "C:" "C:" "//srv/share/" "//srv/share/" "/" "." "a"))
 (expect-equal "windows: walking up ends at the root"
               (let loop ([d "C:/a/b/c"] [acc '()])
                 (let ([up (path-dirname d)]) (if (string=? up d) (reverse (cons d acc)) (loop up (cons d acc)))))
               '("C:/a/b/c" "C:/a/b" "C:/a" "C:/"))
 (expect-equal "windows: parts" (path-parts "a\\..\\b/c") '("a" ".." "b" "c"))
 (expect-equal "windows: absolute already, normalized" (absolute-path "c:\\x\\y" "D:/w") "C:/x/y")
 (expect-equal "windows: a share's" (absolute-path "\\\\srv\\s\\y" "D:/w") "//srv/s/y")
 (expect-equal "windows: from a directory" (absolute-path "y\\z" "C:\\w") "C:/w/y/z")
 (expect-equal "windows: on the directory's drive" (absolute-path "\\y" "D:/w/v") "D:/y")
 (expect-equal "windows: on the directory's share" (absolute-path "/y" "//srv/s/w") "//srv/s/y")
 (expect-equal "windows: in the directory's drive's directory" (absolute-path "d:y" "D:/w") "D:/w/y")
 (expect-equal "windows: in another drive's" (absolute-path "E:y" "D:/w") "E:/y")
 (when (home-directory) (expect-equal "windows: ~\\" (expand-home "~\\x") (path-join (home-directory) "x")))
 (expect-equal "windows: path to URI"
               (map path->file-uri '("C:/a b/é" "c:\\x" "//srv/share/a b"))
               '("file:///C:/a%20b/%C3%A9" "file:///C:/x" "file://srv/share/a%20b"))
 (expect-equal "windows: URI to path"
               (map file-uri->path '("file:///C:/a%20b/x" "file:///c%3A/x" "file://localhost/C:/x" "file://srv/share/x"))
               '("C:/a b/x" "C:/x" "C:/x" "//srv/share/x"))
 (expect-equal "windows: URI paths, unencoded" (map path->uri-path '("C:/x" "//srv/s/x")) '("/C:/x" "srv/s/x"))
 (expect-equal "windows: temporary files" (with-env "TEMP" "C:\\Temp" temp-directory) "C:/Temp")
 (expect-equal "windows: user" (with-env "USER" "someone" user-name) "someone"))

;; Programs: PATH's directories separated by ;, and PATHEXT's extensions,
;; which npm's .cmd shims have.
(let ([dir (test-temp-dir "paths")] [bin (test-temp-dir "paths-bin")])
  (write-file! (path-join dir "tool.cmd") "@echo off\n")
  (write-file! (path-join bin "other.exe") "")
  (write-file! (path-join bin "tool") "")
  (mkdir (path-join bin "dir.exe"))
  (with-env "PATH" (string-append "\"" bin "\";;" dir)
    (lambda ()
      (with-env "PATHEXT" ".EXE;.CMD"
        (lambda ()
          (windows
           (expect-equal "windows: a .cmd in PATH" (find-executable "tool") (path-join dir "tool.cmd"))
           (expect-equal "windows: an .exe, in a quoted directory" (find-executable "other") (path-join bin "other.exe"))
           (expect-equal "windows: named with its extension" (find-executable "other.exe") (path-join bin "other.exe"))
           (expect-equal "windows: not a directory" (find-executable "dir") #f)
           (expect-equal "windows: missing" (find-executable "missing") #f)
           (expect-equal "windows: by its path" (find-executable (path-join dir "tool")) (path-join dir "tool.cmd"))
           (expect-equal "windows: argv runs its path, natively"
                         (program-argv '("tool" "--stdio"))
                         (list (path->native (path-join dir "tool.cmd")) "--stdio"))
           (expect-equal "windows: argv as it is when not found" (program-argv '("missing" "x")) '("missing" "x")))))))
  ;; Unix: PATH's directories separated by :, and no extensions; on a Unix
  ;; host, whose directories are no drive's, which a : would split.
  (unless windows?
    (with-env "PATH" (string-append bin ":" dir)
      (lambda ()
        (unix
         (expect-equal "unix: as named" (find-executable "tool") (path-join bin "tool"))
         (expect-equal "unix: no extensions" (find-executable "other") #f))))))
