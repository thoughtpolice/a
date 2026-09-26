dnl SPDX-FileCopyrightText: 2026 Austin Seipp
dnl SPDX-License-Identifier: Apache-2.0
define(`twice', `$1 $1')dnl
twice(`hello')
eval(7*(4+2))
patsubst(`a1 b22 c333', `[0-9]+', `X')
format(`%d %.2f', `12345', `1.25')
pushdef(`twice', `inner')dnl
twice
popdef(`twice')dnl
twice(`outer')
include(`included.m4')dnl
m4wrap(`wrapped
')dnl
