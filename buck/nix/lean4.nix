# SPDX-FileCopyrightText: © 2026 Austin Seipp, 2003-2026 Eelco Dolstra and the Nixpkgs/NixOS contributors
# SPDX-License-Identifier: MIT

# Lean 4.36.0 nightly-2026-10-10 (leanprover/lean4@b8182f64; 244 commits
# past 4.35.0-rc3), from nixpkgs' pkgs/by-name/le/lean4/package.nix at
# NixOS/nixpkgs@edac0312cb6c052d9addce2555e114f7003993f0 (which packages
# 4.34.1). Changes from that file: the version and source, and CaDiCaL,
# which trunk links into the Lean libraries (`-lcadical` in leanc's flags)
# and builds from git unless told where the program, the static library
# and the headers are. The pinned nixpkgs-unstable still ships 4.30.0.
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
  # `version` is what `lean --version` reports (the toolchain check reads
  # this line, `buck/toolchains/lean/tool.py`): the part after the first
  # dash is passed as LEAN_SPECIAL_VERSION_DESC below. CI reads it too, and
  # installs the release or nightly of that name
  # (.github/actions/install-lean), so pin a commit Lean published, and the
  # binary it downloads reports the same version as the one built here.
  version = "4.36.0-nightly-2026-10-10";

  __structuredAttrs = true;
  strictDeps = true;

  src = fetchFromGitHub {
    owner = "leanprover";
    repo = "lean4";
    rev = "b8182f6428135d8de524313001fffe7434bfacad";
    hash = "sha256-Wh9fyCyWjPdSEIeE+vaDNNSyfu1VmaM1sf7otcsgl0M=";
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
    cadical'
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
    # CaDiCaL: the program (also on lean's PATH below), the static library
    # that trunk links into the Lean libraries and copies to lib/lean, and
    # its headers; without all three the build clones and builds it from
    # git, which the sandbox cannot. Untyped: see LEAN_SPECIAL_VERSION_DESC.
    "-DCADICAL=${cadical'}/bin/cadical"
    "-DCADICAL_LIB=${lib.getLib cadical'}/lib/libcadical.a"
    "-DCADICAL_INCLUDE_DIR=${lib.getDev cadical'}/include"
  ]
  # Release CI passes the "rc3" of "4.35.0-rc3" and the "nightly-2026-10-10"
  # of a nightly this way, and so does this file. Without it the binary
  # reports, and stamps into every .olean, plain "4.36.0". The flag stays
  # untyped: the top-level CMakeLists.txt forwards only untyped -D options
  # to the stage builds, and lib.cmakeFeature writes ":STRING".
  ++ lib.optional (lib.hasInfix "-" finalAttrs.version) (
    "-DLEAN_SPECIAL_VERSION_DESC=${lib.concatStringsSep "-" (lib.drop 1 (lib.splitString "-" finalAttrs.version))}"
  );

  nativeInstallCheckInputs = [
    versionCheckHook
  ];
  doInstallCheck = true;

  meta = {
    description = "Automatic and interactive theorem prover";
    homepage = "https://leanprover.github.io/";
    changelog = "https://github.com/leanprover/lean4/blob/${finalAttrs.src.rev}/RELEASES.md";
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
