# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  watchmanNoTelemetryPatch,
  watchmanTelemetryInputs,
}:

let
  inherit (pkgs) lib;
in
pkgs.watchman.overrideAttrs (previousAttrs: {
  buildInputs = builtins.filter (
    input: !(builtins.elem (lib.getName input) (map lib.getName watchmanTelemetryInputs))
  ) previousAttrs.buildInputs;
  cmakeFlags = (previousAttrs.cmakeFlags or [ ]) ++ [
    (lib.cmakeBool "ENABLE_EDEN_SUPPORT" false)
    (lib.cmakeFeature "CMAKE_POLICY_DEFAULT_CMP0069" "NEW")
    (lib.cmakeBool "CMAKE_INTERPROCEDURAL_OPTIMIZATION" true)
  ];
  cmakeBuildType = "MinSizeRel";
  patches = (previousAttrs.patches or [ ]) ++ [ watchmanNoTelemetryPatch ];
})
