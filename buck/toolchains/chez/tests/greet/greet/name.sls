;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(library (demo greet name)
  (export name)
  (import (chezscheme))
  (define (name) "chez"))
