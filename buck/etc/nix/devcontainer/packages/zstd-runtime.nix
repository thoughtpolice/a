# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs, grepRuntime }:

let
  inherit (pkgs) lib;
in
pkgs.runCommand "devcontainer-zstd-${pkgs.zstd.version}"
  {
    nativeBuildInputs = [ pkgs.binutils ];
    meta = (pkgs.zstd.meta or { }) // {
      outputsToInstall = [ "out" ];
    };
    passthru.version = pkgs.zstd.version;
  }
  ''
    mkdir -p "$out"
    cp -a ${lib.getBin pkgs.zstd}/bin "$out/"
    chmod -R u+w "$out"
    substituteInPlace "$out/bin/zstdgrep" \
      --replace-fail '${pkgs.gnugrep}/bin/grep' '${grepRuntime}/bin/grep' \
      --replace-fail '${lib.getBin pkgs.zstd}/bin/zstdcat' \
        "$out/bin/zstdcat"
    find "$out/bin" -type f -print0 \
      | while IFS= read -r -d $'\0' file; do
        if ${pkgs.binutils}/bin/readelf -h "$file" >/dev/null 2>&1; then
          ${pkgs.binutils}/bin/strip --strip-unneeded "$file"
        fi
      done
    if grep -R -F '${lib.getBin pkgs.zstd}' "$out"; then
      exit 1
    fi
    if grep -R -F '${pkgs.gnugrep}' "$out"; then
      exit 1
    fi
  ''
