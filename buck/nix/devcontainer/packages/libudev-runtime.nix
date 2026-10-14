# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

let
  inherit (pkgs) lib;
in
# libfido2 only needs libudev, not the larger combined libsystemd/libudev
# output. Give it a self-contained development/runtime view of libudev so
# OpenSSH can retain hardware security-key support without systemd.
pkgs.runCommand "devcontainer-libudev-${pkgs.systemdLibs.version}"
  {
    nativeBuildInputs = [
      pkgs.binutils
      pkgs.removeReferencesTo
    ];
    meta = (pkgs.systemdLibs.meta or { }) // {
      outputsToInstall = [ "out" ];
    };
    passthru.version = pkgs.systemdLibs.version;
  }
  ''
    mkdir -p "$out/include" "$out/lib/pkgconfig"
    cp -a ${lib.getLib pkgs.systemdLibs}/lib/libudev.so* "$out/lib/"
    cp ${lib.getDev pkgs.systemdLibs}/include/libudev.h "$out/include/"
    cp ${lib.getDev pkgs.systemdLibs}/lib/pkgconfig/libudev.pc \
      "$out/lib/pkgconfig/"
    chmod -R u+w "$out"
    substituteInPlace "$out/lib/pkgconfig/libudev.pc" \
      --replace-fail '${lib.getLib pkgs.systemdLibs}' "$out" \
      --replace-fail '${lib.getDev pkgs.systemdLibs}' "$out"
    find "$out/lib" -type f -name 'libudev.so*' \
      -exec strip --strip-unneeded {} +
    # libudev compiles optional hwdb/helper locations into the DSO. libfido2
    # does not exercise those APIs; sever their combined systemd output and
    # util-linux helper references after retaining the actual dynamic library.
    find "$out/lib" -type f -name 'libudev.so*' -exec \
      remove-references-to \
        -t '${lib.getLib pkgs.systemdLibs}' \
        -t '${lib.getOutput "login" pkgs.util-linuxMinimal}' \
        {} +
    if grep -R -F '${lib.getLib pkgs.systemdLibs}' "$out"; then
      exit 1
    fi
    if grep -R -F '${lib.getDev pkgs.systemdLibs}' "$out"; then
      exit 1
    fi
  ''
