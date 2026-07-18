# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  clangCompiler,
  bashRuntime,
}:

let
  slimBindgenUnwrapped = pkgs.rust-bindgen-unwrapped.override {
    clang = clangCompiler;
  };
  bindgen = pkgs.rust-bindgen.override {
    bash = bashRuntime;
    rust-bindgen-unwrapped = slimBindgenUnwrapped;
  };
in
{
  inherit bindgen slimBindgenUnwrapped;
}
