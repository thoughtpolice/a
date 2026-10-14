# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  system,
  rustNightlyDate,
  rustTargets,
}:

let
  inherit (pkgs) lib;

  stripElfFiles = import ./strip-elf-files.nix { inherit pkgs; };
  stripCDefaultRuntime = import ./strip-c-default-runtime.nix {
    inherit stripElfFiles;
  };

  slimGlibc = import ./slim-glibc.nix { inherit pkgs; };
  glibcOutputNames = lib.intersectLists pkgs.glibc.outputs slimGlibc.outputs;
  stockGlibcOutputs = map (outputName: lib.getOutput outputName pkgs.glibc) glibcOutputNames;
  glibcReplacements = map (outputName: {
    oldDependency = lib.getOutput outputName pkgs.glibc;
    newDependency = lib.getOutput outputName slimGlibc;
  }) glibcOutputNames;
  requiredSlimGlibcOutputs = map (outputName: lib.getOutput outputName slimGlibc) [
    "out"
    "bin"
    "dev"
    "getent"
  ];

  bashRuntime = import ./bash-runtime.nix {
    inherit pkgs stripCDefaultRuntime;
  };
  diffutilsRuntime = import ./diffutils-runtime.nix {
    inherit pkgs stripCDefaultRuntime;
  };
  findutilsRuntime = import ./findutils-runtime.nix {
    inherit pkgs stripCDefaultRuntime;
  };
  gawkRuntime = import ./gawk-runtime.nix {
    inherit pkgs stripCDefaultRuntime;
  };
  grepRuntime = import ./grep-runtime.nix {
    inherit pkgs stripCDefaultRuntime;
  };
  sedRuntime = import ./sed-runtime.nix {
    inherit pkgs stripCDefaultRuntime;
  };
  tarRuntime = import ./tar-runtime.nix {
    inherit pkgs stripCDefaultRuntime;
  };
  wgetRuntime = import ./wget-runtime.nix {
    inherit pkgs stripCDefaultRuntime;
  };

  slimCurl = import ./slim-curl.nix { inherit pkgs; };
  slimGit = import ./slim-git.nix {
    inherit
      pkgs
      bashRuntime
      gawkRuntime
      grepRuntime
      sedRuntime
      slimCurl
      ;
  };
  slimIproute2 = import ./slim-iproute2.nix {
    inherit pkgs stripElfFiles;
  };
  libudevRuntime = import ./libudev-runtime.nix { inherit pkgs; };
  slimLibfido2 = import ./slim-libfido2.nix {
    inherit pkgs libudevRuntime stripElfFiles;
  };
  opensshClient = import ./openssh-client.nix {
    inherit pkgs slimLibfido2 stripElfFiles;
  };
  shadowMinimal = import ./shadow-minimal.nix {
    inherit pkgs stripElfFiles;
  };
  sudoNoPam = import ./sudo-no-pam.nix { inherit pkgs; };
  slimTzdata = import ./slim-tzdata.nix { inherit pkgs; };
  procpsRuntime = import ./procps-runtime.nix {
    inherit pkgs stripElfFiles;
  };
  utilLinuxRuntime = import ./util-linux-runtime.nix { inherit pkgs; };

  slimBinutilsUnwrapped = import ./slim-binutils-unwrapped.nix {
    inherit pkgs;
  };
  binutilsRuntime = import ./binutils-runtime.nix {
    inherit pkgs grepRuntime slimBinutilsUnwrapped;
  };
  slimGlib = import ./slim-glib.nix {
    inherit pkgs stripElfFiles;
  };
  slimLibsecret = import ./slim-libsecret.nix {
    inherit pkgs slimGlib stripElfFiles;
  };
  moldUnwrapped = import ./mold-unwrapped.nix { inherit pkgs system; };
  moldRuntime = import ./mold-runtime.nix {
    inherit pkgs grepRuntime moldUnwrapped;
  };

  llvm = import ./llvm.nix { inherit pkgs lib; };
  inherit (llvm) llvmPackages slimLlvmPackages;
  clang = import ./clang.nix {
    inherit
      pkgs
      lib
      slimLlvmPackages
      binutilsRuntime
      grepRuntime
      ;
  };
  inherit (clang)
    clangCompiler
    compilerRtGccCompat
    libstdcxxLibcxxCompat
    ;
  clangdPackage = import ./clangd.nix {
    inherit pkgs clangCompiler slimLlvmPackages;
  };
  inherit (clangdPackage) clangd;
  rust = import ./rust.nix {
    inherit
      pkgs
      lib
      rustNightlyDate
      rustTargets
      slimLlvmPackages
      ;
  };
  inherit (rust)
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
  bindgenPackage = import ./bindgen.nix {
    inherit pkgs clangCompiler bashRuntime;
  };
  inherit (bindgenPackage) bindgen slimBindgenUnwrapped;

  watchmanTelemetryInputs = import ./watchman-telemetry-inputs.nix {
    inherit pkgs;
  };
  watchmanNoTelemetryPatch = import ./watchman-no-telemetry-patch.nix {
    inherit pkgs;
  };
  slimWatchman = import ./slim-watchman.nix {
    inherit pkgs watchmanNoTelemetryPatch watchmanTelemetryInputs;
  };
  slimBoost = import ./slim-boost.nix { inherit pkgs; };
  watchmanRuntime = import ./watchman-runtime.nix {
    inherit pkgs slimBoost slimWatchman;
  };
  dotSlashRuntime = import ./dotslash-runtime.nix { inherit pkgs; };
  nodeBase = import ./node-base.nix { inherit pkgs; };
  nodeRuntime = import ./node-runtime.nix { inherit pkgs nodeBase; };
  npmRuntime = import ./npm-runtime.nix {
    inherit
      pkgs
      bashRuntime
      nodeBase
      nodeRuntime
      ;
  };
  zstdRuntime = import ./zstd-runtime.nix { inherit pkgs grepRuntime; };
in
{
  inherit
    bashRuntime
    bindgen
    binutilsRuntime
    clangCompiler
    clangd
    compilerRtGccCompat
    diffutilsRuntime
    dotSlashRuntime
    findutilsRuntime
    gawkRuntime
    glibcReplacements
    grepRuntime
    libstdcxxLibcxxCompat
    libudevRuntime
    llvmPackages
    moldRuntime
    nodeBase
    nodeRuntime
    npmRuntime
    opensshClient
    procpsRuntime
    requiredSlimGlibcOutputs
    rustChannel
    rustToolchain
    rustToolchainBase
    sedRuntime
    shadowMinimal
    slimBoost
    slimCurl
    slimGit
    slimGlib
    slimGlibc
    slimIproute2
    slimLibfido2
    slimLibsecret
    slimLlvmPackages
    slimTzdata
    slimWatchman
    stockGlibcOutputs
    sudoNoPam
    tarRuntime
    utilLinuxRuntime
    watchmanRuntime
    watchmanTelemetryInputs
    wgetRuntime
    zstdRuntime
    ;
}
