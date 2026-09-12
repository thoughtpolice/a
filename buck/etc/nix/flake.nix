# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.zst";

    # For installing non-standard rustc versions
    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
    }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      outputsFor =
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ (import rust-overlay) ];
          };

          cross = import nixpkgs {
            crossSystem = {
              config = "aarch64-unknown-linux-gnu";
            };
          };

          ourRustVersion =
            (pkgs.rust-bin.selectLatestNightlyWith (
              toolchain:
              toolchain.complete.override {
                # Guest code for the game console SDK (tilde/aseipp/wlink) is
                # built for wasm32; the host toolchain needs that target's std.
                targets = [ "wasm32-unknown-unknown" ];
              }
            )).overrideAttrs
              (_: {
                # rust-overlay propagates nixpkgs' default `stdenv.cc` so rustc
                # can link out of the box. On Darwin that default LLVM is a
                # major version behind llvmPackages_latest, and as a propagated
                # dependency it lands first on PATH and last in the setup hooks,
                # shadowing the clang listed below. Propagate the matching clang
                # instead.
                depsHostHostPropagated = [ llvmPackages.clang ];
                propagatedBuildInputs = [ llvmPackages.clang ];
              });

          llvmPackages = pkgs.llvmPackages_latest;
          ocamlPackages = pkgs.ocaml-ng.ocamlPackages_5_5;

          dotnetSdk = pkgs.dotnetCorePackages.sdk_11_0;

          # This dotnet-trace build is published to the dotnet-tools feed
          # instead of nuget.org, so the package's nuget.org fetch is swapped
          # out for a direct fetch of the nupkg.
          dotnetTraceVersion = "10.0.731102";
          dotnetTrace =
            (pkgs.dotnetCorePackages.buildDotnetGlobalTool {
              pname = "dotnet-trace";
              version = dotnetTraceVersion;
              nugetHash = lib.fakeHash;
              executables = [ "dotnet-trace" ];
              dotnet-sdk = dotnetSdk;
              dotnet-runtime = dotnetSdk.runtime;
            }).overrideAttrs
              (_: {
                buildInputs = [
                  (pkgs.dotnetCorePackages.fetchNupkg {
                    pname = "dotnet-trace";
                    version = dotnetTraceVersion;
                    url = "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-tools/nuget/v3/flat2/dotnet-trace/${dotnetTraceVersion}/dotnet-trace.${dotnetTraceVersion}.nupkg";
                    hash = "sha256-BrnJ73Amfab5I92L6eGnV9acmANq+mtRVgTec1vt8K4=";
                    installable = true;
                  })
                ];
              });

          # these are needed in both devShell and buildInputs
          darwinDeps = with pkgs; lib.optionals stdenv.hostPlatform.isDarwin [ ];

          # these are needed in both devShell and buildInputs
          linuxDeps =
            with pkgs;
            lib.optionals stdenv.hostPlatform.isLinux [
              mold
            ];

          devcontainer = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
            import ./devcontainer-image.nix {
              inherit pkgs self system;
            }
          );
        in
        {
          packages = devcontainer.packages or { };
          checks = devcontainer.checks or { };

          # mkShell's own stdenv puts its compiler wrapper first on PATH, and
          # on Darwin that is nixpkgs' default LLVM, a major version behind
          # llvmPackages_latest, so `clang` and `ld.lld` came from different
          # releases. Building the shell on llvmPackages' stdenv keeps clang,
          # lld, and the wrapper's libc++ and compiler-rt flags on one release.
          devShells.default = (pkgs.mkShell.override { stdenv = llvmPackages.stdenv; }) {
            packages =
              (with llvmPackages; [
                lld
                clang
                clang-tools
                bolt
                lldb
                # The cxx toolchain archives WebAssembly objects with llvm-ar
                # by name; the compiler wrapper only provides `ar`, which on
                # Linux is GNU ar and cannot index them.
                llvm
              ])
              ++ (with ocamlPackages; [
                ocaml
              ])
              ++ (with pkgs; [
                ourRustVersion

                # general utilities
                gdb
                qemu
                swtpm
                dotslash
                unzip
                hunspell
                hunspellDicts."en_US-large"
                watchman

                # cargo tools
                cargo-edit
                bloaty
                rust-bindgen

                # other toolchains
                nodejs
                go_latest
                uv
                beam28Packages.erlang
                dotnetSdk
                dotnetTrace

                # wasm tooling
                wasm-tools
                wasmtime
                wabt
                binaryen
                spidermonkey_140
              ])
              ++ darwinDeps
              ++ linuxDeps;

            shellHook =
              with pkgs;
              ''
                export SEMGREP_ENABLE_VERSION_CHECK=0
                export SEMGREP_SEND_METRICS=off

                export RUST_BACKTRACE=1
                export RUSTFLAGS="-Zthreads=0"
              ''
              + lib.optionalString stdenv.hostPlatform.isLinux ''
                export RUSTFLAGS+=" -C link-arg=-fuse-ld=mold -C link-arg=-Wl,--compress-debug-sections=zstd"
              '';
          };
        };

      # Flake outputs are keyed by output then system, but evaluating one
      # system costs a full `import nixpkgs`. Evaluate each system once, then
      # regroup those results by output.
      bySystem = lib.genAttrs systems outputsFor;
    in
    {
      packages = lib.mapAttrs (_: attrs: attrs.packages) bySystem;
      checks = lib.mapAttrs (_: attrs: attrs.checks) bySystem;
      devShells = lib.mapAttrs (_: attrs: attrs.devShells) bySystem;
    };
}
