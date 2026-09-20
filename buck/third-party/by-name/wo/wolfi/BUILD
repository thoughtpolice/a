# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":wolfi.bzl", "wolfi_apks")

shims.python_binary(
    name = "update",
    base_module = "",
    main = "update.py",
    visibility = ["PUBLIC"],
)

# The test does a plain 'import update', so the module has to land at the root
# of the package rather than under the default by-name/wo/wolfi base module.
shims.python_library(
    name = "update-lib",
    srcs = ["update.py"],
    base_module = "",
)

shims.python_binary(
    name = "update-test",
    base_module = "",
    main = "update_test.py",
    deps = [":update-lib"],
)

shims.run_test(
    name = "test-update",
    dep = ":update-test",
)

# Pinned Wolfi packages: {package: (version, sha256 of the .apk)}.
# Grouped by consumer; the groups are documentation only — every pin
# becomes a `<package>.apk` target. See wolfi.bzl for the refresh story.

# The minimos base layer (src/images/minimos): systemd + dbus + the
# exe.dev boot contract's shells and mount tools, plus the shared
# libraries they link or dlopen.
MINIMOS_BASE = {
    "bash": ("5.3-r13", "55326f8afdd5061f463d74e0061b856c98c822404e4a06b17de65b5f91a60fe3"),
    "ca-certificates-bundle": ("20260611-r1", "006012021d22e720b1832bb1eb92f53f7e917be65ae8ad80badd40a65eff5c5b"),
    "dash": ("0.5.13.5-r1", "d973a5a053e8fd523aa4274c3475b5165f45f761ea74b232aa46881b9f628805"),
    "dbus": ("1.16.2-r6", "a767b8a109b9f3478175e02387516c02029d04c1c8804b59e585ab6beacd1af5"),
    "dbus-libs": ("1.16.2-r6", "ed8f47cdb202574ef1af9d8bb1d03bd9feb887a9420a75dc4462795ab6a8ae2a"),
    "glibc": ("2.43-r13", "495a506a1630939614ac7aa98cc63af8b76762ee981864310b800374ef1652cd"),
    "glibc-locale-posix": ("2.43-r13", "5b28c532c3d2af5e8086da69ece4277ef2e0958f4576805aebd25474240a60c2"),
    "ld-linux": ("2.43-r13", "f49b25afb455a17c0a6335bc97ade76be8b7b0674354a21b12d95a3a4e63e219"),
    "libacl1": ("2.4.0-r3", "10858ad8137f60ca54784978f41148c28377f82ed6ff96a74ac0459dfb519717"),
    "libaudit": ("4.2.1-r1", "61f35651d60ab459206f5dabad2796f37fb99dad2099da3f95c0d474bb69fbad"),
    "libblkid": ("2.42.3-r4", "73376a7be9f64bbfe2101d32ad47b97a2816e8a97019c3c1d00a89eb9391548f"),
    "libcap-ng": ("0.9.6-r0", "28a94408e0676f58e3847e141b60d1e635ae728de31d2a73f26fb027ab3561b4"),
    "libexpat1": ("2.8.4-r0", "2aa592acf91515e05dcf42d86036093797d286a018dd8c32445c1c102efd0f59"),
    "libgcc": ("16.2.0-r1", "6c41a73a5e07bfa17ff3fa6c64d0a898905168c780a04f2092eacb53545106db"),
    "liblz4-1": ("1.10.0-r10", "6101590621fdf09d741a45780cd1e9d11d96cb2d1da73ac6bf71e85029c2a5ed"),
    "libmount": ("2.42.3-r4", "abdd679d0f1b18fb1aa2dd09156cbc309fe87d8344676be9d6a179533d007551"),
    "libpcre2-8-0": ("10.48-r0", "1e09c9f7315a6895b6754077432f29b57dfe62fb7d108ccdd0033bdefa64c1a5"),
    "libseccomp": ("2.6.1-r1", "ae49829a768305713bbd66ce80fccea373a00be39b7b8d4fc1c5a8869c178bd0"),
    "libselinux": ("3.11-r2", "2343075d9b8fa6a5851b8963697ef7c2d05d21286d2af448227ef08865cba4ef"),
    "libsepol": ("3.11-r3", "c26adbc3db13e06f5d9850269a72acc3c53e077411634faf2a84ae7cd18685b0"),
    "libsystemd": ("261.3-r1", "a7ac75a9c8d09a078674396c5c23f5a31a9ea762b7cb5ca7d1588018f894d4d3"),
    "libsystemd-shared": ("261.3-r1", "055a5e617dee1f28c81f53ee55d0c0b472f30e5397af1940c594fbbf5224a331"),
    "libzstd1": ("1.5.7-r10", "6660523fbffeca75cd601b0c61f201f0054a568bac72204bb13be0dba36da176"),
    "mount": ("2.42.3-r4", "44007bb7e338406d22ba1fce83575f93c98d6351d9ccae39c84ee93a11c55de1"),
    "ncurses": ("6.6.20260919-r0", "1da57712d34cdae9381bc8c5f891229da11be56b7d3d361b76ca09491bee836b"),
    "ncurses-terminfo-base": ("6.6.20260919-r0", "85a89620ae73783e4b0b8bd84a218c889a8a5dfd3ac95a53ae3f2935910604a0"),
    "systemd": ("261.3-r1", "19420aa5135ddc78da4296b93300c3d7728a73c3e701e86e2a3bc530e53733ef"),
    "systemd-logind-service": ("261.3-r1", "f33e64e7be053ff553eb34532a0d88a8a555bfb0f568dd11890ba7b24368a2ab"),
    "systemd-systemctl": ("261.3-r1", "2a51c95cbc31c6394ccff6829bcebdf4d6389933b34a15524e135aad1357c2ef"),
    "umount": ("2.42.3-r4", "90ca1b356c41d2db8ca1589c58ee28a533a1224222c197543d9e98e633799f55"),
    "util-linux-login": ("2.42.3-r4", "cd5ba7c4bb444cb5ca418463190a0542d16ef266f408dc0b29e130cb2653a3c8"),
    "wolfi-baselayout": ("20230201-r30", "0544802d073dac63485309a64a1f533735580bbbaa18b83a59058676c040c2fb"),
}

