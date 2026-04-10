#!/bin/sh
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Validate that all source files in the cellar bootstrap stage0-posix directory
# match the corresponding files in the upstream stage0-posix repository.
#
# Usage: ./check-upstream.sh /path/to/upstream/stage0-posix

set -e

UPSTREAM="$1"
CELLAR_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$UPSTREAM" ] || [ ! -d "$UPSTREAM" ]; then
    echo "Usage: $0 /path/to/upstream/stage0-posix"
    exit 1
fi

RESULT_FILE=$(mktemp)
trap 'rm -f "$RESULT_FILE"' EXIT
echo "0 0 0" > "$RESULT_FILE"

record_error() {
    read errors checked skipped < "$RESULT_FILE"
    echo "$((errors + 1)) $checked $skipped" > "$RESULT_FILE"
}

record_checked() {
    read errors checked skipped < "$RESULT_FILE"
    echo "$errors $((checked + 1)) $skipped" > "$RESULT_FILE"
}

record_skipped() {
    read errors checked skipped < "$RESULT_FILE"
    echo "$errors $checked $((skipped + 1))" > "$RESULT_FILE"
}

check_file() {
    cellar_file="$1"
    upstream_file="$2"

    if [ ! -f "$upstream_file" ]; then
        echo "MISSING UPSTREAM: $cellar_file -> $upstream_file"
        record_error
        return
    fi

    record_checked
    if ! diff -q "$cellar_file" "$upstream_file" > /dev/null 2>&1; then
        echo "MISMATCH: $cellar_file"
        echo "  cellar:   $cellar_file"
        echo "  upstream: $upstream_file"
        diff --unified=0 "$cellar_file" "$upstream_file" | head -20
        echo ""
        record_error
    fi
}

# Files known to be cellar-only (not from upstream).
# Custom tools live in cellar-extra/, not here.
is_cellar_only() {
    return 1
}

echo "=== Checking m2-libc against M2libc ==="
for f in $(find "$CELLAR_DIR/m2-libc" -type f \( -name '*.c' -o -name '*.h' -o -name '*.M1' -o -name '*.hex2' \) | sort); do
    rel="${f#$CELLAR_DIR/m2-libc/}"
    check_file "$f" "$UPSTREAM/M2libc/$rel"
done

echo "=== Checking m2-planet against M2-Planet ==="
for f in $(find "$CELLAR_DIR/m2-planet" -type f \( -name '*.c' -o -name '*.h' \) | sort); do
    rel="${f#$CELLAR_DIR/m2-planet/}"
    check_file "$f" "$UPSTREAM/M2-Planet/$rel"
done

echo "=== Checking m2-mesoplanet against M2-Mesoplanet ==="
for f in $(find "$CELLAR_DIR/m2-mesoplanet" -type f \( -name '*.c' -o -name '*.h' \) | sort); do
    rel="${f#$CELLAR_DIR/m2-mesoplanet/}"
    check_file "$f" "$UPSTREAM/M2-Mesoplanet/$rel"
done

echo "=== Checking mescc-tools against mescc-tools ==="
for f in $(find "$CELLAR_DIR/mescc-tools" -type f \( -name '*.c' -o -name '*.h' \) | sort); do
    rel="${f#$CELLAR_DIR/mescc-tools/}"
    check_file "$f" "$UPSTREAM/mescc-tools/$rel"
done

echo "=== Checking mescc-tools-extra against mescc-tools-extra ==="
for f in $(find "$CELLAR_DIR/mescc-tools-extra" -type f \( -name '*.c' -o -name '*.h' \) | sort); do
    if is_cellar_only "$f"; then
        echo "SKIP (cellar-only): $f"
        record_skipped
        continue
    fi
    rel="${f#$CELLAR_DIR/mescc-tools-extra/}"
    check_file "$f" "$UPSTREAM/mescc-tools-extra/$rel"
done

