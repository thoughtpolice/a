# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu
value='é中Ω'
[ "$(printf '%s' "$value")" = 'é中Ω' ]
[[ 'é' == ? ]]
[[ '中' == [[:alpha:]] ]]
printf 'multibyte preservation and patterns pass\n'
