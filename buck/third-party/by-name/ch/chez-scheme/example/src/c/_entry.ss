;; _entry.ss -- application entry point (runtime setup, etc)
;;
;; SPDX-FileCopyrightText: © 2016-2026 Austin Seipp
;; SPDX-License-Identifier: BSD-3-Clause
(import (chezscheme))

;; -----------------------------------------------------------------------------
;; -- Include the necessary source files

(define-syntax when-test
  (lambda (x)
    (syntax-case x ()
      [(_ t)
       (if (equal? (getenv "TEST_BUILD") "1")
           #'t
           #'(void))]
      [(_ t m)
       (if (equal? (getenv "TEST_BUILD") "1")
           #'t
           #'m)])))

(include "build/gen/version.ss")
(when-test
 (include "src/t/main.ss")
 (include "src/ss/main.ss"))

;; -----------------------------------------------------------------------------
;; -- Foreign primitives & initialization

;; Bindings to C function pointers, which we use to wrap and give names to
;; foreign procedures.
(define entry/c-kernel/breakpoint)
(define entry/c-kernel/set-thread-name)
(define entry/c-kernel/set-thread-affinity)
(define entry/c-kernel/get-num-cores)
(define entry/c-kernel/system-waitpid-return)

;; Bind C function pointers to Scheme primitives via foreign-procedure, which
;; can then be called as Scheme functions.
(define (entry/init/load-c-primitives)
  ;; Load the breakpoint function, defined inside the C kernel. Will be called
  ;; in order to give the user a chance to debug the application before
  ;; startup.
  (set! entry/c-kernel/breakpoint
        (foreign-procedure "Sschemeapp_breakpoint" () void))

  ;; Load the function to set thread names, defined inside the C kernel.
  (set! entry/c-kernel/set-thread-name
        (foreign-procedure "Sschemeapp_thread_setname" (string) void))

  ;; Load the function to pin a thread to a specific core.
  (set! entry/c-kernel/set-thread-affinity
        (foreign-procedure "Sschemeapp_thread_setaffinity" (int) int))

  ;; Load the function to get the number of cores
  (set! entry/c-kernel/get-num-cores
        (foreign-procedure "Sschemeapp_system_numcores" () int))

  (set! entry/c-kernel/system-waitpid-return
        (foreign-procedure "Sschemeapp_system_waitpid_return" (int) int))
  )

;;
;; -- Calculating load paths
;;

;; Calculate the full path to the application library.
(define (entry/init/get-clib-path libdir ext)
  (string-append
     libdir "/"
     build-time-appname "-clib-v" build-time-version
     "." ext))

;; Load all the C libraries necessary for the application to run. This isn't
;; directly application-specific; it simply loads the given 'clib' library
;; bundle.
(define (entry/init/clib)
  (let* ([libdir (getenv "APP_RTS_CLIBDIR")]
         [loader (lambda (ext)
                   (load-shared-object
                    (entry/init/get-clib-path libdir ext)))])
    ;; Load the companion C library. The machine type ends with the operating
    ;; system: ta6le, tarm64osx, ti3nt and so on.
    (let* ([mt (symbol->string (machine-type))]
           [os? (lambda (os)
                  (let ([n (string-length mt)] [k (string-length os)])
                    (and (>= n k) (string=? os (substring mt (- n k) n)))))])
      (cond
       [(os? "osx") (loader "dylib")]
       [(os? "nt")  (loader "dll")]
       [(or (os? "le") (os? "fb") (os? "ob") (os? "nb") (os? "s2"))
        (loader "so")]
       [else (error 'entry/init/clib "unknown operating system" mt)]))
    ;; Load the C Primitives
    (entry/init/load-c-primitives)))

;; -----------------------------------------------------------------------------
;; -- Runtime statistics

;; post-main hook, used to dump debugging formation. Does nothing by default.
(define entry/hook/post-main
  (lambda () (void)))

;; Whether we should enable heap object counting, and print object stats at
;; the end of the program
(define (entry/stat/object-counting?)
  (and is-debug-build? (getenv "OBJCNT")))

;; Print out object counts in a nice manner.
;;
;; TODO FIXME (aseipp): finish object counting code
(define entry/stat/print-object-counts
  (lambda ()
    (printf "Object records:\n")
    (let loop ([i 0] [objects (object-counts)])
      (unless (null? objects)
              (let*-values ([(object) (car objects)]
                            [(type) (car object)]
                            [(extra) (cadr object)]
                            [(generation) (car extra)]
                            [(count) (cadr extra)]
                            [(bytes) (cddr extra)])
        (begin
          (printf "    - ~d: ~a ~a ~d ~d\n" i type generation count bytes)
          (loop (+ i 1) (cdr objects))))))
    ))

;; Print out the runtime statistics for the executable.
(define (entry/stat/print-runtime-stats)
  (let*-values ([(maj min patch) (scheme-version-number)])
    (printf "\nRuntime info:\n")
    (printf "    app v~a ~a/~a v~d.~d.~d, threaded = ~a, pid = ~a\n"
            build-time-version
            (if (petite?) "petite" "scheme")
            (machine-type)
            maj min patch
            (if (threaded?) "YES" "NO")
            (get-process-id))
    (printf "    profiled: ~a, debug build: ~a, ~d cores\n"
            is-profile-build?
            is-debug-build?
            (get-num-cores))
    (printf "Runtime stats:\n")
    (display-statistics)
    (printf "    ~a initial bytes allocated, ~a current bytes allocated\n"
            (initial-bytes-allocated)
            (current-memory-bytes))))

;; Dump the profiling application data in coverage report format.
(define (entry/stat/dump-coverage-data profile-data)
  ;; Convenient accessors
  (define (first l) (list-ref l 1))
  (define (zeroth l) (list-ref l 0))
  (define (fourth l) (list-ref l 4))

  ;; Deduplicate a list, without caring about sorting.
  (define (dedupe lst)
    (fold-right (lambda (e a)
             (if (not (member e a))
                 (cons e a)
                 a))
           '()
           lst))

  ;; Count the number of lines in a file
  (define (wc-l file)
    (call-with-input-file file
      (lambda (p)
        (let loop ([i 0] [c (read-char p)])
          (if (eof-object? c)
              i
              (if (equal? c #\newline)
                  (loop (+ i 1) (read-char p))
                  (loop i (read-char p))))))))

  ;; Some profile data accessors and helpers
  (define (filename l) (first l))
  (define (lineno l) (fourth l))
  (define (executed? l) (> (zeroth l) 0))
  (define (report l) (if (executed? l) #\C #\U))

  ;; Get the source files and an initial hash table
  (define all-files (dedupe (map filename profile-data)))
  (define htbl (make-eqv-hashtable (length all-files)))

  ;; Helpful data-munging utilities
  (define (vector->covmap vec)
    (list->string (vector->list vec)))
  (define (htbl->covmap key)
    (vector->covmap (hashtable-ref htbl key "UNKNOWN")))

  ;; Report file
  (when-test
   (define sscov-file "build/test.sscov")
   (define sscov-file (string-append "build/" build-time-appname ".sscov")))

  ;; Insert all the initial hash table values
  (fold-right
   (lambda (file _)
     (define sz (wc-l file))
     (define v (make-vector sz #\N))

     (fold-right
      (lambda (record _)
        (if (equal? (filename record) file)
            (begin
              ;;(printf "~a ~a: ~a\n" file sz record)
              (vector-set! v (- (lineno record) 1) (report record)))))
      '()
      profile-data)

     (hashtable-set! htbl file v))
   '()
   all-files)

  ;; Dump all the reports
  (if (file-exists? sscov-file)
      (delete-file sscov-file))

  (with-output-to-file sscov-file
    (lambda ()
      (fold-right
       (lambda (file _)
         (printf "~a ~a\n" file (htbl->covmap file)))
       '()
       all-files))))

;; Dump the application profile data, if this is a profiling build and the
;; PROFILE_HTML or PROFILE_DATA environment variables are set.
(define (entry/stat/dump-profile-data)
  (cond
   ;; Raw data dump, for reprofiling
   [(and is-profile-build? (getenv "PROFILE_DATA"))
    (profile-dump-data (string-append build-time-appname ".pd"))]

   ;; HTML reports
   [(and is-profile-build? (getenv "PROFILE_HTML")) (profile-dump-html)]

   ;; Sexpr-based reports for easy processing
   [(and is-profile-build? (getenv "PROFILE_LIST"))
    (with-output-to-file
        (string-append "build/" build-time-appname ".plist")
      (lambda () (printf "~a" (profile-dump-list))))]

   ;; Coverage reports, based on the list processing, using the
   ;; Phabricator/Arcanist coverage support.
   [(and is-profile-build? (getenv "PROFILE_COVERAGE"))
    (entry/stat/dump-coverage-data (profile-dump-list))
    ]
   [else (void)]))

;; Pre-startup initialization. This initializes the runtime
;; by loading any necessary shared objects. It also checks for
;; the RTSOPTS environment variable to see if it should install
;; a hook for reporting runtime statistics.
(define entry/init/app
  (lambda ()
    (let*-values ([(rtsopts) (getenv "RTSOPTS")]
                  [(object-counting?) (entry/stat/object-counting?)])

      ;; Initialize the application specific library and all C code
      (entry/init/clib)

      ;; Call the C breakpoint, so that the user may start debugging
      ;; and set further breakpoints on loaded shared libraries here.
      ;;
      ;; However, if the application is being loaded into a Chez REPL,
      ;; then this function won't exist. In this case, it doesn't do
      ;; anything.
      (entry/c-kernel/breakpoint)

      ;; The following call is provided by the user
      (app/initialize/c) ;; USER CALL

      ;; RTSOPTS can be set to anything, for now.
      (if rtsopts
          (begin
            ;; Set the hook to a function which will collect
            ;; statistics and report them in a detailed manner,
            ;; after the main function exits.
            (set! entry/hook/post-main
                  (lambda ()
                    (entry/stat/print-runtime-stats)
                    (if object-counting? (entry/stat/print-object-counts))))
            ;; Enable object count reporting. This slows collection,
            ;; but you asked for it.
            (if object-counting? (enable-object-counts #t)))))
    ;; Done
    (void)))

;; -----------------------------------------------------------------------------
;; -- User utilities

;; The following functions are 'user utilities' which are available and intended
;; to be used by the code in `main.ss'

;; Execute a given action, only when used with the threaded Chez build. This is
;; syntax, defined as a macro -- thus the check for threaded compatibility
;; happens at compile time.
(define-syntax when-threaded
  (lambda (x)
    (syntax-case x ()
      [(_ e ...)
       (if (threaded?)
           #'(begin (void) e ...)
           #'(void))])))

;; Set the thread affinity, and pin a thread to a specific core.
(define (thread-set-affinity core)
   (entry/c-kernel/set-thread-affinity core))

;; Get the number of processor cores.
(define (get-num-cores)
  (entry/c-kernel/get-num-cores))

;; Time some action and return the amount of time it took,
;; along with the result.
(define (timeit k)
  (let* ([start   (current-time 'time-monotonic)]
         [result  (k)]
         [end     (current-time 'time-monotonic)]
         [delta   (time-difference end start)])
    (values delta result)))

;; Execute a debugger breakpoint, but only when we've booted with the Chez
;; runtime, and we're in a debugging build.
(define (dbg-break)
  (if (and is-debug-build?
           (getenv "RTS_BOOT_CHEZ"))
      (break)))

(define (waitpid-return pid)
  (entry/c-kernel/system-waitpid-return pid))

;; Certain operations, such as 'fork-thread' etc, are only available on threaded
;; Chez scheme builds. Similar operations are defined here.
(when-threaded

;; Set the name of the executing thread to the given string ${name}.
;; This function only works on Linux. On non-Linux systems, it does nothing.
(define (thread-setname name)
  (entry/c-kernel/set-thread-name name))

;; Fork a thread, and give it a name before executing the given continuation.
(define (fork-thread-setname name k)
  (fork-thread
   (lambda ()
     (thread-setname name)
     (k))))

) ;; end of when-threaded

;; -----------------------------------------------------------------------------
;; -- Boot file entry point

;; Suppress the Chez greeting at boot time.
(suppress-greeting #t)

;; Entry which can be used by the REPL, C kernel, etc to start the application
;; with a given set of arguments.
(scheme-start
 (lambda args
   ;; Initialize foreign libraries and functions. Also sets up hooks
   ;; for runtime reports after execution.
   (entry/init/app)

   ;; Run main application, and get the return value.
   (let ([result (app/main args)]) ;; USER CALL
     ;; Run post-main hooks (statistical reports, etc)
     (entry/hook/post-main)

     ;; Dump profiling report, if enabled
     (entry/stat/dump-profile-data)

     ;; Done. The integer value returned by 'scheme-start' is returned as
     ;; the exit code of the C kernel. For sanity, just make sure the right
     ;; value type is returned.
     (if (integer? result)
         result
         (begin
           (printf "ERROR: app/main returned non-integer result (~a)\n" result)
           -1)))))

;; -----------------------------------------------------------------------------
;; -- El fin

;; Local Variables:
;; mode: scheme
;; fill-column: 80
;; indent-tabs-mode: nil
;; c-basic-offset: 2
;; buffer-file-coding-system: utf-8-unix
;; End:
