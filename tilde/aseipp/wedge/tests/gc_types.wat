;; SPDX-FileCopyrightText: © 2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0

(module
  (type $pair (struct
    (field $first i32)
    (field $second (mut i64))))
  (type $vector (array (mut i32))))
