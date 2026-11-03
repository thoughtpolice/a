# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Run by smoke.sh inside the devcontainer, with no network: everything it
# checks has to work from the image alone.

set -euo pipefail
set -x

# The shell contract: dash as /bin/sh, a sticky /tmp, and root.
test "$(readlink /bin/sh)" = dash
test "$(stat -c %a /tmp)" = 1777
test "$(stat -c %a /var/tmp)" = 1777
test "$(id -u)" = 0
getent passwd root >/dev/null

# The marker doctor.py looks for.
test -f /etc/depot/devcontainer

# Buck2's machine-wide configuration picks a file watcher that's there.
grep -Fx 'file_watcher = fs_hash_crawler' /etc/buckconfig

# Outside a checkout the launchers say so instead of failing obscurely.
cd /
if buck2 --version 2>/tmp/launcher.err; then exit 1; fi
grep -F 'no checkout with buck/bin/buck2' /tmp/launcher.err
dotslash --version

# Every tool buck/toolchains/cxx and rust run by name.
for tool in clang clang++ lld ld.lld llvm-ar ar nm objcopy objdump ranlib strip \
        mold rustc rustdoc clippy-driver rustfmt cargo bindgen python3 git; do
    command -v "$tool"
done

work=$(mktemp -d)
cd "$work"

# Wolfi's distro flags stay out of clang: no -O2 or _FORTIFY_SOURCE unless
# a build asks for them.
clang -dM -E -x c /dev/null > macros
if grep -q '__OPTIMIZE__\|_FORTIFY_SOURCE' macros; then exit 1; fi

# C and C++, linked the way the cxx toolchain links on Linux.
printf '#include <stdio.h>\nint main(void) { puts("c"); return 0; }\n' > hello.c
clang -fuse-ld=mold -Wl,--emit-relocs hello.c -o hello-c
test "$(./hello-c)" = c
printf '#include <iostream>\nint main() { std::cout << "c++\\n"; }\n' > hello.cc
clang++ -std=gnu++17 -fuse-ld=mold hello.cc -o hello-cc
test "$(./hello-cc)" = c++
clang++ -fuse-ld=lld hello.cc -o hello-cc-lld
test "$(./hello-cc-lld)" = c++

# The sanitizer runtimes fozzie-asan links statically.
clang -fsanitize=address,undefined -static-libsan -fuse-ld=lld hello.c -o hello-asan
test "$(./hello-asan)" = c

# Rust, with std for every target the toolchain builds.
printf 'fn main() { println!("rust"); }\n' > hello.rs
rustc -Zthreads=1 -Clinker=clang -Clink-arg=-fuse-ld=mold hello.rs -o hello-rs
test "$(./hello-rs)" = rust
printf '#![no_std]\npub fn f() -> u32 { 1 }\n' > lib.rs
for target in aarch64-unknown-linux-gnu x86_64-unknown-uefi aarch64-unknown-uefi \
        wasm32-unknown-unknown; do
    rustc --edition 2021 --crate-type rlib --target "$target" lib.rs -o "lib-$target.rlib"
done

# bindgen at the version boringssl checks, loading clang-23's libclang.
test "$(bindgen --version)" = "bindgen 0.72.1"
printf 'int smoke_add(int a, int b);\n' > smoke.h
bindgen smoke.h --allowlist-function smoke_add -o smoke.rs
grep -q 'pub fn smoke_add' smoke.rs

echo "devcontainer smoke: ok"
