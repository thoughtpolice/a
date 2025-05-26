# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # For installing non-standard rustc versions
    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ (import rust-overlay) ];
      };

      cross = import nixpkgs {
        crossSystem = { config = "aarch64-unknown-linux-gnu"; };
      };

      ourRustVersion = pkgs.rust-bin.selectLatestNightlyWith (toolchain: toolchain.complete.override {
        targets =
          [ "x86_64-unknown-linux-gnu"  "x86_64-unknown-uefi"
            "aarch64-unknown-linux-gnu" "aarch64-unknown-uefi"
          ];
      });

      llvmPackages = pkgs.llvmPackages_latest;

      ocamlPackages = pkgs.ocaml-ng.ocamlPackages_5_3;

      # these are needed in both devShell and buildInputs
      darwinDeps = with pkgs; lib.optionals stdenv.isDarwin [
        darwin.apple_sdk.frameworks.Security
        darwin.apple_sdk.frameworks.SystemConfiguration
        libiconv
      ];

      # these are needed in both devShell and buildInputs
      linuxDeps = with pkgs; [
        mold-wrapped
      ];
    in {
      devShells.default = pkgs.mkShell {
        packages = (with llvmPackages; [
          ourRustVersion
          lld
          clang
          clang-tools
          bolt
          lldb
        ]) ++ (with ocamlPackages; [
          ocaml
        ]) ++ (with pkgs; [
          # general utilities
          gdb qemu swtpm dotslash
          # vscode support
          nodejs
          # cargo tools
          cargo-edit
          # other stuff
          cargo-edit bloaty semgrep
        ]) ++ darwinDeps ++ linuxDeps;

        shellHook = with pkgs; ''
          export SEMGREP_ENABLE_VERSION_CHECK=0
          export SEMGREP_SEND_METRICS=off

          export RUST_BACKTRACE=1
          export RUSTFLAGS="-Zthreads=0"

        '' + lib.optionalString stdenv.isLinux ''
          export RUSTFLAGS+=" -C link-arg=-fuse-ld=mold -C link-arg=-Wl,--compress-debug-sections=zstd"

        '' + lib.optionalString stdenv.isDarwin ''
          # work around https://github.com/nextest-rs/nextest/issues/267
          export DYLD_FALLBACK_LIBRARY_PATH=$(${ourRustVersion}/bin/rustc --print sysroot)/lib
          # use new fast macOS linker
          export RUSTFLAGS+=" -C link-arg=-fuse-ld=/usr/bin/ld -C link-arg=-ld_new"
        '';
      };
    });
}
