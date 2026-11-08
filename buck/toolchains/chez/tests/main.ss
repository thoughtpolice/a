;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(import (chezscheme) (demo shout))
(suppress-greeting #t)
(scheme-start
 (lambda args
   (printf "~a ~s\n" (shout) args)
   0))