echo "=== Checking seeds/linux-amd64 against AMD64 + M2libc ==="
# The seed files map to various upstream locations:
#   bootstrap.c     -> M2libc/amd64/linux/bootstrap.c
#   cc.M1           -> AMD64/cc_amd64.M1
#   defs.M1         -> AMD64/amd64_defs.M1
#   libc-core.M1    -> AMD64/libc-core.M1
#   ELF.hex2        -> AMD64/ELF-amd64.hex2
#   hex0.hex0       -> AMD64/hex0_AMD64.hex0
#   hex1.hex0       -> AMD64/hex1_AMD64.hex0
#   hex2.hex1       -> AMD64/hex2_AMD64.hex1
#   catm.hex2       -> AMD64/catm_AMD64.hex2
#   M0.hex2         -> AMD64/M0_AMD64.hex2
SEEDS="$CELLAR_DIR/seeds/linux-amd64"

check_file "$SEEDS/bootstrap.c"  "$UPSTREAM/M2libc/amd64/linux/bootstrap.c"
check_file "$SEEDS/cc.M1"        "$UPSTREAM/AMD64/cc_amd64.M1"
check_file "$SEEDS/defs.M1"      "$UPSTREAM/AMD64/amd64_defs.M1"
check_file "$SEEDS/libc-core.M1" "$UPSTREAM/AMD64/libc-core.M1"
check_file "$SEEDS/ELF.hex2"     "$UPSTREAM/AMD64/ELF-amd64.hex2"
check_file "$SEEDS/hex0.hex0"    "$UPSTREAM/AMD64/hex0_AMD64.hex0"
check_file "$SEEDS/hex1.hex0"    "$UPSTREAM/AMD64/hex1_AMD64.hex0"
check_file "$SEEDS/hex2.hex1"    "$UPSTREAM/AMD64/hex2_AMD64.hex1"
check_file "$SEEDS/catm.hex2"    "$UPSTREAM/AMD64/catm_AMD64.hex2"
check_file "$SEEDS/M0.hex2"      "$UPSTREAM/AMD64/M0_AMD64.hex2"

echo "=== Checking seeds/linux-arm64 against AArch64 + M2libc ==="
# The seed files map to various upstream locations:
#   bootstrap.c     -> M2libc/aarch64/linux/bootstrap.c
#   cc.M1           -> AArch64/cc_aarch64.M1
#   defs.M1         -> AArch64/aarch64_defs.M1
#   libc-core.M1    -> AArch64/libc-core.M1
#   ELF.hex2        -> AArch64/ELF-aarch64.hex2
#   hex0.hex0       -> AArch64/hex0_AArch64.hex0
#   hex1.hex0       -> AArch64/hex1_AArch64.hex0
#   hex2.hex1       -> AArch64/hex2_AArch64.hex1
#   catm.hex1       -> AArch64/catm_AArch64.hex1   (note: .hex1, not .hex2)
#   M0.hex2         -> AArch64/M0_AArch64.hex2
SEEDS="$CELLAR_DIR/seeds/linux-arm64"

check_file "$SEEDS/bootstrap.c"  "$UPSTREAM/M2libc/aarch64/linux/bootstrap.c"
check_file "$SEEDS/cc.M1"        "$UPSTREAM/AArch64/cc_aarch64.M1"
check_file "$SEEDS/defs.M1"      "$UPSTREAM/AArch64/aarch64_defs.M1"
check_file "$SEEDS/libc-core.M1" "$UPSTREAM/AArch64/libc-core.M1"
check_file "$SEEDS/ELF.hex2"     "$UPSTREAM/AArch64/ELF-aarch64.hex2"
check_file "$SEEDS/hex0.hex0"    "$UPSTREAM/AArch64/hex0_AArch64.hex0"
check_file "$SEEDS/hex1.hex0"    "$UPSTREAM/AArch64/hex1_AArch64.hex0"
check_file "$SEEDS/hex2.hex1"    "$UPSTREAM/AArch64/hex2_AArch64.hex1"
check_file "$SEEDS/catm.hex1"    "$UPSTREAM/AArch64/catm_AArch64.hex1"
check_file "$SEEDS/M0.hex2"      "$UPSTREAM/AArch64/M0_AArch64.hex2"

echo "=== Summary ==="
read errors checked skipped < "$RESULT_FILE"
echo "Checked: $checked files"
echo "Skipped: $skipped cellar-only files"
echo "Errors:  $errors"

if [ "$errors" -gt 0 ]; then
    echo "FAILED: $errors files do not match upstream"
    exit 1
else
    echo "OK: all files match upstream"
    exit 0
fi
