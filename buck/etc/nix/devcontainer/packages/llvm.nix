# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs, lib }:

let
  llvmPackages = pkgs.llvmPackages_latest;
  llvmTargets = [
    "AArch64"
    "X86"
  ];

  # LLVM and Clang install every static component archive even though Nixpkgs
  # links their tools against the aggregate shared libraries. Keep LLVM's real
  # archives in its development output so Clang and LLD can build against them,
  # but do not retain them in the runtime library output. Clang's archives have
  # no downstream consumer in this image and can be deleted after its build.
  moveStaticArchivesToDev = previousAttrs: {
    postInstall = (previousAttrs.postInstall or "") + ''
      mkdir -p "$dev/lib/llvm-static"
      find "$lib/lib" -maxdepth 1 -type f -name '*.a' \
        -exec mv -t "$dev/lib/llvm-static" {} +

      # Nixpkgs' output splitter writes absolute paths into the generated CMake
      # exports. Point only the static targets at their new development path;
      # shared imports must continue to resolve from the runtime lib output.
      find "$dev/lib/cmake/llvm" -type f -exec \
        sed -i -E \
          "s|$lib/lib/(lib[^\" ]+\\.a)|$dev/lib/llvm-static/\\1|g" \
          {} +
    '';
  };
  slimCompilerRtCmakeFlags = [
    # The wrapper needs compiler-rt's builtins and CRT objects for ordinary
    # C/C++ links. Dynamic analysis, fuzzing, instrumentation, and profiling
    # runtimes are outside this editor-core image's contract.
    (lib.cmakeBool "COMPILER_RT_BUILD_SANITIZERS" false)
    (lib.cmakeBool "COMPILER_RT_BUILD_XRAY" false)
    (lib.cmakeBool "COMPILER_RT_BUILD_LIBFUZZER" false)
    (lib.cmakeBool "COMPILER_RT_BUILD_MEMPROF" false)
    (lib.cmakeBool "COMPILER_RT_BUILD_ORC" false)
    (lib.cmakeBool "COMPILER_RT_BUILD_PROFILE" false)
    (lib.cmakeBool "COMPILER_RT_BUILD_CTX_PROFILE" false)
  ];
  slimLlvmPackages = llvmPackages.overrideScope (
    final: previous: {
      compiler-rt-libc = previous.compiler-rt-libc.override {
        devExtraCmakeFlags = slimCompilerRtCmakeFlags;
      };

      libllvm =
        (previous.libllvm.override {
          enablePFM = false;
          enablePolly = false;
          enableTerminfo = false;
          devExtraCmakeFlags = [
            (lib.cmakeFeature "LLVM_TARGETS_TO_BUILD" (lib.concatStringsSep ";" llvmTargets))
            (lib.cmakeBool "LLVM_ENABLE_FFI" false)
            (lib.cmakeBool "LLVM_ENABLE_LIBXML2" false)
          ];
        }).overrideAttrs
          (
            previousAttrs:
            (moveStaticArchivesToDev previousAttrs)
            // {
              cmakeBuildType = "MinSizeRel";
              postFixup = (previousAttrs.postFixup or "") + ''
                find "$lib/lib" -type f | while IFS= read -r file; do
                  if ${pkgs.binutils}/bin/readelf -h "$file" >/dev/null 2>&1; then
                    ${pkgs.binutils}/bin/strip --strip-unneeded "$file"
                  fi
                done
              '';
            }
          );

      libclang =
        (previous.libclang.override {
          inherit (final) libllvm;
          devExtraCmakeFlags = [
            # The standalone static analyzer is not part of the image contract. Its
            # libraries otherwise become part of the monolithic libclang-cpp even
            # when none of the retained editor/compiler tools use the analyzer.
            (lib.cmakeBool "CLANG_ENABLE_STATIC_ANALYZER" false)
            (lib.cmakeBool "CLANG_TIDY_ENABLE_STATIC_ANALYZER" false)
            # clangd still provides parsing, indexing, completion, diagnostics, and
            # --check, without duplicating every clang-tidy module in its executable.
            (lib.cmakeBool "CLANGD_TIDY_CHECKS" false)
          ];
        }).overrideAttrs
          (previousAttrs: {
            postPatch = (previousAttrs.postPatch or "") + ''
                substituteInPlace lib/CMakeLists.txt \
                  --replace-fail \
                    'add_subdirectory(StaticAnalyzer)' \
                    'if(CLANG_ENABLE_STATIC_ANALYZER)
                  add_subdirectory(StaticAnalyzer)
                endif()'

                # libclang's C API objects need the same Clang internals already exported by
                # libclang-cpp. Reuse that exact-version shared library instead of embedding
                # a second copy of its component archives.
                substituteInPlace tools/libclang/CMakeLists.txt \
                  --replace-fail \
                    'if (HAVE_LIBDL)' \
                    'if(CLANG_LINK_CLANG_DYLIB)
                set(LIBS clang-cpp)
              endif()

              if (HAVE_LIBDL)'
            '';
            cmakeBuildType = "MinSizeRel";
            postInstall =
              (lib.replaceString "mv $out/bin/{git-clang-format,scan-view} $python/bin" ''
                mv "$out/bin/git-clang-format" "$python/bin/"
                if [[ -e "$out/bin/scan-view" ]]; then
                  mv "$out/bin/scan-view" "$python/bin/"
                fi
              '' (previousAttrs.postInstall or ""))
              + ''
                find "$lib/lib" -maxdepth 1 -type f -name '*.a' -delete

                # The editor consumes clangd, while Buck supplies specialized compiler
                # tooling hermetically. Avoid retaining every clang-tools-extra binary.
                for tool in "$out"/bin/*; do
                  case "$(basename "$tool")" in
                    clang|clang++|clang-[0-9]*|clang-cl|clang-cpp|clangd|cpp) ;;
                    *) rm -f "$tool" ;;
                  esac
                done
              '';
            postFixup = (previousAttrs.postFixup or "") + ''
              for directory in "$out/bin" "$lib/lib"; do
                find "$directory" -type f | while IFS= read -r file; do
                  if ${pkgs.binutils}/bin/readelf -h "$file" >/dev/null 2>&1; then
                    ${pkgs.binutils}/bin/strip --strip-unneeded "$file"
                  fi
                done
              done
            '';
          });

      lld =
        (previous.lld.override {
          inherit (final) libllvm;
        }).overrideAttrs
          (previousAttrs: {
            cmakeBuildType = "MinSizeRel";
            postInstall = (previousAttrs.postInstall or "") + ''
              for linker in lld lld-link ld64.lld wasm-ld; do
                if [[ -e "$out/bin/$linker" ]]; then
                  rm "$out/bin/$linker"
                  ln -s ld.lld "$out/bin/$linker"
                fi
              done
            '';
            postFixup = (previousAttrs.postFixup or "") + ''
              find "$out/bin" -type f | while IFS= read -r file; do
                if ${pkgs.binutils}/bin/readelf -h "$file" >/dev/null 2>&1; then
                  ${pkgs.binutils}/bin/strip --strip-unneeded "$file"
                fi
              done
            '';
          });
    }
  );
in
{
  inherit llvmPackages slimLlvmPackages;
}
