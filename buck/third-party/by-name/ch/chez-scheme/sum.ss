;; sum.ss -- a script for test-install.ss: print its arguments' sum
;;
;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(import (chezscheme))
(printf "~a\n" (apply + (map string->number (command-line-arguments))))
