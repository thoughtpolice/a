;; shell.sls -- shells, Python, Starlark and other #-commented languages
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(library (quad ext shell)
  (export shell-syntax shell-mode)
  (import (chezscheme) (quad util) (quad text) (quad syntax) (quad buffer)
          (quad editor) (quad commands))

  (define shell-syntax
    (make-syntax
     'shell #f '("#") '() '(#\" #\') default-word-char?
     (keyword-table
      '(keyword "if" "then" "else" "elif" "fi" "for" "while" "do" "done" "case" "esac"
                "in" "function" "return" "local" "export" "set" "def" "class" "import"
                "from" "load" "lambda" "pass" "with" "as" "yield" "not" "and" "or")
      '(constant.builtin "True" "False" "None"))
     '() #f "# " "    "))

  (define shell-mode (define-major-mode! 'shell shell-syntax))

  (at-load
   (major-mode-hook-set! shell-mode
                         (lambda (b)
                           (set-local! 'indent-unit "    " b)))
   (add-auto-mode! '("sh" "bash" "zsh" "fish" "py" "bzl" "BUILD" "PACKAGE" "toml" "yaml" "yml" "nix" "Makefile" "mk" "rb" "pl" "conf" "ini") 'shell)))
