# Native profiling data reader and call decoder tests.
# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
set -eu
kind=$1
gprof=$2
program=$3
data=$4
case $kind in
counts)
    out=$($gprof -b -p "$program" "$data")
    case "$out" in *75.00*"7"*profile_child*25.00*profile_parent*) ;; *) printf '%s\n' "$out"; exit 11;; esac
    $gprof -s "$program" "$data" "$data"
    out=$($gprof -b -p "$program" gmon.sum)
    case "$out" in *"14"*profile_child*) ;; *) printf '%s\n' "$out"; exit 12;; esac
    ;;
backward-call)
    out=$($gprof -c -d256 -b "$program" "$data")
    case "$out" in *destpc*"(profile_child)"*) ;; *) printf '%s\n' "$out"; exit 21;; esac
    ;;
explanations)
    out=$($gprof "$program" "$data")
    case "$out" in *"Flat profile:"*"This table describes the call tree"*) ;; *) exit 31;; esac
    out=$($gprof --traditional "$program" "$data")
    case "$out" in *"call graph profile:"*"the index of the function"*) ;; *) printf '%s\n' "$out"; exit 32;; esac
    ;;
diagnostics)
    printf 'gmon\001\000\000\000' > truncated
    if $gprof "$program" truncated; then exit 41; fi
    ;;
*) exit 90;;
esac
printf 'ok\n' > result
