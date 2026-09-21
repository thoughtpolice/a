# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

cat=$1
cmp=$2
case $3 in
binary)
    printf 'a\000\001\377z' > first
    printf '\376\200x\000' > second
    printf 'a\000\001\377z\376\200x\000a\000\001\377z' > expected
    "$cat" first - first < second > actual
    "$cmp" actual expected
    # Read stdin once even when '-' appears twice.
    "$cat" - - < expected > actual
    "$cmp" actual expected
    ;;
format)
    printf 'one\t\001\177\200\377\n\n\nend' > input
    "$cat" -As input > actual
    printf 'one^I^A^?M-^@M-^?$\n$\nend' > expected
    "$cmp" actual expected
    ;;
number)
    printf 'a\n\nb\n' > first
    printf '\nc\n' > second
    "$cat" -n first second > actual
    printf '     1\ta\n     2\t\n     3\tb\n     4\t\n     5\tc\n' > expected
    "$cmp" actual expected
    "$cat" -nb first second > actual
    printf '     1\ta\n\n     2\tb\n\n     3\tc\n' > expected
    "$cmp" actual expected
    ;;
errors)
    printf 'kept\n' > input
    if "$cat" missing input > actual; then exit 1; else test "$?" -eq 1; fi
    "$cmp" actual input
    if "$cat" input >&-; then exit 2; else test "$?" -eq 1; fi
    if "$cat" input >> input; then exit 3; else test "$?" -eq 1; fi
    if "$cat" --invalid-option; then exit 4; else test "$?" -eq 1; fi
    ;;
*) exit 5 ;;
esac
printf 'passed\n' > passed
