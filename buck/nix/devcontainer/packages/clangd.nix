# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  clangCompiler,
  slimLlvmPackages,
}:

let
  # This is the header-path behavior from Nixpkgs' clang-tools wrapper, reduced
  # to the only editor tool in the image contract. In particular, it avoids the
  # Python closure used by the package's ancillary helper scripts.
  clangd = pkgs.writeShellScriptBin "clangd" ''
    build_c_path() {
      local path after
      while (( $# )); do
        case "$1" in
          -isystem)
            shift
            path="$path''${path:+:}$1"
            ;;
          -idirafter)
            shift
            after="$after''${after:+:}$1"
            ;;
        esac
        shift
      done
      echo "$path''${after:+:}$after"
    }

    build_cxx_path() {
      local path after
      while (( $# )); do
        case "$1" in
          -isystem|-cxx-isystem)
            shift
            path="$path''${path:+:}$1"
            ;;
          -idirafter)
            shift
            after="$after''${after:+:}$1"
            ;;
        esac
        shift
      done
      echo "$path''${after:+:}$after"
    }

    extend_c_path=true
    for argument in "$@" ''${CLANGD_FLAGS:-}; do
      if [[ "$argument" == --query-driver* ]]; then
        extend_c_path=false
      fi
    done

    if [[ "$extend_c_path" == true ]]; then
      export C_INCLUDE_PATH="''${CPATH:-}''${CPATH:+:}$(
        build_c_path ''${NIX_CFLAGS_COMPILE:-} \
          $(<${clangCompiler}/nix-support/libc-cflags)
      )"
      export CPLUS_INCLUDE_PATH="''${CPLUS_INCLUDE_PATH:-}''${CPLUS_INCLUDE_PATH:+:}$(
        build_cxx_path ''${NIX_CFLAGS_COMPILE:-} \
          $(<${clangCompiler}/nix-support/libcxx-cxxflags) \
          $(<${clangCompiler}/nix-support/libc-cflags)
      )"
    fi

    exec ${slimLlvmPackages.libclang}/bin/clangd "$@"
  '';
in
{
  inherit clangd;
}
