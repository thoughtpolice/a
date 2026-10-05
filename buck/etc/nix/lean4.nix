# SPDX-FileCopyrightText: © 2026 Austin Seipp, 2003-2026 Eelco Dolstra and the Nixpkgs/NixOS contributors
# SPDX-License-Identifier: MIT

# Lean 4.35.0-rc3, from nixpkgs' pkgs/by-name/le/lean4/package.nix at
# NixOS/nixpkgs@edac0312cb6c052d9addce2555e114f7003993f0 (which packages
# 4.34.1). Changes from that file are the version, the source hash and the
# leanir backport in postPatch. The pinned nixpkgs-unstable still ships 4.30.0.
# Delete this file and use pkgs.lean4 once the lock catches up.

{
  lib,
  stdenv,
  cmake,
  cctools,
  fetchFromGitHub,
  fetchpatch,
  gitMinimal,
  gmp,
  cadical,
  leangz,
  makeWrapper,
  openssl,
  pkg-config,
  libuv,
  enableMimalloc ? true,
  perl,
  versionCheckHook,
}:
let
  cadical' = cadical.override { version = "2.1.3"; };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "lean4";
  version = "4.35.0-rc3";

  __structuredAttrs = true;
  strictDeps = true;

  src = fetchFromGitHub {
    owner = "leanprover";
    repo = "lean4";
    tag = "v${finalAttrs.version}";
    hash = "sha256-gVqvQ9fdyCFxMiplNl5fQsw3uc3fPrkO2N3RymVAi7Y=";
  };

  postPatch =
    let
      pattern = "\${LEAN_BINARY_DIR}/../mimalloc/src/mimalloc";
    in
    ''
      substituteInPlace \
        src/CMakeLists.txt \
        src/runtime/CMakeLists.txt \
        stage0/src/CMakeLists.txt \
        stage0/src/runtime/CMakeLists.txt \
        --replace-fail '${pattern}' '${finalAttrs.mimalloc-src}'
    ''
    # Backport the LeanIR.lean half of leanprover/lean4#14906, which landed on
    # main after the 4.35 branch was cut. Without it leanir drops the setup's
    # package id, so a module compiled with compiler.postponeCompile defines
    # initialize_Foo while its importers call initialize_<pkg>_Foo.
    + ''
      substituteInPlace src/LeanIR.lean \
        --replace-fail \
          'import Lean.Compiler.IR.CompilerM' \
          $'import Lean.Compiler.IR.CompilerM\nimport Lean.Compiler.ModPkgExt' \
        --replace-fail \
          '  let env := env.setMainModule modName' \
          $'  let env := env.setMainModule modName\n  let env := env.setModulePackage setup.package?'
    ''
    # Remove tests that fails in sandbox.
    # It expects `sourceRoot` to be a git repository.
    + ''
      rm -rf src/lake/examples/git/
    '';

  preConfigure = ''
    patchShebangs stage0/src/bin/ src/bin/
  '';

  nativeBuildInputs = [
    cadical'
    cmake
    pkg-config
    makeWrapper
    leangz # Provides leantar
    # 4.35 declares its optional external checkers (lean4lean, nanoda, ...)
    # as git ExternalProjects, and configure fails without git even though
    # the default build never clones them.
    gitMinimal
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [
    cctools.libtool
  ];

  buildInputs = [
    gmp
    libuv
    openssl
  ];

  postInstall = ''
    wrapProgram $out/bin/lean \
      --prefix PATH : ${cadical'}/bin
  '';

  nativeCheckInputs = [
    gitMinimal
    perl
  ];

  # Using a vendored version rather than nixpkgs' version to match the exact version required by
  # Lean.  Apparently, even a slight version change can impact greatly the final performance.
  mimalloc-src = fetchFromGitHub {
    owner = "microsoft";
    repo = "mimalloc";
    tag = "v3.4.5";
    hash = "sha256-vNVZw2YsDkf0GcdFTNb/fXMQLQYvoc8P425LupPShpo=";
  };

  cmakeFlags = [
    (lib.cmakeBool "USE_GITHASH" false)
    (lib.cmakeBool "INSTALL_LICENSE" false)
    (lib.cmakeBool "INSTALL_CADICAL" false)
    (lib.cmakeBool "USE_MIMALLOC" enableMimalloc)
    (lib.cmakeFeature "FETCHCONTENT_SOURCE_DIR_MIMALLOC" finalAttrs.mimalloc-src.outPath)
  ]
  # Release CI passes the "rc3" of "4.35.0-rc3" this way. Without it the
  # binary reports, and stamps into every .olean, plain "4.35.0". The flag
  # stays untyped: the top-level CMakeLists.txt forwards only untyped -D
  # options to the stage builds, and lib.cmakeFeature writes ":STRING".
  ++ lib.optional (lib.hasInfix "-" finalAttrs.version) (
    "-DLEAN_SPECIAL_VERSION_DESC=${lib.last (lib.splitString "-" finalAttrs.version)}"
  );

  nativeInstallCheckInputs = [
    versionCheckHook
  ];
  doInstallCheck = true;

  meta = {
    description = "Automatic and interactive theorem prover";
    homepage = "https://leanprover.github.io/";
    changelog = "https://github.com/leanprover/lean4/blob/${finalAttrs.src.tag}/RELEASES.md";
    license = lib.licenses.asl20;
    platforms = lib.platforms.all;
    maintainers = with lib.maintainers; [
      danielbritten
      jthulhu
      nadja-y
      niklashh
    ];
    mainProgram = "lean";
  };
})
