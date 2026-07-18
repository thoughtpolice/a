#!/usr/bin/env bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
IFS=$'\n\t'

die() {
    printf 'update-content: %s\n' "$*" >&2
    exit 1
}

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" \
    || die 'could not resolve the script directory'
readonly script_dir
command -v git >/dev/null 2>&1 || die 'required command not found: git'
repository="$(git -C "${script_dir}/.." rev-parse --show-toplevel 2>/dev/null)" \
    || die 'could not resolve the repository root'
readonly repository
readonly buck2="${repository}/buck/bin/buck2"

required_commands=(
    ar
    awk
    bash
    bindgen
    bzip2
    cargo
    cargo-clippy
    clang
    clang++
    clangd
    clippy-driver
    curl
    diff
    dotslash
    file
    find
    getent
    git
    grep
    gzip
    ip
    jq
    ld
    ld.lld
    ldd
    less
    mold
    node
    npm
    npx
    ps
    rust-analyzer
    rustc
    rustfmt
    sed
    ssh
    sudo
    tar
    unzip
    watchman
    wget
    which
    xz
    zip
    zstd
)

missing_command=false
for command_name in "${required_commands[@]}"; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
        printf 'update-content: required command not found: %s\n' "${command_name}" >&2
        missing_command=true
    fi
done
if [[ "${missing_command}" == true ]]; then
    exit 1
fi

[[ -x "${buck2}" ]] || die "Buck2 launcher is not executable: ${buck2}"

readonly expected_bindgen_version='bindgen 0.72.1'
actual_bindgen_version="$(bindgen --version)"
if [[ "${actual_bindgen_version}" != "${expected_bindgen_version}" ]]; then
    die "expected ${expected_bindgen_version}, found ${actual_bindgen_version}"
fi

shopt -s nullglob
rust_targets=(
    x86_64-unknown-linux-gnu
    x86_64-unknown-uefi
    aarch64-unknown-linux-gnu
    aarch64-unknown-uefi
)
for rust_target in "${rust_targets[@]}"; do
    target_libdir="$(rustc --print target-libdir --target "${rust_target}")" \
        || die "rustc does not support target ${rust_target}"
    target_core_libraries=("${target_libdir}"/libcore-*.rlib)
    target_std_libraries=("${target_libdir}"/libstd-*.rlib)
    if (( ${#target_core_libraries[@]} == 0 || ${#target_std_libraries[@]} == 0 )); then
        die "Rust standard libraries are missing for target ${rust_target}"
    fi
done

(
    cd -- "${repository}"
    "${buck2}" run root//.vscode/extensions/depot-buck2:build
)
