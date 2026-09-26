dnl SPDX-FileCopyrightText: 2026 Austin Seipp
dnl SPDX-License-Identifier: Apache-2.0
syscmd(`exit 0')dnl
ifelse(sysval, `127', `m4exit(0)', `m4exit(1)')dnl
