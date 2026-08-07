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
    "bash": ("5.3-r12", "04db98c81192d3a52ece091fac002d5abd1bae97b43ef042c80196b7a9f8cc36"),
    "ca-certificates-bundle": ("20260413-r0", "353081c30814492d7f5f47834cb56b5662b8cff320f8836c5a4e2da7c03dd7b7"),
    "dash": ("0.5.13.5-r0", "7ecdc997a8228e3354cf46f6226968e37b3de0458af59d334733122acdfa19db"),
    "dbus": ("1.16.2-r5", "2fbec887c9fa27c9810e2752284abf19f93fcd4baddac5509c8496bb9f174687"),
    "dbus-libs": ("1.16.2-r5", "40c4d6e64bd4e19a5e2217f469b9ac66bf2d7d82837ae7b5ff3adb08cb1fea1d"),
    "glibc": ("2.43-r11", "87983fb2cb5127bc789e316d23f021c8b6d1f5abc9c92dc0f712fc6ac63cec5b"),
    "glibc-locale-posix": ("2.43-r11", "90d8aa2aa456e5ccde7b113d38269bdafb500464aae42af495f4d2cda7605945"),
    "ld-linux": ("2.43-r11", "0a48234fd70e0c6143e9c943033efd1bc1d7fcd9f55ad3a5d2fbb52c45127776"),
    "libacl1": ("2.4.0-r1", "061726fa4e99053cdf848613d34361f1f983cddb71dbc2928268c2cbc215756f"),
    "libaudit": ("4.2.1-r0", "62cd1c8939e454af76e11d2c3b70da429424649d619364fed9f943a867b68826"),
    "libblkid": ("2.42.2-r0", "60c51de45dcf78aae63b1b6f6669f671dae0f490cff9fda52752774f1ebd8fa0"),
    "libcap-ng": ("0.9.3-r1", "36b9597139e7d98041fe76ba560a7ca4a9cc7c5075480c0cbae25c51d03aee0f"),
    "libexpat1": ("2.8.2-r0", "4bbcf459850aca59211e89501df2729499c0e32d91731a834cebfa86080f0642"),
    "libgcc": ("16.1.0-r4", "ad923214add20d7a410ee391718df91116ed29c12902c1170cf23a7c91adc602"),
    "liblz4-1": ("1.10.0-r9", "afe5b234bf1723224d07cdddf5b6dc39e9deda91987c0300c5aaf2515bd43030"),
    "libmount": ("2.42.2-r0", "ceb904dc7940e73d510270ba86e709d5bce2ee14c22837a41428d5442c0d8fd9"),
    "libpcre2-8-0": ("10.47-r0", "579084d2b3f53f6f7224f5eb0e050fbbd01e7a535bdf50551cf51eb74e29b8aa"),
    "libseccomp": ("2.6.1-r0", "23cd1145d43c626a2ecbea66e1a1c3310d4825284078054d035f58fa761e5337"),
    "libselinux": ("3.11-r0", "6a03897e1a50cfea06e8575c532591e0e39b8f966797ca2532d08c165aab1606"),
    "libsepol": ("3.11-r0", "d8ff742c93586933f063b2cec5208fd143681f79cff1ba617d39de04e822d5e2"),
    "libsystemd": ("261.2-r1", "3b479b164cd8f857e695db9cf9fa7ed016703b0614594d621bd4ca1179360ef7"),
    "libsystemd-shared": ("261.2-r1", "c09de561eea8c57c1ee1fad77d27ed6da34245e7d0c777a9277b3ee35c76c66a"),
    "libzstd1": ("1.5.7-r7", "757adbd714d2cd37deb581cfd7477516ab4591ccdad7f97ae29230f450124c3d"),
    "mount": ("2.42.2-r0", "9d21ecf1abf20e5faa19f63bb9fdd997d6d69f2a040b3711506ec49812172af9"),
    "ncurses": ("6.6.20260801-r0", "202529e6b97d8c535edc4bf2af80a3c992da11632d5d5086246e7c9c5039d344"),
    "ncurses-terminfo-base": ("6.6.20260801-r0", "0c3b9122d234e0bae7bacd3be6137d9bb888bc5e5dfc96a84cfdb64e6b207928"),
    "systemd": ("261.2-r1", "5cb9494726a9ba51df2092f33816cd23facbc833e1e5bc681a3912955920213d"),
    "systemd-logind-service": ("261.2-r1", "c430cb1279daa8c2fc9a2f76ade5573c0534244b2e8f60c34902efde7aebdd76"),
    "systemd-systemctl": ("261.2-r1", "ef2d17d01c5c399ec979559b4921bf3ad0bb63d55df42e67525712851378aa0f"),
    "umount": ("2.42.2-r0", "881f6186bdd4f8477c55d25008a5d53041d8ab5857242a9fa7db7a77977f98c5"),
    "util-linux-login": ("2.42.2-r0", "89083171e39841b802b88be5fb9681458c3bfa98c054645710c33784d99fd436"),
    "wolfi-baselayout": ("20230201-r29", "c7aef94f6c8e3060cac5a6b1dfa6257ad0d2d4d0a6ff93d02bba26e0ea518457"),
}

