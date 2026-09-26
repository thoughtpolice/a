# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
BEGIN { a[1] = "first"; a[2] = "second"; print join(a, 1, 2, ":") }