# TLS libraries shared by the minimos example services.
CRYPTO = {
    "libcrypto3": ("3.6.4-r7", "611a5b9749a7c8ba9c62cea80e5e868c6bb7b5f58a89125099a3e2c1436f7f34"),
    "libssl3": ("3.6.4-r7", "f05850ab38a4d7206f804f5acd7c15c77ff0f209a1e096c5313286b70a317afb"),
}

# minimos example: valkey.
VALKEY = {
    "valkey": ("8.1.2-r0", "e316c0b3c704f7aa470a135c053f140bd6ce1f6204dcedd855c98f68cbc212b6"),
    # The server package ships only valkey-server (+symlinks); the CLI —
    # the image's in-VM verification tool — is its own package.
    "valkey-cli": ("8.1.2-r0", "e61c8f3bbd42cca24f1bbedce0d293d0488405930a891c15bc57663e90d55302"),
}

# minimos example: memcached. libsasl2 itself only needs libc — the
# krb5/gdbm/sqlite tails hang off SASL plugins the cull never keeps.
MEMCACHED = {
    "cyrus-sasl-mit-libs": ("2.1.28-r3", "0a848e2d7c794bb88ce4f4241c47fd982b1ee9463bd614394711a61e1c600fd1"),
    "libevent": ("2.1.13-r1", "377826834e95ea5e35ab826b61b2cba89a23930dbcbb1e2228bb5cc776d5411e"),
    "memcached": ("1.6.45-r3", "a7c94a170bf4a4dea0025cf72af228e1bcf7db1b46f00a074f3d8bbc34e051f1"),
}

