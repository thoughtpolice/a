# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  lib,
  slimLlvmPackages,
  binutilsRuntime,
  grepRuntime,
}:

let
  # GCC's libgcc_s linker script falls back to -lgcc for a small set of
  # compiler builtins. The equivalent compiler-rt archive is already required
  # by Clang, so expose it under that compatibility name instead of retaining
  # the complete GCC compiler solely for its static libgcc.a.
  compilerRtGccCompat = pkgs.runCommand "compiler-rt-libgcc-compat" { } ''
    mkdir -p "$out/lib"
    builtins=(
      ${slimLlvmPackages.compiler-rt}/lib/linux/libclang_rt.builtins-*.a
    )
    test "''${#builtins[@]}" -eq 1
    ln -s "''${builtins[0]}" "$out/lib/libgcc.a"
  '';
  libstdcxxLibcxxCompat = pkgs.runCommand "libstdcxx-libcxx-compat" { } ''
    mkdir -p "$out/lib"
    # The repository's portable Buck rules explicitly request -lstdc++, while
    # this size-focused Clang wrapper intentionally compiles against libc++.
    # Resolve that generic C++ runtime request to the ABI that supplied the
    # headers, without carrying the complete GCC compiler just for headers.
    ln -s ${slimLlvmPackages.libcxx}/lib/libc++.so \
      "$out/lib/libstdc++.so"
    ln -s ${slimLlvmPackages.libcxx}/lib/libc++.so.1 \
      "$out/lib/libc++.so.1"
    ln -s ${slimLlvmPackages.libcxx}/lib/libc++abi.so.1 \
      "$out/lib/libc++abi.so.1"
  '';

  # The default Clang wrapper includes the complete GCC compiler just to get
  # libstdc++ headers. This LLVM-native wrapper uses libc++ and keeps only the
  # GCC runtime library needed by the Clang executables themselves.
  clangCompiler =
    (slimLlvmPackages.clangUseLLVM.override {
      bintools = binutilsRuntime;
      gnugrep = grepRuntime;
      # clangUseLLVM is defined against its scope's targetLlvmPackages before
      # this local override scope is applied. Replace both the propagated
      # runtime packages and their wrapper flags so the stock sanitizer-heavy
      # compiler-rt cannot leak back into the image closure.
      extraPackages = [
        slimLlvmPackages.compiler-rt
        slimLlvmPackages.libunwind
        libstdcxxLibcxxCompat
      ];
      nixSupport = {
        cc-cflags = [
          "-rtlib=compiler-rt"
          "-Wno-unused-command-line-argument"
          "-B${slimLlvmPackages.compiler-rt}/lib"
          "--unwindlib=libunwind"
        ];
        cc-ldflags = [
          "-L${slimLlvmPackages.libunwind}/lib"
        ];
      };
      useCcForLibs = false;
      gccForLibs = null;
    }).overrideAttrs
      (previousAttrs: {
        # cc-wrapper's generated hook does not end with a newline.
        postFixup =
          (previousAttrs.postFixup or "")
          + "\n"
          + ''
            # clangUseLLVM's resource-root hook also captures the original target
            # package scope. Repoint its runtime directory at the same minimal
            # compiler-rt selected in extraPackages and nixSupport above.
            rm -f "$out/resource-root/lib" "$out/resource-root/share"
            ln -s ${slimLlvmPackages.compiler-rt}/lib \
              "$out/resource-root/lib"

            cat >> "$out/nix-support/cc-ldflags" <<'EOF'
            -L${libstdcxxLibcxxCompat}/lib
            -L${slimLlvmPackages.libcxx}/lib
            -L${compilerRtGccCompat}/lib
            -L${lib.getLib pkgs.stdenv.cc.cc}/lib
            EOF
          '';
      });
in
{
  inherit clangCompiler compilerRtGccCompat libstdcxxLibcxxCompat;
}
