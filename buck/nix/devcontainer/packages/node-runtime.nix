# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs, nodeBase }:

let
  inherit (pkgs) lib;
  nodeDevelopmentReferences = lib.unique (
    lib.filter (reference: (reference.outputName or "out") == "dev") (
      map lib.getDev nodeBase.buildInputs
    )
  );
in
pkgs.runCommand nodeBase.name
  {
    nativeBuildInputs = [
      pkgs.binutils
      pkgs.removeReferencesTo
    ];
    inherit (nodeBase) meta;
    passthru.version = nodeBase.version;
  }
  ''
    install -Dm755 ${nodeBase}/bin/node "$out/bin/node"

    # Node embeds its installation prefix. Nix store paths have fixed width,
    # so keep process.config truthful without rebuilding the entire runtime.
    test "$(printf %s ${nodeBase} | wc -c)" \
      -eq "$(printf %s "$out" | wc -c)"
    sed -i "s|${nodeBase}|$out|g" "$out/bin/node"
    if grep -aF ${nodeBase} "$out/bin/node"; then
      exit 1
    fi
    grep -aF "$out" "$out/bin/node" >/dev/null

    strip --strip-unneeded "$out/bin/node"
    ${lib.concatMapStringsSep "\n" (
      reference: "remove-references-to -t \"${reference}\" \"$out/bin/node\""
    ) nodeDevelopmentReferences}
  ''