# minimos example: nginx. libxcrypt, not the empty libcrypt1
# transition package, is what actually ships libcrypt.so.1.
NGINX = {
    "libxcrypt": ("4.5.2-r5", "56db97bbb709ae6d15323e3e470584171f17ac46ae06e7f9dd66d343df7d014e"),
    "nginx-mainline": ("1.31.6-r0", "e7cf286fcd87b8882f8d0aa9bb9a359930cc129f08edf60e028197bbb22c89e0"),
    "nginx-mainline-mime-types": ("1.31.6-r0", "794664d7471aba650fea5f10b3bdd48951d0c9263f630eb9f85e9045f2176123"),
    "zlib": ("1.3.2.1_rc20260601-r0", "113244c87aa28d7e98aca6d1460da28a0d73057a0dad84cc6e3442d639a7334a"),
}

# minimos dev/agent images (src/images/minimos/examples/dev): an
# interactive userland — coreutils and friends, git, jq, ripgrep —
# plus the runtime libraries they link. GNU tar is packaged as
# "gnutar"; the krb5/ldap/sasl/gdbm/sqlite tail hangs off Wolfi's
# libcurl, which is built with GSSAPI and LDAP support.
DEVTOOLS = {
    # bwrap is the sandbox launcher Codex (and other agents) use for
    # command execution; it works unprivileged because minimos keeps
    # user namespaces enabled.
    "bubblewrap": ("0.12.0-r0", "168a99ed4cd858fc1373239ea5bcb1bfdd961907013bdf58a1902a792554782c"),
    "coreutils": ("9.12-r2", "1c4cd0f5b5e65dc009d66a951b9964a874dc97e2d68bc611e21e2a60e50abc60"),
    "curl": ("8.22.0-r2", "830bbdaa76fbc8395d3db3aba20b7fa533e7fda365e1a5325b7135986339fc04"),
    "diffutils": ("3.12-r7", "84d9b94ec5ad3642687eeb8af391b23afd48254f87bb7faf4268bcc18d6c57c6"),
    "findutils": ("4.11.0-r2", "4d2afb15bb8612291076909d93331682f2b81b365b6a6a9fa6a908b06e390458"),
    "gawk": ("5.4.1-r3", "05814690f92979b3b1509060f349a19e9797f0e84839687ba5dc5279c65b50c3"),
    "gdbm": ("1.26-r6", "1c880511436ea833e2d5798d1886f1e3ee9936dce2d4dc223dae41e1f15b52ff"),
    "git": ("2.55.0-r7", "1a97c90e7c0828649b96900d69daf72c08de5e95fcfa4a1a8b8cfdb6be5fbf35"),
    "gnutar": ("1.35-r12", "5fcc57c67b00f27569a9ee1d732fccc9288ffe78e795afd04168f8cf10161a8d"),
    "grep": ("3.12-r8", "de780375eb5feaacc819125ebc140756866b4edbbfa1becf2469250fcb5f3de6"),
    "gzip": ("1.14-r9", "8ac0cd9d0df4167d994f71ad9d4fed326a910181b89cfb64acb1ca0d19c3b2dd"),
    "jq": ("1.8.2-r2", "438d8ff4e57c13f5957f544b35efddbdfa4a9fb9ffa898a33e1b4f06316edb11"),
    "keyutils-libs": ("1.6.3-r40", "fed949d1e64467ba4c5f8ddabc9d898b3d2475d7dc2db3c4069f5dbfe1550400"),
    "krb5-libs": ("1.22.2-r3", "8975622a6d9ecfd9875c01653b7a4e7d14b2de69ff8cfb94b658cfb81bb4d02d"),
    "less": ("710-r0", "6335f18bdf0f8d3328e917fb28bb7659f4d9a3c003cca7d6f23f8e3a387d787a"),
    "libattr1": ("2.6.0-r3", "dddc29015204ec417a96508d9ddce84628bcc34e1f44820951814ffe8d6642ea"),
    "libbrotlicommon1": ("1.2.0-r5", "ce2bbe259d5906f2d12592ea71e175f5d23f6437ad736a6506c1ec4f022926c9"),
    "libbrotlidec1": ("1.2.0-r5", "c21ea670f748f1d2b32c17199f8e1bc7e5188a5e2e9325adbffc05f3d8a7f074"),
    # The apk metadata says libpam, but that's pam_cap.so; the culled
    # layer only ever keeps libcap.so.2, which needs nothing but libc.
    "libcap": ("2.78-r3", "dc83031936427b3ad7c9c627a36bab793df6381a7cdfc512796bd0eadafa31ed"),
    "libcom_err": ("1.47.4-r2", "23ca8006254dad6eaee4feb1b29f12d042f6214ea95c7fad9865d1c7c24ac1f9"),
    "libcurl-openssl4": ("8.22.0-r2", "9000a78042230eb45315222e731c0472b0772d78010925be65892aa7fcc5e289"),
    "libidn2": ("2.3.8-r9", "75c10d044558781f8002156542d1b250b34f9e3cd135f7779f426c943c7a656c"),
    "libldap": ("2.6.10-r5", "140df3743ee774109bec62bf0531321d2fbb501327cfbd855ab5a535ce3c4c90"),
    "libnghttp2-14": ("1.70.0-r3", "cdc90205e0142d9ca0af3d8745125bd7a68e561af467ce624584a7f385f1b924"),
    "libproc-2-0": ("4.0.7-r1", "3482fbc6ce6df37cd5ead386f12033e8ed538971d9727668c923a26c1568b715"),
    "libpsl": ("0.23.3-r1", "4f36e4df35d55dd3f26c2a18386122e72f884fba1f9bc9628c07eb2e2b16319e"),
    "libunistring": ("1.4.2-r3", "a7d592a052801cf5026b55b256c83f2a1a61ba99b1fe7386187514032283042e"),
    "libverto": ("0.3.2-r8", "0f8ba3c1a124f996201b019e8c300b9f811a444d6040140794e359fb23c777b5"),
    "nghttp3": ("1.18.0-r1", "857408a1ea9daf5b7924a39609da89152add5e0e47a01cfa72a8b39bb8c478d9"),
    "ngtcp2": ("1.25.0-r2", "736ef80b494708c25b3e8253b0318b723f8181fb36427a478e143cd6db267957"),
    "oniguruma": ("6.9.10-r5", "f4cbff0609aa1c5f08e40e40590b7ac041f906e961722c0e17b417eff07176ba"),
    "patch": ("2.8-r10", "cf0bbb9b83ffc29a38baf72c577626e4e86632d787153d5f6a4d841f3e2d00be"),
    "procps": ("4.0.7-r1", "808656f0ec019afcafbf7c27a2e007a50d4c78117d93f31d19e44e2372ce9ac8"),
    "ripgrep": ("15.2.0-r4", "9c6c58705d8c6a00e4b3b77be64794bf57c19bba4856979afa19fea41c2452b3"),
    "sed": ("4.10-r3", "1f2de597d4d619b722edab190d8da558812a8d45f7b16e5060f3a16c88b17ab3"),
    "sqlite-libs": ("3.53.4-r2", "4be0df27696de70f79cbbac724078ea72687c8073669157577b4d194943c4729"),
    "xz": ("5.8.4-r0", "d015b40af8b300a0a33e710573e1e7d6cdc31ae5124bcac2fd299bea90a8506a"),
}

wolfi_apks(MINIMOS_BASE)

wolfi_apks(CRYPTO)

wolfi_apks(VALKEY)

wolfi_apks(MEMCACHED)

wolfi_apks(NGINX)

wolfi_apks(DEVTOOLS)
