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

      ourRustVersion = pkgs.rust-bin.selectLatestNightlyWith (toolchain: toolchain.complete);

      llvmPackages = pkgs.llvmPackages_latest;
      ocamlPackages = pkgs.ocaml-ng.ocamlPackages_5_3;

      # these are needed in both devShell and buildInputs
      darwinDeps = with pkgs; lib.optionals stdenv.isDarwin [ ];

      # these are needed in both devShell and buildInputs
      linuxDeps = with pkgs; lib.optionals stdenv.isLinux [
        mold-wrapped
      ];
    in {
      devShells.default = pkgs.mkShell {
        packages = (with llvmPackages; [
          lld
          clang
          clang-tools
          bolt
          lldb
        ]) ++ (with ocamlPackages; [
          ocaml
        ]) ++ (with pkgs; [
          ourRustVersion
          # general utilities
          gdb qemu swtpm dotslash unzip
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
        '';
      };
    });
}