# TLS libraries shared by the minimos example services.
CRYPTO = {
    "libcrypto3": ("3.6.3-r3", "0a6db82a1064ff780f1609b5dc94a64d397924df8e6a339c0de7e210d6ae5474"),
    "libssl3": ("3.6.3-r3", "698c9f853a6afddff19a7e3005f3b68c78d254be6c256ed1b1a2c53826e023d4"),
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
    "cyrus-sasl-mit-libs": ("2.1.28-r1", "5ccce3a075b97798b805b309e5728db7f880c80c1652a14f233c8fb865bb4545"),
    "libevent": ("2.1.13-r0", "d02c787923cbf496ce7bc7863b14dbf0e24d2e19b3542075547b72c66c4976e2"),
    "memcached": ("1.6.45-r2", "5c95485ebbfefde06e4e826f660df73e913dd4259571fb47080565adfb8af014"),
}

# minimos example: nginx. libxcrypt, not the empty libcrypt1
# transition package, is what actually ships libcrypt.so.1.
NGINX = {
    "libxcrypt": ("4.5.2-r3", "e2a7657bde0d6e38c27e3d17de64474e9805cd92b3c8da2baa5dfba32a281ffb"),
    "nginx-mainline": ("1.31.3-r2", "0b0d32fa7062453064b6e147fc0dcac79fdbd619435217bb7ea440b3e42fb8ce"),
    "nginx-mainline-mime-types": ("1.31.3-r2", "3426f9e2238289c405142c2b81d40170101a4dbbdf59bb8b49ef276417b7feba"),
    "zlib": ("1.3.2-r3", "26ec98f85dd79a99158ac2097fdfb31f029948c4b57046312592aa11a0639343"),
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
    "bubblewrap": ("0.11.2-r0", "92e4644298be253e29f66793e087b5c77e569a6dd39b7d3238302508874a427d"),
    "coreutils": ("9.11-r3", "8c4fa14bd0f057ab22e7089a842b7f57a15acf34ec4c63488660c0e05fac22a7"),
    "curl": ("8.21.0-r1", "95e856bb6f55f8d69cddcb987191ab2466e503dc0f5de93a149c9aacff1d9114"),
    "diffutils": ("3.12-r6", "59f5a44cc11c3a88c4ac587748758ab2416247056b4dee5d7ab319b5031711d4"),
    "findutils": ("4.11.0-r1", "28c342bc2d3bf10b23e6de8544bdcb16fe0d7387ffc57d89391716df051cea88"),
    "gawk": ("5.4.1-r0", "2b2d4389aa720ce3baf6d8889fc2589d207828318e55552ba6469c822b6ed392"),
    "gdbm": ("1.26-r5", "0f349182ec9d27fb409642da2171ac9b709075f2086e9a8b34ac32d02f87eedb"),
    "git": ("2.55.0-r4", "8abd79c3afd70632e1255bce70b7ee8c9214cc4531131291bb430280b65ab884"),
    "gnutar": ("1.35-r11", "215d27a7eb59adea92a177d8200e233246ce3d11b9223de396da26e165537d1f"),
    "grep": ("3.12-r6", "61d6f87d5968a4b56af721d44328485ed01909b39c260a0729fd4b72ff08ab70"),
    "gzip": ("1.14-r7", "ac75e0fc1169ba5ecfc894d588ca6964d907aa883cabc3a49bdb8a9baa37216d"),
    "jq": ("1.8.2-r0", "7ee44a614e2454dde4a8fdae009d3d7573fc1bad6398e69179319a128a257c28"),
    "keyutils-libs": ("1.6.3-r38", "ce1d7829ed082b2ff36e6120453b03dcd5ec20925172fccc842eafaf3e540430"),
    "krb5-libs": ("1.22.2-r2", "aca1e742c46bb25b18a729183be16f09a95aeb5bc64a863354b6ba362e13171f"),
    "less": ("708-r1", "858cda7313c63e284334e00e118ea10ef456dad5a34916132ce61f84de6f0aa4"),
    "libattr1": ("2.6.0-r1", "5890faac103dcbb230b6a9c7e8ece1bbf9f7b622b5b7a3b2fb88cbe163a0a70a"),
    "libbrotlicommon1": ("1.2.0-r3", "49dbcc31d5126eece677200ef3c777be224c493ea4cd7a03cf3d36e27e9715f8"),
    "libbrotlidec1": ("1.2.0-r3", "1031104cad23db551bd510baf7fa0f9b419dfef9f7947eba2d6ec3f23528cddc"),
    # The apk metadata says libpam, but that's pam_cap.so; the culled
    # layer only ever keeps libcap.so.2, which needs nothing but libc.
    "libcap": ("2.78-r2", "ff51c2e9cbf1aa933d7661ada364d53ba26e4c09e2603a2700d79a69306e7e04"),
    "libcom_err": ("1.47.4-r1", "b2b7020631a41f6ce01c34d0ea9b839d860c42356e23b026c9fb84f8332a478c"),
    "libcurl-openssl4": ("8.21.0-r1", "242db949bcdb424a81edb0fcdd4c312da14b3b232ce3740697864b5156a0b6c1"),
    "libidn2": ("2.3.8-r7", "040ddfb506322090e46f3d99de1138da010cc5e25be7c2670ba938604d0c200c"),
    "libldap": ("2.6.10-r5", "140df3743ee774109bec62bf0531321d2fbb501327cfbd855ab5a535ce3c4c90"),
    "libnghttp2-14": ("1.70.0-r2", "6218d0c490d7310694c161d78b4f9ab2d4a2d743408a8e6b26cad9cc02ff21bd"),
    "libproc-2-0": ("4.0.6-r2", "b2d3d146aed518a437d8e07565002576d0e38f8df88d69ba47ecaff74fa15325"),
    "libpsl": ("0.23.1-r0", "711e125be5f8b18351fdb053289d28de2711b448ad73ca0fea053e858a5c16c4"),
    "libunistring": ("1.4.2-r2", "7923969e5333292e479263b39f3fa9b2f40eea3b759fb1f5b58db78eb0735fc0"),
    "libverto": ("0.3.2-r7", "7761dbf3d9520eb5d5acf5c88a2f2a625f4566e3ee7ae46ada397023af6cb555"),
    "nghttp3": ("1.18.0-r0", "bc0dbc34ae1e52ba3cd43b93f3b4b7d369f4b0317589299dae1bd0c3b0977310"),
    "ngtcp2": ("1.25.0-r0", "932411c0e81713b7bec95d22df48db8ab6505af8c2eb527af4327e29f843225f"),
    "oniguruma": ("6.9.10-r4", "1e400831160d9e97a8542d44ecc54a6bd2c8aaa5e60cd20b1c9477e2a67b6e43"),
    "patch": ("2.8-r7", "5429c8b190206e76c393e7bec5689bbfd6a85e8ad3c94431364c0ad1f658cab0"),
    "procps": ("4.0.6-r2", "e50990351cdb4ada0873d018a83e7b0c4202cf49710d45f764193380627ac5d6"),
    "ripgrep": ("15.2.0-r1", "3991bac9608f5a1a3ed122d0196cbf5a3cf0df9c08fae1869f9743020c8b2213"),
    "sed": ("4.10-r1", "64f97fb24d76be3d835114b93ef77385c82a8f3b432a775ed72394e86171f28c"),
    "sqlite-libs": ("3.53.4-r0", "09010a1a174b03b3f73ee13d22a1b5399796a9aaa9be53a18d8a045bebd4e499"),
    "xz": ("5.8.3-r1", "765ab7b324eb6e881de183cccaf81f92aa1e6df333de3abde7936f992854956f"),
}

wolfi_apks(MINIMOS_BASE)

wolfi_apks(CRYPTO)

wolfi_apks(VALKEY)

wolfi_apks(MEMCACHED)

wolfi_apks(NGINX)

wolfi_apks(DEVTOOLS)
