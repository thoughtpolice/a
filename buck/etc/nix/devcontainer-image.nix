# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{
  pkgs,
  self,
  system,
}:

assert pkgs.lib.assertMsg pkgs.stdenv.isLinux
  "the development container image can only be built on Linux";

let
  inherit (pkgs) lib;

  # Image size is the primary optimization target; rebuilding a package is
  # preferable to retaining unused outputs or transitive build dependencies.
  # Package-specific pruning and repackaging lives under
  # ./devcontainer/packages; this file composes the root, image, and check.
  # GLib's non-store charset-alias path prevents an overlapping fake store
  # reference from defeating the final glibc replacement pass.

  imageName = "ghcr.io/thoughtpolice/a/devcontainer";
  imageTag = "nix";
  imageCreated = "1970-01-01T00:00:01Z";
  imageRevision = self.rev or (self.dirtyRev or "unknown");
  imageArchitecture =
    {
      aarch64-linux = "arm64";
      x86_64-linux = "amd64";
    }
    .${system};

  rustNightlyDate = "2026-03-24";
  rustTargets = [
    "aarch64-unknown-linux-gnu"
    "aarch64-unknown-uefi"
    "x86_64-unknown-linux-gnu"
    "x86_64-unknown-uefi"
  ];

  imagePackages = import ./devcontainer/packages {
    inherit
      pkgs
      system
      rustNightlyDate
      rustTargets
      ;
  };
  inherit (imagePackages)
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

  compatibilityPackages = with pkgs; [
    (lib.getBin bashRuntime)
    (lib.getBin bzip2)
    (lib.getBin coreutils)
    (lib.getBin slimCurl)
    (lib.getBin diffutilsRuntime)
    (lib.getBin file)
    (lib.getBin findutilsRuntime)
    (lib.getBin gawkRuntime)
    (lib.getBin slimGit)
    (lib.getBin slimGlibc)
    (lib.getOutput "getent" slimGlibc)
    (lib.getBin grepRuntime)
    (lib.getBin sedRuntime)
    (lib.getBin tarRuntime)
    (lib.getBin gzip)
    (lib.getBin slimIproute2)
    (lib.getBin jq)
    (lib.getBin less)
    (lib.getBin ncurses)
    (lib.getBin opensshClient)
    (lib.getBin procpsRuntime)
    (lib.getBin shadowMinimal)
    (lib.getBin unzip)
    (lib.getBin utilLinuxRuntime)
    (lib.getBin wgetRuntime)
    (lib.getBin which)
    (lib.getBin xz)
    (lib.getBin zip)
    zstdRuntime
  ];

  developmentPackages = [
    rustToolchain
    (lib.getBin bindgen)
    (lib.getBin clangCompiler)
    clangd
    (lib.getLib slimLlvmPackages.libclang)
    (lib.getBin slimLlvmPackages.lld)
    binutilsRuntime
    dotSlashRuntime
    moldRuntime
    nodeRuntime
    npmRuntime
    watchmanRuntime
  ];

  toolProfile = pkgs.buildEnv {
    name = "devcontainer-tool-profile";
    paths = compatibilityPackages ++ developmentPackages;
    pathsToLink = [
      "/bin"
      "/lib"
      "/libexec"
      "/share/bash-completion"
      "/share/terminfo"
    ];
    ignoreCollisions = true;
  };
  stockRustStdPaths = map (target: rustChannel._components.${target}.rust-std) rustTargets;
  stockRuntimePaths = map (path: builtins.unsafeDiscardStringContext (toString path)) (
    [
      (lib.getLib llvmPackages.libllvm)
      (lib.getLib llvmPackages.libclang)
      (lib.getBin llvmPackages.clang-tools)
      llvmPackages.compiler-rt
      (lib.getDev llvmPackages.compiler-rt)
      (lib.getBin slimLlvmPackages.libllvm)
      (lib.getDev slimLlvmPackages.libllvm)
      (lib.getDev slimLlvmPackages.libclang)
      (lib.getOutput "python" slimLlvmPackages.libclang)
      (lib.getLib slimLlvmPackages.lld)
      (lib.getDev slimLlvmPackages.lld)
      pkgs.stdenv.cc.cc
      pkgs.pam
      pkgs.python3
      rustToolchainBase
      rustChannel.rustc
      rustChannel.cargo
      rustChannel.clippy
      rustChannel.rust-analyzer
      rustChannel.rustfmt
      pkgs.mold
      pkgs.mold-unwrapped
      pkgs.watchman
      slimWatchman
      pkgs.edencommon
      pkgs.folly
      pkgs.boost
      slimBoost
      pkgs.dotslash
      pkgs.bashInteractive
      pkgs.diffutils
      pkgs.findutils
      pkgs.gawk
      pkgs.gnugrep
      pkgs.gnused
      pkgs.gnutar
      pkgs.nodejs-slim
      pkgs.nodejs-slim.npm
      nodeBase
      nodeBase.npm
      pkgs.gettext
      pkgs.glib
      pkgs.icu
      pkgs.libsecret
      pkgs.libfido2
      pkgs.iproute2
      pkgs.openssh
      pkgs.procps
      pkgs.systemdLibs
      pkgs.shadow
      pkgs.util-linuxMinimal
      pkgs.wget
      (lib.getBin pkgs.zstd)
      pkgs.binutils
      pkgs.binutils-unwrapped
    ]
    ++ stockGlibcOutputs
    ++ stockRustStdPaths
    ++ watchmanTelemetryInputs
  );

  # nix-ld does not receive the search paths from Nix package wrappers. List
  # each foreign-binary ABI surface directly: notably, libsecret retaining a
  # GLib reference does not by itself make GLib's complete DSO family visible.
  nixLdLibraries = with pkgs; [
    slimGlibc
    stdenv.cc.cc
    bzip2
    slimGlib
    slimLibsecret
    libxml2
    openssl
    xz
    zlib
    zstd
  ];
  nixLdProfile = pkgs.buildEnv {
    name = "devcontainer-nix-ld-profile";
    paths = map lib.getLib nixLdLibraries;
    pathsToLink = [ "/lib" ];
    ignoreCollisions = true;
    postBuild = ''
      ln -s ${slimGlibc}/lib/${loaderName} "$out/lib/ld.so"
    '';
  };
  nixLdPath = "/opt/devcontainer/nix-ld/lib";

  loaderDirectory = if system == "x86_64-linux" then "lib64" else "lib";
  loaderName = if system == "x86_64-linux" then "ld-linux-x86-64.so.2" else "ld-linux-aarch64.so.1";
  loaderPath = "/${loaderDirectory}/${loaderName}";

  passwdFile = pkgs.writeText "devcontainer-passwd" ''
    root:x:0:0:root:/root:/bin/bash
    vscode:x:1000:1000:VS Code:/home/vscode:/bin/bash
    nobody:x:65534:65534:Nobody:/:/usr/sbin/nologin
  '';
  groupFile = pkgs.writeText "devcontainer-group" ''
    root:x:0:
    vscode:x:1000:
    nobody:x:65534:
  '';
  shadowFile = pkgs.writeText "devcontainer-shadow" ''
    root:!:1::::::
    vscode:!:1::::::
    nobody:!:1::::::
  '';
  gshadowFile = pkgs.writeText "devcontainer-gshadow" ''
    root:!::
    vscode:!::
    nobody:!::
  '';
  nsswitchFile = pkgs.writeText "devcontainer-nsswitch.conf" ''
    passwd: files
    group: files
    shadow: files
    hosts: files dns
    networks: files dns
    protocols: files
    services: files
    ethers: files
    rpc: files
  '';
  networksFile = pkgs.writeText "devcontainer-networks" ''
    default 0.0.0.0
    loopback 127.0.0.0
    link-local 169.254.0.0
  '';
  shellsFile = pkgs.writeText "devcontainer-shells" ''
    /bin/sh
    /bin/bash
    /usr/bin/bash
  '';
  osReleaseFile = pkgs.writeText "devcontainer-os-release" ''
    NAME="thoughtpolice/a development container"
    PRETTY_NAME="thoughtpolice/a pure-Nix development container"
    ID=thoughtpolice-a-devcontainer
    ID_LIKE=nixos
    VERSION=canon
    VERSION_ID=canon
    BUILD_ID="${imageRevision}"
    HOME_URL="https://github.com/thoughtpolice/a"
    DOCUMENTATION_URL="https://github.com/thoughtpolice/a/tree/canon/.devcontainer"
    BUG_REPORT_URL="https://github.com/thoughtpolice/a/issues"
  '';
  environmentFile = pkgs.writeText "devcontainer-environment" ''
    HOME="/home/vscode"
    USER="vscode"
    LOGNAME="vscode"
    SHELL="/bin/bash"
    PATH="/opt/devcontainer/profile/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    LANG="C.UTF-8"
    LC_ALL="C.UTF-8"
    TERM="xterm-256color"
    TZ="UTC"
    TZDIR="/usr/share/zoneinfo"
    SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt"
    NIX_SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt"
    GIT_SSL_CAINFO="/etc/ssl/certs/ca-certificates.crt"
    NIX_LD="${nixLdPath}/ld.so"
    NIX_LD_LIBRARY_PATH="${nixLdPath}"
    LIBCLANG_PATH="/opt/devcontainer/profile/lib"
  '';
  profileFile = pkgs.writeText "devcontainer-profile" ''
    export HOME="''${HOME:-/home/vscode}"
    export PATH="/opt/devcontainer/profile/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    export LANG="''${LANG:-C.UTF-8}"
    export LC_ALL="''${LC_ALL:-C.UTF-8}"
    export TERM="''${TERM:-xterm-256color}"
    export TZ="''${TZ:-UTC}"
    export TZDIR="''${TZDIR:-/usr/share/zoneinfo}"
    export SSL_CERT_FILE="''${SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt}"
    export NIX_SSL_CERT_FILE="''${NIX_SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt}"
    export GIT_SSL_CAINFO="''${GIT_SSL_CAINFO:-/etc/ssl/certs/ca-certificates.crt}"
    export NIX_LD="''${NIX_LD:-${nixLdPath}/ld.so}"
    export NIX_LD_LIBRARY_PATH="''${NIX_LD_LIBRARY_PATH:-${nixLdPath}}"
    export LIBCLANG_PATH="''${LIBCLANG_PATH:-/opt/devcontainer/profile/lib}"

    if [ -n "''${BASH_VERSION:-}" ] && [ -r /etc/bash.bashrc ]; then
      . /etc/bash.bashrc
    fi
  '';
  bashrcFile = pkgs.writeText "devcontainer-bash.bashrc" ''
    case $- in
      *i*) ;;
      *) return ;;
    esac

    shopt -s checkwinsize
    export HISTCONTROL=ignoreboth
    export HISTFILESIZE=2000
    export HISTSIZE=1000
    PS1='\u@\h:\w\$ '
  '';
  userBashrcFile = pkgs.writeText "devcontainer-user-bashrc" ''
    if [ -r /etc/bash.bashrc ]; then
      . /etc/bash.bashrc
    fi
  '';
  userProfileFile = pkgs.writeText "devcontainer-user-profile" ''
    if [ -n "''${BASH_VERSION:-}" ] && [ -r "$HOME/.bashrc" ]; then
      . "$HOME/.bashrc"
    fi
  '';
  localeFile = pkgs.writeText "devcontainer-locale.conf" ''
    LANG=C.UTF-8
    LC_ALL=C.UTF-8
  '';
  sudoersFile = pkgs.writeText "devcontainer-sudoers" ''
    Defaults env_reset
    Defaults mail_badpass
    Defaults secure_path="/opt/devcontainer/profile/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    root ALL=(ALL:ALL) ALL
    @includedir /etc/sudoers.d
  '';
  vscodeSudoersFile = pkgs.writeText "devcontainer-vscode-sudoers" ''
    vscode ALL=(ALL:ALL) NOPASSWD: ALL
  '';
  unrewrittenRootFiles = pkgs.runCommand "devcontainer-compatibility-root" { } ''
    install -d \
      "$out/bin" \
      "$out/etc/pki/tls/certs" \
      "$out/etc/ssl/certs" \
      "$out/etc/sudoers.d" \
      "$out/home/vscode" \
      "$out/${loaderDirectory}" \
      "$out/opt/devcontainer" \
      "$out/root" \
      "$out/run/current-system/sw/share" \
      "$out/sbin" \
      "$out/tmp" \
      "$out/usr/bin" \
      "$out/usr/local/bin" \
      "$out/usr/local/sbin" \
      "$out/usr/share" \
      "$out/usr/sbin" \
      "$out/var/devcontainer" \
      "$out/var/run" \
      "$out/var/tmp" \
      "$out/vscode" \
      "$out/workspaces"

    install -m 0644 ${passwdFile} "$out/etc/passwd"
    install -m 0644 ${groupFile} "$out/etc/group"
    install -m 0600 ${shadowFile} "$out/etc/shadow"
    install -m 0600 ${gshadowFile} "$out/etc/gshadow"
    install -m 0644 ${nsswitchFile} "$out/etc/nsswitch.conf"
    install -m 0644 ${networksFile} "$out/etc/networks"
    install -m 0644 ${shellsFile} "$out/etc/shells"
    install -m 0644 ${osReleaseFile} "$out/etc/os-release"
    install -m 0644 ${environmentFile} "$out/etc/environment"
    install -m 0644 ${profileFile} "$out/etc/profile"
    install -m 0644 ${bashrcFile} "$out/etc/bash.bashrc"
    install -m 0644 ${localeFile} "$out/etc/locale.conf"
    install -m 0440 ${sudoersFile} "$out/etc/sudoers"
    install -m 0440 ${vscodeSudoersFile} "$out/etc/sudoers.d/vscode"
    install -m 0644 ${pkgs.iana-etc}/etc/protocols "$out/etc/protocols"
    install -m 0644 ${pkgs.iana-etc}/etc/services "$out/etc/services"
    install -m 0644 ${slimTzdata}/share/zoneinfo/UTC "$out/etc/localtime"
    install -m 0644 ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt \
      "$out/etc/ssl/certs/ca-certificates.crt"
    ln -s certs/ca-certificates.crt "$out/etc/ssl/cert.pem"
    ln -s ../../../ssl/certs/ca-certificates.crt \
      "$out/etc/pki/tls/certs/ca-bundle.crt"

    install -m 0644 ${userBashrcFile} "$out/home/vscode/.bashrc"
    install -m 0644 ${userProfileFile} "$out/home/vscode/.profile"
    install -m 0644 ${userBashrcFile} "$out/root/.bashrc"
    install -m 0644 ${userProfileFile} "$out/root/.profile"

    ln -s ${toolProfile} "$out/opt/devcontainer/profile"
    ln -s ${nixLdProfile} "$out/opt/devcontainer/nix-ld"
    # Buck's test runner sanitizes its environment, including NIX_LD and
    # NIX_LD_LIBRARY_PATH. Supply nix-ld's conventional fallback location so
    # hermetic foreign executables continue to work in that environment.
    ln -s /opt/devcontainer/nix-ld \
      "$out/run/current-system/sw/share/nix-ld"
    ln -s /opt/devcontainer/profile/bin/bash "$out/bin/bash"
    ln -s /opt/devcontainer/profile/bin/bash "$out/bin/sh"
    ln -s /opt/devcontainer/profile/bin/bash "$out/usr/bin/bash"
    ln -s /opt/devcontainer/profile/bin/bash "$out/usr/bin/sh"
    ln -s /opt/devcontainer/profile/bin/env "$out/usr/bin/env"
    ln -s /opt/devcontainer/profile/bin/getent "$out/usr/bin/getent"
    ln -s /opt/devcontainer/profile/bin/ldd "$out/usr/bin/ldd"
    ln -s /opt/devcontainer/profile/bin/nologin "$out/usr/sbin/nologin"
    ln -s /opt/devcontainer/profile/share/terminfo "$out/usr/share/terminfo"
    ln -s ${slimTzdata}/share/zoneinfo "$out/usr/share/zoneinfo"
    ln -s /proc/mounts "$out/etc/mtab"
    ln -s ${pkgs.nix-ld}/libexec/nix-ld "$out/${loaderDirectory}/${loaderName}"

    install -m 0755 ${lib.getExe sudoNoPam} "$out/usr/bin/sudo"

    ${lib.getExe' sudoNoPam "visudo"} -c -I -f "$out/etc/sudoers"
    ${lib.getExe' sudoNoPam "visudo"} -c -I -f "$out/etc/sudoers.d/vscode"
  '';
  # Most Nix packages capture stdenv's glibc outputs. Propagate their
  # layout-compatible slim counterparts through the completed root closure
  # without rebuilding every tool. Replacing every relevant output directly
  # also avoids retaining copied glibc-bin/glibc-dev siblings alongside the
  # slim outputs. The slim derivation does not depend on this completed root,
  # so replaceDependencies needs no recursion cutoff here.
  #
  # Nixpkgs documents rare checksum-sensitive cases, so the build check and
  # container acceptance suite exercise the rewritten binaries rather than
  # relying on closure inspection alone.
  rootFiles = pkgs.replaceDependencies {
    drv = unrewrittenRootFiles;
    replacements = glibcReplacements;
    verbose = false;
  };
  imageRuntimeClosure = pkgs.closureInfo {
    rootPaths = [ rootFiles ];
  };

  imageEnvironment = [
    "HOME=/home/vscode"
    "USER=vscode"
    "LOGNAME=vscode"
    "SHELL=/bin/bash"
    "PATH=/opt/devcontainer/profile/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "LANG=C.UTF-8"
    "LC_ALL=C.UTF-8"
    "TERM=xterm-256color"
    "TZ=UTC"
    "TZDIR=/usr/share/zoneinfo"
    "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
    "NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
    "GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt"
    "NIX_LD=${nixLdPath}/ld.so"
    "NIX_LD_LIBRARY_PATH=${nixLdPath}"
    "LIBCLANG_PATH=/opt/devcontainer/profile/lib"
  ];

  imageArgs = {
    name = imageName;
    tag = imageTag;
    architecture = imageArchitecture;
    created = imageCreated;
    mtime = imageCreated;
    maxLayers = 120;
    includeNixDB = false;
    contents = [ rootFiles ];
    extraCommands = ''
      rm -rf \
        ./bin \
        ./etc \
        ./home \
        ./lib \
        ./lib64 \
        ./opt \
        ./root \
        ./run \
        ./sbin \
        ./tmp \
        ./usr \
        ./var \
        ./vscode \
        ./workspaces
      cp -a ${rootFiles}/. .
    '';
    fakeRootCommands = ''
      chown -hR 0:0 .
      chown -hR 1000:1000 ./home/vscode ./var/devcontainer ./vscode ./workspaces
      find ./etc -type d -exec chmod 0755 {} +
      find ./etc -type f -exec chmod 0644 {} +
      chmod 0644 ./home/vscode/.bashrc ./home/vscode/.profile ./root/.bashrc ./root/.profile
      chmod 0755 ./home/vscode ./workspaces
      chmod 0700 ./root
      # updateRemoteUserUID recursively remaps the home, but not the two Dev
      # Container state roots. Keep those writable after an arbitrary UID map.
      chmod 1777 ./tmp ./var/tmp ./var/devcontainer ./vscode
      chmod 0600 ./etc/shadow ./etc/gshadow
      chmod 0440 ./etc/sudoers ./etc/sudoers.d/vscode
      chown 0:0 ./usr/bin/sudo
      chmod 4755 ./usr/bin/sudo
    '';
    config = {
      User = "vscode";
      WorkingDir = "/workspaces";
      Cmd = [ "/bin/sh" ];
      Env = imageEnvironment;
      Labels = {
        "org.opencontainers.image.title" = "thoughtpolice/a development container";
        "org.opencontainers.image.description" =
          "Pure-Nix Rust and editor development environment for thoughtpolice/a";
        "org.opencontainers.image.source" = "https://github.com/thoughtpolice/a";
        "org.opencontainers.image.revision" = imageRevision;
        "org.opencontainers.image.licenses" = "Apache-2.0";
      };
    };
    passthru = {
      inherit
        imageArchitecture
        imageCreated
        imageEnvironment
        loaderPath
        nixLdProfile
        rootFiles
        rustTargets
        rustToolchain
        toolProfile
        ;
    };
    meta = {
      description = "Pure-Nix multi-architecture development container image";
      license = lib.licenses.asl20;
      platforms = [ system ];
    };
  };

  devcontainerImage = pkgs.dockerTools.buildLayeredImage (
    imageArgs
    // {
      compressor = "gz";
    }
  );
  devcontainerImageStream = pkgs.dockerTools.streamLayeredImage imageArgs;

  # Loader and compiler-wrapper behavior is architecture-sensitive. CI must
  # build this semantic check natively on both supported Linux architectures.
  devcontainerCheck = pkgs.runCommand "devcontainer-image-check" { } ''
    export HOME="$TMPDIR/home"
    export PATH="${toolProfile}/bin:$PATH"
    export CARGO_NET_OFFLINE=true
    mkdir -p "$HOME"

    ${rustToolchain}/bin/rustc --version | grep -E '^rustc 1\.96\.0-nightly '
    ${rustToolchain}/bin/cargo --version | grep -E '^cargo 1\.96\.0-nightly '
    ${rustToolchain}/bin/clippy-driver --version
    ${rustToolchain}/bin/rustfmt --version
    ${rustToolchain}/bin/rust-analyzer --version
    test "$(${lib.getExe bindgen} --version)" = "bindgen 0.72.1"
    test -z "$(find ${rustToolchain}/lib -maxdepth 1 \
      -name 'librustc_driver*' -print -quit)"
    test -z "$(find ${rustToolchain}/lib/rustlib \
      -name wasm-component-ld -print -quit)"
    test ! -e ${rustToolchain}/lib/rustlib/etc
    test ! -e ${rustToolchain}/bin/rust-gdb
    test ! -e ${rustToolchain}/bin/rust-lldb
    test "$(${rustToolchain}/bin/rustc --print sysroot)" = \
      '${rustToolchain}'
    test "$(${rustToolchain}/bin/rustc --sysroot= --print sysroot)" = \
      '${rustToolchain}'
    ${rustToolchain}/bin/rustc \
      "--print=cfg=$TMPDIR/rustc-cfg" \
      --sysroot=
    test -s "$TMPDIR/rustc-cfg"

    mkdir -p "$TMPDIR/rust-smoke/src"
    cat > "$TMPDIR/rust-smoke/Cargo.toml" <<'EOF'
    [package]
    name = "devcontainer-rust-smoke"
    version = "0.0.0"
    edition = "2024"
    EOF
    cat > "$TMPDIR/rust-smoke/src/lib.rs" <<'EOF'
    pub fn add(left: usize, right: usize) -> usize {
        left + right
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn addition_works() {
            assert_eq!(super::add(20, 22), 42);
        }
    }
    EOF
    export CARGO_TARGET_DIR="$TMPDIR/rust-smoke-target"
    ${rustToolchain}/bin/cargo check \
      --offline --manifest-path "$TMPDIR/rust-smoke/Cargo.toml"
    ${rustToolchain}/bin/cargo test \
      --offline --manifest-path "$TMPDIR/rust-smoke/Cargo.toml"
    ${rustToolchain}/bin/cargo clippy \
      --offline --manifest-path "$TMPDIR/rust-smoke/Cargo.toml" \
      -- -D warnings
    ${rustToolchain}/bin/cargo fmt \
      --manifest-path "$TMPDIR/rust-smoke/Cargo.toml" -- --check
    ${rustToolchain}/bin/cargo doc \
      --offline --no-deps --manifest-path "$TMPDIR/rust-smoke/Cargo.toml"
    # rust-analyzer may fail an offline cargo-metadata probe of bundled
    # rust-src (currently at hashbrown), then intentionally retry with
    # --no-deps. The diagnostics command's final exit status is authoritative.
    ${rustToolchain}/bin/rust-analyzer diagnostics \
      "$TMPDIR/rust-smoke" \
      --disable-build-scripts \
      --disable-proc-macros

    cat > "$TMPDIR/devcontainer-rust.rs" <<'EOF'
    fn main() { println!("devcontainer-rust"); }
    EOF
    ${rustToolchain}/bin/rustc \
      -C embed-bitcode=yes \
      -C lto=fat \
      "$TMPDIR/devcontainer-rust.rs" \
      -o "$TMPDIR/devcontainer-rust"
    test "$("$TMPDIR/devcontainer-rust")" = devcontainer-rust

    cat > "$TMPDIR/devcontainer-target.rs" <<'EOF'
    pub fn devcontainer_target() -> String { String::from("ok") }
    EOF

    cat > "$TMPDIR/devcontainer-bindgen.h" <<'EOF'
    int devcontainer_add(int left, int right);
    EOF
    ${lib.getExe bindgen} \
      "$TMPDIR/devcontainer-bindgen.h" \
      --allowlist-function devcontainer_add \
      --output "$TMPDIR/devcontainer-bindgen.rs"
    grep -q 'pub fn devcontainer_add' "$TMPDIR/devcontainer-bindgen.rs"

    for target in ${lib.escapeShellArgs rustTargets}; do
      test -d "${rustToolchain}/lib/rustlib/$target/lib"
      test -n "$(find "${rustToolchain}/lib/rustlib/$target/lib" -name 'libcore-*.rlib' -print -quit)"
      test -n "$(find "${rustToolchain}/lib/rustlib/$target/lib" -name 'libstd-*.rlib' -print -quit)"
      test -n "$(find "${rustToolchain}/lib/rustlib/$target/lib" -name 'libcore-*.rmeta' -print -quit)"

      mkdir "$TMPDIR/rust-$target"
      ${rustToolchain}/bin/rustc \
        --crate-name devcontainer_target \
        --crate-type lib \
        --emit=metadata,obj \
        --target "$target" \
        --out-dir "$TMPDIR/rust-$target" \
        "$TMPDIR/devcontainer-target.rs"
      test -n "$(find "$TMPDIR/rust-$target" -name '*.rmeta' -print -quit)"
      test -n "$(find "$TMPDIR/rust-$target" -name '*.o' -print -quit)"
    done

    cat > "$TMPDIR/devcontainer-uefi.rs" <<'EOF'
    fn main() {}
    EOF
    for target in aarch64-unknown-uefi x86_64-unknown-uefi; do
      output="$TMPDIR/devcontainer-$target.efi"
      ${rustToolchain}/bin/rustc \
        --target "$target" \
        "$TMPDIR/devcontainer-uefi.rs" \
        -o "$output"
      ${toolProfile}/bin/file "$output" \
        | grep -F 'PE32+ executable (EFI application)'
      case "$target" in
        aarch64-*) ${toolProfile}/bin/file "$output" | grep -F Aarch64 ;;
        x86_64-*) ${toolProfile}/bin/file "$output" | grep -F x86-64 ;;
      esac
    done
    test -z "$(find "${rustToolchain}/lib/rustlib" \
      -name 'librustc-nightly_rt.*.a' -print -quit)"

    ${toolProfile}/bin/bash --version >/dev/null
    test "$(
      printf 'skip\nanswer=21\n' \
        | ${toolProfile}/bin/grep '^answer=' \
        | ${toolProfile}/bin/sed 's/.*=//' \
        | ${toolProfile}/bin/awk '{ print $1 * 2 }'
    )" = 42
    mkdir -p "$TMPDIR/compat-source" "$TMPDIR/compat-destination"
    printf 'devcontainer compatibility\n' \
      > "$TMPDIR/compat-source/payload"
    ${toolProfile}/bin/tar -czf "$TMPDIR/compat.tar.gz" \
      -C "$TMPDIR/compat-source" payload
    ${toolProfile}/bin/tar -xzf "$TMPDIR/compat.tar.gz" \
      -C "$TMPDIR/compat-destination"
    ${toolProfile}/bin/diff \
      "$TMPDIR/compat-source/payload" \
      "$TMPDIR/compat-destination/payload"
    test "$(${toolProfile}/bin/find "$TMPDIR/compat-destination" \
      -type f -name payload -print -quit)" = \
      "$TMPDIR/compat-destination/payload"
    ${toolProfile}/bin/wget --version >/dev/null
    printf 'devcontainer zstd\n' > "$TMPDIR/zstd-input"
    ${toolProfile}/bin/zstd --quiet \
      "$TMPDIR/zstd-input" -o "$TMPDIR/zstd-input.zst"
    test "$(${toolProfile}/bin/zstdgrep devcontainer \
      "$TMPDIR/zstd-input.zst")" = 'devcontainer zstd'
    ${toolProfile}/bin/getent passwd root >/dev/null
    test -x ${toolProfile}/bin/nologin
    ${toolProfile}/bin/git --version
    test -L ${slimGit}/bin/git
    test "$(readlink ${slimGit}/bin/git)" = ../libexec/git-core/git
    test ! -e ${slimGit}/share/git-gui
    test ! -e ${slimGit}/bin/git-shell
    test ! -e ${slimGit}/bin/scalar
    test ! -e ${slimGit}/libexec/git-core/git-daemon
    test ! -e ${slimGit}/libexec/git-core/git-http-backend
    if grep -R -F '${pkgs.gettext}' ${slimGit}; then
      exit 1
    fi
    ${toolProfile}/bin/git init --quiet "$TMPDIR/git-source"
    ${toolProfile}/bin/git -C "$TMPDIR/git-source" \
      config user.name 'Devcontainer Check'
    ${toolProfile}/bin/git -C "$TMPDIR/git-source" \
      config user.email devcontainer@example.invalid
    ${toolProfile}/bin/git -C "$TMPDIR/git-source" \
      commit --allow-empty --message initial --quiet
    ${toolProfile}/bin/git clone \
      --quiet "$TMPDIR/git-source" "$TMPDIR/git-clone"
    ${toolProfile}/bin/git -C "$TMPDIR/git-clone" fsck --no-dangling
    test "$(${toolProfile}/bin/git -C "$TMPDIR/git-clone" \
      log -1 --format=%s)" = initial
    ${toolProfile}/bin/node --version
    ${toolProfile}/bin/npm --version
    ${toolProfile}/bin/npx --version
    test "$(${toolProfile}/bin/node \
      --print 'process.config.variables.node_prefix')" = "${nodeRuntime}"
    test "$(${toolProfile}/bin/node \
      --print 'process.config.variables.icu_small')" = true
    test "$(${toolProfile}/bin/node --print \
      'new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(new Date("2026-01-01"))')" \
      = January
    test ! -e ${toolProfile}/bin/corepack

    mkdir -p \
      "$TMPDIR/node-local-package/bin" \
      "$TMPDIR/node-consumer"
    cat > "$TMPDIR/node-local-package/package.json" <<'EOF'
    {
      "name": "devcontainer-local-cli",
      "version": "0.0.0",
      "bin": { "devcontainer-local-cli": "bin/cli.js" }
    }
    EOF
    cat > "$TMPDIR/node-local-package/bin/cli.js" <<EOF
    #!${nodeRuntime}/bin/node
    console.log("local-cli:" + process.argv.slice(2).join(","));
    EOF
    chmod +x "$TMPDIR/node-local-package/bin/cli.js"
    cat > "$TMPDIR/node-consumer/package.json" <<'EOF'
    { "name": "devcontainer-node-smoke", "version": "0.0.0" }
    EOF
    (
      cd "$TMPDIR/node-consumer"
      export npm_config_cache="$TMPDIR/npm-cache"
      ${toolProfile}/bin/npm install \
        --ignore-scripts \
        --no-audit \
        --no-fund \
        --offline \
        "$TMPDIR/node-local-package"
      test "$(${toolProfile}/bin/npx \
        --no-install \
        --offline \
        devcontainer-local-cli alpha beta)" = 'local-cli:alpha,beta'
    )

    ${toolProfile}/bin/clang --version
    ${toolProfile}/bin/clang++ --version
    grep -Fx -- '-L${libstdcxxLibcxxCompat}/lib' \
      ${clangCompiler}/nix-support/cc-ldflags
    ${toolProfile}/bin/clangd --version
    ${toolProfile}/bin/ld.lld --version
    ${toolProfile}/bin/lld -flavor gnu --version
    ${toolProfile}/bin/ld.bfd --version | grep -F 'GNU ld'
    ${toolProfile}/bin/objdump --version | grep -F 'GNU objdump'
    test ! -e ${toolProfile}/bin/ld.gold
    test ! -e ${toolProfile}/bin/dwp
    test ! -e ${toolProfile}/bin/gprof
    ${toolProfile}/bin/mold --version
    ${toolProfile}/bin/dotslash --version
    ${toolProfile}/bin/watchman --version
    ${toolProfile}/bin/readelf -d ${watchmanRuntime}/bin/watchman \
      > "$TMPDIR/watchman-dynamic"
    grep -F 'libedencommon_utils.so' "$TMPDIR/watchman-dynamic"
    grep -F 'libfolly.so.' "$TMPDIR/watchman-dynamic"
    if grep -E 'fb303|fbthrift|fizz|wangle|mvfst|telemetry' \
      "$TMPDIR/watchman-dynamic"; then
      exit 1
    fi
    ${toolProfile}/bin/ldd -r ${watchmanRuntime}/bin/watchman \
      > "$TMPDIR/watchman-ldd"
    if grep -E 'not found|undefined symbol|libicu' \
      "$TMPDIR/watchman-ldd"; then
      exit 1
    fi
    ${toolProfile}/bin/ip -Version
    ${toolProfile}/bin/ss --version
    ${toolProfile}/bin/ps --version
    ${toolProfile}/bin/free --version
    ${toolProfile}/bin/pgrep --version
    ${toolProfile}/bin/watch --version
    ${toolProfile}/bin/ps -p $$ >/dev/null
    ${toolProfile}/bin/free --bytes >/dev/null
    ${toolProfile}/bin/mount --version
    ${toolProfile}/bin/ssh -V 2>&1 | grep -E '^OpenSSH_'
    ${toolProfile}/bin/ssh -Q key | grep -Fx sk-ssh-ed25519@openssh.com
    ${toolProfile}/bin/useradd --help >/dev/null
    test -x ${toolProfile}/libexec/ssh-sk-helper
    test ! -e ${toolProfile}/bin/sshd
    test ! -e ${toolProfile}/libexec/sftp-server
    test -e ${slimLibfido2}/lib/libfido2.so.1
    test ! -e ${slimLibfido2}/lib/libfido2.a
    test ! -e ${slimLibfido2}/bin
    test -e ${libudevRuntime}/lib/libudev.so.1
    test ! -e ${libudevRuntime}/lib/libsystemd.so
    ${toolProfile}/bin/ldd -r ${slimLibfido2}/lib/libfido2.so.1 \
      | grep -F '${libudevRuntime}/lib/libudev.so.1'

    test "$(
      TZDIR=${slimTzdata}/share/zoneinfo \
        TZ=America/Chicago \
        ${toolProfile}/bin/date --date='2026-07-18 12:00 UTC' +%Z
    )" = CDT

    ${toolProfile}/bin/clang --print-targets \
      | grep -E '^ +aarch64 +- AArch64'
    ${toolProfile}/bin/clang --print-targets \
      | grep -E '^ +x86-64 +- 64-bit X86'

    cat > "$TMPDIR/devcontainer-c.c" <<'EOF'
    int main(void) { return 0; }
    EOF
    cat > "$TMPDIR/devcontainer-cxx.cc" <<'EOF'
    #include <iostream>
    int main() { std::cout << "devcontainer"; }
    EOF
    ${toolProfile}/bin/clang \
      "$TMPDIR/devcontainer-c.c" -o "$TMPDIR/devcontainer-c"
    "$TMPDIR/devcontainer-c"
    ${toolProfile}/bin/clang \
      -fuse-ld=mold \
      "$TMPDIR/devcontainer-c.c" \
      -o "$TMPDIR/devcontainer-c-mold"
    "$TMPDIR/devcontainer-c-mold"
    ${toolProfile}/bin/readelf \
      --string-dump=.comment \
      "$TMPDIR/devcontainer-c-mold" \
      | grep -F mold
    ${toolProfile}/bin/clang++ \
      "$TMPDIR/devcontainer-cxx.cc" -o "$TMPDIR/devcontainer-cxx"
    test "$("$TMPDIR/devcontainer-cxx")" = devcontainer
    ${toolProfile}/bin/clang++ \
      -fsanitize=address \
      -static-libsan \
      "$TMPDIR/devcontainer-cxx.cc" \
      -o "$TMPDIR/devcontainer-cxx-asan"
    ASAN_OPTIONS=detect_leaks=0 \
      "$TMPDIR/devcontainer-cxx-asan" \
      > "$TMPDIR/devcontainer-cxx-asan.stdout"
    test "$(<"$TMPDIR/devcontainer-cxx-asan.stdout")" = devcontainer
    test "$(${toolProfile}/bin/nm --defined-only \
      "$TMPDIR/devcontainer-cxx-asan" \
      | grep -c ' __asan_init$')" -eq 1
    if ${toolProfile}/bin/readelf -d "$TMPDIR/devcontainer-cxx-asan" \
      | grep -E 'NEEDED.*(libasan|libclang_rt\.asan)'; then
      exit 1
    fi

    cat > "$TMPDIR/devcontainer-asan-failure.c" <<'EOF'
    // SPDX-FileCopyrightText: © 2026 Austin Seipp
    // SPDX-License-Identifier: Apache-2.0
    #include <stdlib.h>
    int main(void) {
      volatile char *allocation = malloc(8);
      volatile unsigned offset = 8;
      allocation[offset] = 1;
      free((void *)allocation);
      return 0;
    }
    EOF
    ${toolProfile}/bin/clang \
      -fsanitize=address \
      -static-libsan \
      "$TMPDIR/devcontainer-asan-failure.c" \
      -o "$TMPDIR/devcontainer-asan-failure"
    if ASAN_OPTIONS=detect_leaks=0 \
      "$TMPDIR/devcontainer-asan-failure" \
      2> "$TMPDIR/devcontainer-asan-failure.log"; then
      exit 1
    fi
    grep -F 'AddressSanitizer: heap-buffer-overflow' \
      "$TMPDIR/devcontainer-asan-failure.log"

    cat > "$TMPDIR/devcontainer-rust-asan.rs" <<'EOF'
    // SPDX-FileCopyrightText: © 2026 Austin Seipp
    // SPDX-License-Identifier: Apache-2.0
    fn main() {
        let layout = std::alloc::Layout::from_size_align(8, 1).unwrap();
        unsafe {
            let allocation = std::alloc::alloc(layout);
            let offset = std::hint::black_box(8_usize);
            std::ptr::write_volatile(allocation.add(offset), 1_u8);
            std::alloc::dealloc(allocation, layout);
        }
    }
    EOF
    ${rustToolchain}/bin/rustc \
      -C debuginfo=line-tables-only \
      -C force-frame-pointers=yes \
      -C linker=${toolProfile}/bin/clang++ \
      -C link-arg=-fuse-ld=lld \
      -C link-arg=-fsanitize=address \
      -C link-arg=-static-libsan \
      -C link-arg=-static-libgcc \
      -C link-arg=-static-libstdc++ \
      -C panic=abort \
      -Z external-clangrt \
      -Z sanitizer=address \
      "$TMPDIR/devcontainer-rust-asan.rs" \
      -o "$TMPDIR/devcontainer-rust-asan"
    test "$(${toolProfile}/bin/nm --defined-only \
      "$TMPDIR/devcontainer-rust-asan" \
      | grep -c ' __asan_init$')" -eq 1
    if ${toolProfile}/bin/readelf -d "$TMPDIR/devcontainer-rust-asan" \
      | grep -E 'NEEDED.*(libasan|libclang_rt\.asan)'; then
      exit 1
    fi
    if ASAN_OPTIONS=allow_addr2line=1:detect_leaks=0 \
      "$TMPDIR/devcontainer-rust-asan" \
      2> "$TMPDIR/devcontainer-rust-asan.log"; then
      exit 1
    fi
    grep -F 'AddressSanitizer: heap-buffer-overflow' \
      "$TMPDIR/devcontainer-rust-asan.log"
    grep -F 'devcontainer-rust-asan.rs:' \
      "$TMPDIR/devcontainer-rust-asan.log"
    ${toolProfile}/bin/clang \
      --target=aarch64-unknown-linux-gnu \
      -c "$TMPDIR/devcontainer-c.c" \
      -o "$TMPDIR/devcontainer-aarch64.o"
    ${toolProfile}/bin/clang \
      --target=x86_64-unknown-linux-gnu \
      -c "$TMPDIR/devcontainer-c.c" \
      -o "$TMPDIR/devcontainer-x86_64.o"
    ${toolProfile}/bin/file "$TMPDIR/devcontainer-aarch64.o" \
      | grep -F 'ARM aarch64'
    ${toolProfile}/bin/file "$TMPDIR/devcontainer-x86_64.o" \
      | grep -F 'x86-64'
    ${toolProfile}/bin/clangd \
      --check="$TMPDIR/devcontainer-cxx.cc" \
      --log=error

    compiler_rt=${slimLlvmPackages.compiler-rt}
    test "$(find "$compiler_rt/lib" -type f \
      -name 'libclang_rt.builtins-*.a' | wc -l)" -eq 1
    test "$(find "$compiler_rt/lib" -type f \
      -name 'clang_rt.crtbegin-*.o' | wc -l)" -eq 1
    test "$(find "$compiler_rt/lib" -type f \
      -name 'clang_rt.crtend-*.o' | wc -l)" -eq 1
    test -L ${compilerRtGccCompat}/lib/libgcc.a
    test "$(find "$compiler_rt/lib" -type f \
      -name 'libclang_rt.asan-*.a' | wc -l)" -eq 1
    test "$(find "$compiler_rt/lib" -type f \
      -name 'libclang_rt.asan-preinit-*.a' | wc -l)" -eq 1
    test -z "$(find "$compiler_rt/lib" -type f \
      \( -iname '*msan*' \
      -o -iname '*tsan*' \
      -o -iname '*hwasan*' \
      -o -iname '*dfsan*' \
      -o -iname '*rtsan*' \
      -o -iname '*tysan*' \
      -o -iname '*nsan*' \
      -o -iname '*scudo*' \
      -o -iname '*fuzzer*' \
      -o -iname '*xray*' \
      -o -iname '*profile*' \
      -o -iname '*orc*' \) \
      -print -quit)"

    test -z "$(find ${lib.getLib slimLlvmPackages.libllvm}/lib \
      -maxdepth 1 -type f -name '*.a' -print -quit)"
    test -z "$(find ${lib.getLib slimLlvmPackages.libclang}/lib \
      -maxdepth 1 -type f -name '*.a' -print -quit)"
    libclang_so="$(readlink -f \
      ${lib.getLib slimLlvmPackages.libclang}/lib/libclang.so)"
    test "$(stat --format=%s "$libclang_so")" -lt 4194304
    ${toolProfile}/bin/readelf -d "$libclang_so" \
      | grep -F 'libclang-cpp.so'
    ${toolProfile}/bin/nm --dynamic --defined-only --demangle \
      ${lib.getLib slimLlvmPackages.libclang}/lib/libclang-cpp.so \
      > "$TMPDIR/libclang-cpp-symbols"
    # clangAnalysis retains lightweight path-diagnostic types in the ento
    # namespace even when the static analyzer is disabled. Its analysis engine
    # and checker implementation must remain absent.
    if grep -E 'clang::ento::(ExprEngine|CheckerManager|BugReporter)' \
      "$TMPDIR/libclang-cpp-symbols"; then
      exit 1
    fi
    ${toolProfile}/bin/ldd -r "$libclang_so" \
      > "$TMPDIR/libclang-ldd"
    if grep -E 'not found|undefined symbol' "$TMPDIR/libclang-ldd"; then
      exit 1
    fi
    test -L ${lib.getBin slimLlvmPackages.lld}/bin/lld
    test "$(readlink ${lib.getBin slimLlvmPackages.lld}/bin/lld)" = ld.lld

    llvm_archive_count=0
    while IFS= read -r -d $'\0' archive; do
      llvm_archive_count=$((llvm_archive_count + 1))
      test -n "$(${toolProfile}/bin/ar t "$archive")"
    done < <(
      find ${lib.getDev slimLlvmPackages.libllvm}/lib/llvm-static \
        -maxdepth 1 -type f -name '*.a' -print0
    )
    test "$llvm_archive_count" -gt 0
    test -e \
      ${lib.getDev slimLlvmPackages.libllvm}/lib/cmake/llvm/LLVMExports-minsizerel.cmake
    grep -R -F \
      '${lib.getDev slimLlvmPackages.libllvm}/lib/llvm-static/lib' \
      ${lib.getDev slimLlvmPackages.libllvm}/lib/cmake/llvm \
      >/dev/null
    test -z "$(
      grep -R -F \
        '${lib.getLib slimLlvmPackages.libllvm}/lib/lib' \
        ${lib.getDev slimLlvmPackages.libllvm}/lib/cmake/llvm \
        | grep -F '.a' \
        || true
    )"

    for forbidden_path in ${lib.escapeShellArgs stockRuntimePaths}; do
      if grep -Fx "$forbidden_path" ${imageRuntimeClosure}/store-paths; then
        exit 1
      fi
    done
    for forbidden_pattern in \
      '-clang-tools-[^/]+$' \
      '-icu4c-[^/]+$' \
      '-linux-pam-[^/]+$' \
      '-python3-[^/]+$' \
      '-systemd-minimal-libs-[^/]+$'; do
      if grep -E -- "$forbidden_pattern" \
        ${imageRuntimeClosure}/store-paths; then
        exit 1
      fi
    done

    test -e ${lib.getLib slimLibsecret}/lib/libsecret-1.so.0
    test ! -e ${lib.getLib slimLibsecret}/bin
    test ! -e ${slimGlib}/share/locale
    test ! -e ${slimGlibc}/share/i18n
    test ! -e ${slimGlibc}/share/locale
    test -d ${slimGlibc}/lib/locale/C.utf8
    for glibc_output in ${lib.escapeShellArgs requiredSlimGlibcOutputs}; do
      grep -Fx "$glibc_output" ${imageRuntimeClosure}/store-paths >/dev/null
    done
    for runtime in \
      ${bashRuntime} \
      ${diffutilsRuntime} \
      ${findutilsRuntime} \
      ${gawkRuntime} \
      ${grepRuntime} \
      ${sedRuntime} \
      ${tarRuntime} \
      ${wgetRuntime}; do
      test ! -e "$runtime/share/locale"
      test ! -e "$runtime/share/man"
    done

    for library in \
      'libbz2.so.*' \
      'libc.so.*' \
      'libcrypto.so.*' \
      'libgio-2.0.so.*' \
      'libgirepository-2.0.so.*' \
      'libglib-2.0.so.*' \
      'libgmodule-2.0.so.*' \
      'libgobject-2.0.so.*' \
      'libgthread-2.0.so.*' \
      'liblzma.so.*' \
      'libsecret-1.so.*' \
      'libssl.so.*' \
      'libstdc++.so.*' \
      'libxml2.so.*' \
      'libz.so.*' \
      'libzstd.so.*'; do
      test -n "$(find ${nixLdProfile}/lib -maxdepth 1 -name "$library" -print -quit)"
    done
    test "$(readlink ${nixLdProfile}/lib/ld.so)" = \
      "${slimGlibc}/lib/${loaderName}"
    test -L ${rootFiles}/run/current-system/sw/share/nix-ld
    test "$(readlink ${rootFiles}/run/current-system/sw/share/nix-ld)" = \
      /opt/devcontainer/nix-ld

    test -f ${rootFiles}/etc/passwd
    test ! -L ${rootFiles}/etc/passwd
    test -f ${rootFiles}/etc/group
    test ! -L ${rootFiles}/etc/group
    test -f ${rootFiles}/etc/shadow
    test ! -L ${rootFiles}/etc/shadow
    test -f ${rootFiles}/etc/gshadow
    test ! -L ${rootFiles}/etc/gshadow
    test -f ${rootFiles}/etc/profile
    test ! -L ${rootFiles}/etc/profile
    test -f ${rootFiles}/etc/environment
    test ! -L ${rootFiles}/etc/environment
    test -f ${rootFiles}/etc/nsswitch.conf
    test ! -L ${rootFiles}/etc/nsswitch.conf
    test -f ${rootFiles}/etc/os-release
    test ! -L ${rootFiles}/etc/os-release
    test -f ${rootFiles}/etc/ssl/certs/ca-certificates.crt
    test ! -L ${rootFiles}/etc/ssl/certs/ca-certificates.crt
    test -L ${rootFiles}/etc/ssl/cert.pem
    test "$(readlink ${rootFiles}/etc/ssl/cert.pem)" = \
      certs/ca-certificates.crt
    test -L ${rootFiles}/etc/pki/tls/certs/ca-bundle.crt
    test "$(readlink ${rootFiles}/etc/pki/tls/certs/ca-bundle.crt)" = \
      ../../../ssl/certs/ca-certificates.crt
    test -f ${rootFiles}/etc/localtime
    test ! -L ${rootFiles}/etc/localtime
    test -L ${rootFiles}/usr/share/terminfo
    test -L ${rootFiles}/usr/share/zoneinfo
    test "$(readlink ${rootFiles}/usr/share/zoneinfo)" = "${slimTzdata}/share/zoneinfo"
    test ! -e ${rootFiles}/usr/share/zoneinfo/right
    test -L ${rootFiles}${loaderPath}
    case "$(readlink ${rootFiles}${loaderPath})" in
      /nix/store/*/libexec/nix-ld) ;;
      *) exit 1 ;;
    esac
    test -x ${rootFiles}/usr/bin/sudo
    test ! -L ${rootFiles}/usr/bin/sudo
    test ! -e ${rootFiles}/nix/var/nix/db
    test ! -e ${toolProfile}/bin/nix
    if grep -q '^LD_LIBRARY_PATH=' ${environmentFile}; then
      exit 1
    fi

    ${lib.getExe' sudoNoPam "visudo"} -c -I -f ${rootFiles}/etc/sudoers
    ${lib.getExe' sudoNoPam "visudo"} -c -I -f ${rootFiles}/etc/sudoers.d/vscode

    # Exercise representative binaries through the recursively rewritten
    # profile. This is the exact closure copied into the OCI image, not the
    # pre-replacement build inputs used by the more detailed checks above.
    rewritten_profile=${rootFiles}/opt/devcontainer/profile
    test "$(LC_ALL=C.UTF-8 "$rewritten_profile/bin/locale" charmap)" = UTF-8
    printf '\303\251' > "$TMPDIR/iconv-utf8"
    "$rewritten_profile/bin/iconv" \
      -f UTF-8 -t UTF-16LE \
      "$TMPDIR/iconv-utf8" > "$TMPDIR/iconv-utf16"
    "$rewritten_profile/bin/iconv" \
      -f UTF-16LE -t UTF-8 \
      "$TMPDIR/iconv-utf16" > "$TMPDIR/iconv-roundtrip"
    "$rewritten_profile/bin/cmp" \
      "$TMPDIR/iconv-utf8" "$TMPDIR/iconv-roundtrip"
    "$rewritten_profile/bin/getent" hosts localhost >/dev/null
    test "$("$rewritten_profile/bin/node" \
      --print 'process.config.variables.icu_small')" = true
    test "$("$rewritten_profile/bin/bindgen" --version)" = 'bindgen 0.72.1'
    "$rewritten_profile/bin/watchman" --version

    mkdir "$TMPDIR/rewritten-git"
    "$rewritten_profile/bin/git" -C "$TMPDIR/rewritten-git" init --quiet
    "$rewritten_profile/bin/git" -C "$TMPDIR/rewritten-git" \
      config user.name 'Dev Container Check'
    "$rewritten_profile/bin/git" -C "$TMPDIR/rewritten-git" \
      config user.email devcontainer@example.invalid
    printf 'rewritten\n' > "$TMPDIR/rewritten-git/probe"
    "$rewritten_profile/bin/git" -C "$TMPDIR/rewritten-git" add probe
    "$rewritten_profile/bin/git" -C "$TMPDIR/rewritten-git" \
      commit --quiet --message rewritten
    test "$("$rewritten_profile/bin/git" -C "$TMPDIR/rewritten-git" \
      log -1 --format=%s)" = rewritten

    cat > "$TMPDIR/rewritten.c" <<'EOF'
    int main(void) { return 0; }
    EOF
    "$rewritten_profile/bin/clang" \
      "$TMPDIR/rewritten.c" -o "$TMPDIR/rewritten-c"
    "$TMPDIR/rewritten-c"
    cat > "$TMPDIR/rewritten.rs" <<'EOF'
    fn main() { println!("rewritten"); }
    EOF
    "$rewritten_profile/bin/rustc" \
      -C embed-bitcode=yes \
      -C lto=fat \
      "$TMPDIR/rewritten.rs" \
      -o "$TMPDIR/rewritten-rust"
    test "$("$TMPDIR/rewritten-rust")" = rewritten

    touch "$out"
  '';
in
assert lib.assertMsg (
  rustToolchain.version == "1.96.0-nightly-${rustNightlyDate}"
) "the locked Rust overlay does not contain nightly ${rustNightlyDate}";
assert lib.assertMsg (
  bindgen.version == "0.72.1"
) "rust-bindgen must remain pinned to exactly 0.72.1";
{
  packages = {
    devcontainer-image = devcontainerImage;
    devcontainer-image-stream = devcontainerImageStream;
  };
  checks.devcontainer-image = devcontainerCheck;
}
