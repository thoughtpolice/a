# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  lib,
  rustNightlyDate,
  rustTargets,
  slimLlvmPackages,
}:

let
  rustChannel = pkgs.rust-bin.nightly.${rustNightlyDate};
  rustToolchainBase = rustChannel.minimal.override {
    extensions = [
      "clippy"
      "rust-analyzer"
      "rust-src"
      "rustfmt"
    ];
    targets = rustTargets;
  };
  rustComponentKey = value: builtins.unsafeDiscardStringContext (toString value);
  stripRustComponent = previousAttrs: {
    postFixup = (previousAttrs.postFixup or "") + ''
      find "$out" -type f | while IFS= read -r file; do
        if ${pkgs.binutils}/bin/readelf -h "$file" >/dev/null 2>&1; then
          ${pkgs.binutils}/bin/strip --strip-unneeded "$file"
        fi
      done
    '';
  };
  slimRustStdFor =
    target:
    rustChannel._components.${target}.rust-std.overrideAttrs (previousAttrs: {
      postFixup = (previousAttrs.postFixup or "") + ''
        # The nightly sanitizer runtimes are not linked directly. Fozzie's
        # mixed-language builds use -Zexternal-clangrt so the pinned Clang
        # toolchain owns the single compiler-rt instance.
        find "$out/lib/rustlib/${target}/lib" -maxdepth 1 -type f \
          -name 'librustc-nightly_rt.*.a' -delete

        # GDB and LLDB are deliberately outside the image contract. Preserve
        # Rust metadata and embedded LLVM bitcode, but omit archive debug data.
        find "$out/lib/rustlib/${target}/lib" -maxdepth 1 -type f \
          \( -name '*.rlib' -o -name '*.a' \) \
          -exec ${slimLlvmPackages.libllvm}/bin/llvm-strip \
            --strip-debug {} +
      '';
    });
  slimRustStd = lib.genAttrs rustTargets slimRustStdFor;
  slimRustc = rustChannel.rustc.overrideAttrs (
    previousAttrs:
    (stripRustComponent previousAttrs)
    // {
      postFixup = (stripRustComponent previousAttrs).postFixup + ''
        # No wasm target or interactive debugger ships in this image. rust-lld
        # remains available for the Linux and UEFI targets.
        find "$out/lib/rustlib" -type f -name wasm-component-ld -delete
        rm -rf "$out/lib/rustlib/etc" "$out/share/man"
        rm -f "$out/bin/rust-gdb" "$out/bin/rust-gdbgui" "$out/bin/rust-lldb"
      '';
    }
  );
  slimCargo = rustChannel.cargo.overrideAttrs stripRustComponent;
  slimClippy = rustChannel.clippy.overrideAttrs (
    previousAttrs:
    (stripRustComponent previousAttrs)
    // {
      buildInputs = [ slimRustc ];
    }
  );
  slimRustAnalyzer = rustChannel.rust-analyzer.overrideAttrs (
    previousAttrs:
    (stripRustComponent previousAttrs)
    // {
      buildInputs = [ slimRustc ];
    }
  );
  slimRustfmt = rustChannel.rustfmt.overrideAttrs (
    previousAttrs:
    (stripRustComponent previousAttrs)
    // {
      buildInputs = [ slimRustc ];
    }
  );
  rustComponentReplacements = lib.listToAttrs (
    map
      ({ old, new }: {
        name = rustComponentKey old;
        value = new;
      })
      (
        [
          {
            old = rustChannel.rustc;
            new = slimRustc;
          }
          {
            old = rustChannel.cargo;
            new = slimCargo;
          }
          {
            old = rustChannel.clippy;
            new = slimClippy;
          }
          {
            old = rustChannel.rust-analyzer;
            new = slimRustAnalyzer;
          }
          {
            old = rustChannel.rustfmt;
            new = slimRustfmt;
          }
        ]
        ++ map (target: {
          old = rustChannel._components.${target}.rust-std;
          new = slimRustStd.${target};
        }) rustTargets
      )
  );
  rustToolchainWithSlimComponents = rustToolchainBase.overrideAttrs (previousAttrs: {
    paths = map (
      component: rustComponentReplacements.${rustComponentKey component} or component
    ) previousAttrs.paths;
  });
  rustToolchain = rustToolchainWithSlimComponents.overrideAttrs (previousAttrs: {
    # The image profile already supplies Clang/cc. Do not retain the complete
    # Nix stdenv compiler through rust-overlay's build-input propagation files.
    depsHostHostPropagated = [ ];
    propagatedBuildInputs = [ ];
    depsTargetTargetPropagated = [ ];

    # rust-overlay folds its symlinkJoin postBuild into buildCommand. Only the
    # regular files it copies for sysroot discovery can be stripped here; the
    # remaining component binaries stay symlinks to their original outputs.
    buildCommand = previousAttrs.buildCommand + ''
      for file in "$out/bin/cargo-clippy"; do
        if [[ -f "$file" && ! -L "$file" ]]; then
          ${pkgs.binutils}/bin/strip --strip-unneeded "$file"
        fi
      done

      # Loading librustc_driver through the aggregate makes rustc infer $out as
      # its sysroot, but copying the driver serializes a second large shared
      # library. Tiny launchers make that sysroot explicit while the executables
      # and driver remain in their already-retained component outputs.
      rm -f \
        "$out/bin/rustc" \
        "$out/bin/rustdoc" \
        "$out/bin/clippy-driver"
      rm -f "$out"/lib/librustc_driver*

      mkdir -p "$out/libexec"
      cat > "$out/libexec/devcontainer-rust-driver" <<EOF
      #!${pkgs.runtimeShell}
      driver="\$1"
      default_sysroot="\$2"
      prefix_count="\$3"
      shift 3

      prefix=()
      while (( prefix_count > 0 )); do
        prefix+=("\$1")
        shift
        prefix_count=\$((prefix_count - 1))
      done

      args=()
      have_sysroot=
      while (( \$# > 0 )); do
        case "\$1" in
          --sysroot)
            shift
            if (( \$# > 0 )) && [[ -n "\$1" ]]; then
              args+=(--sysroot "\$1")
            else
              args+=(--sysroot "\$default_sysroot")
            fi
            if (( \$# > 0 )); then
              shift
            fi
            have_sysroot=1
            ;;
          --sysroot=*)
            value="\''${1#--sysroot=}"
            if [[ -n "\$value" ]]; then
              args+=("\$1")
            else
              args+=(--sysroot "\$default_sysroot")
            fi
            shift
            have_sysroot=1
            ;;
          *)
            args+=("\$1")
            shift
            ;;
        esac
      done
      if [[ -z "\$have_sysroot" ]]; then
        args=(--sysroot "\$default_sysroot" "\''${args[@]}")
      fi
      exec "\$driver" "\''${prefix[@]}" "\''${args[@]}"
      EOF
      cat > "$out/bin/rustc" <<EOF
      #!${pkgs.runtimeShell}
      exec "$out/libexec/devcontainer-rust-driver" \
        ${slimRustc}/bin/rustc "$out" 0 "\$@"
      EOF
      cat > "$out/bin/rustdoc" <<EOF
      #!${pkgs.runtimeShell}
      exec "$out/libexec/devcontainer-rust-driver" \
        ${slimRustc}/bin/rustdoc "$out" 0 "\$@"
      EOF
      cat > "$out/bin/clippy-driver" <<EOF
      #!${pkgs.runtimeShell}
      case "\''${1:-}" in
        rustc|*/rustc)
          rustc="\$1"
          shift
          exec "$out/libexec/devcontainer-rust-driver" \
            ${slimClippy}/bin/clippy-driver "$out" 1 "\$rustc" "\$@"
          ;;
        *)
          exec "$out/libexec/devcontainer-rust-driver" \
            ${slimClippy}/bin/clippy-driver "$out" 0 "\$@"
          ;;
      esac
      EOF
      chmod 0755 \
        "$out/bin/rustc" \
        "$out/bin/rustdoc" \
        "$out/bin/clippy-driver" \
        "$out/libexec/devcontainer-rust-driver"

      rm -f \
        "$out/nix-support/propagated-host-host-deps" \
        "$out/nix-support/propagated-build-inputs" \
        "$out/nix-support/propagated-target-target-deps"
    '';
  });
in
{
  inherit
    rustChannel
    rustToolchainBase
    slimRustStd
    slimRustc
    slimCargo
    slimClippy
    slimRustAnalyzer
    slimRustfmt
    rustToolchainWithSlimComponents
    rustToolchain
    ;
}
