# SPDX-FileCopyrightText: © 2024-2026 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

oci_pull = shims.oci.pull

oci_push = shims.oci.push

oci_image = shims.oci.image

oci_unpack = shims.oci.unpack

oci_index = shims.oci.index

oci_repack = shims.oci.repack

oci_archive = shims.oci.archive

tar_file = shims.tar_file

# Test 1: Pull a base image
oci_pull(
    name = "alpine_base",
    image = "docker.io/library/alpine",
    platform = "linux/amd64",
)

# Test 2: Create a simple tar layer
tar_file(
    name = "test_layer",
    srcs = ["test_file.txt"],
    compress = True,
)

# Test 3: Build an image from base + layer
oci_image(
    name = "test_image_simple",
    base = ":alpine_base",
    env = {
        "TEST_VAR": "test_value",
    },
    layers = [":test_layer"],
)

# Test 4: Build an image with full config
oci_image(
    name = "test_image_full",
    base = ":alpine_base",
    cmd = [
        "-c",
        "echo hello",
    ],
    entrypoint = ["/bin/sh"],
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "APP_ENV": "test",
    },
    image_labels = {
        "org.opencontainers.image.title": "Test Image",
        "org.opencontainers.image.version": "1.0.0",
    },
    layers = [":test_layer"],
    user = "nobody",
    working_dir = "/app",
)

# Test 5: Layer composition - build image from another image
oci_image(
    name = "test_image_layered",
    base = ":test_image_full",
    env = {
        "ANOTHER_VAR": "another_value",
    },
    layers = [":test_layer"],  # Add another copy of the layer
)

# Test 6: Unpack an image
oci_unpack(
    name = "test_image_unpacked",
    image = ":test_image_full",
    tag = "latest",
)

# Test 7: Multi-platform - pull different platforms
oci_pull(
    name = "alpine_amd64",
    image = "docker.io/library/alpine",
    platform = "linux/amd64",
)

oci_pull(
    name = "alpine_arm64",
    image = "docker.io/library/alpine",
    platform = "linux/arm64",
)

# Test 8: Build platform-specific images
oci_image(
    name = "test_app_amd64",
    base = ":alpine_amd64",
    env = {"ARCH": "amd64"},
    image_labels = {"arch": "amd64"},
    layers = [":test_layer"],
)

oci_image(
    name = "test_app_arm64",
    base = ":alpine_arm64",
    env = {"ARCH": "arm64"},
    image_labels = {"arch": "arm64"},
    layers = [":test_layer"],
)

# Test 9: Create multi-platform index
oci_index(
    name = "test_app_multiplatform",
    images = [
        ":test_app_amd64",
        ":test_app_arm64",
    ],
    platforms = [
        "linux/amd64",
        "linux/arm64",
    ],
)

# Test 9b: Push targets. Building one builds its image, and
# `buck2 run :test_app_multiplatform_push -- --dry-run` shows what a real
# run would push.
oci_push(
    name = "test_image_simple_push",
    image = ":test_image_simple",
)

oci_push(
    name = "test_app_multiplatform_push",
    image = ":test_app_multiplatform",
    repository = "ghcr.io/example/test-app",
    tags = ["latest"],
)

# ============================================================================
# Additional comprehensive tests
# ============================================================================

# Test 10-12: Different base images
oci_pull(
    name = "busybox_base",
    image = "docker.io/library/busybox:latest",
    platform = "linux/amd64",
)

oci_pull(
    name = "debian_base",
    image = "docker.io/library/debian:stable-slim",
    platform = "linux/amd64",
)

# Removed distroless test - gcr.io access issues

# Test 13-16: Multiple layer types
tar_file(
    name = "app_layer",
    srcs = ["app.sh"],
    compress = True,
)

tar_file(
    name = "config_layer",
    srcs = ["config.json"],
    compress = True,
)

tar_file(
    name = "data_layer",
    srcs = ["data.txt"],
    compress = True,
)

tar_file(
    name = "special_chars_layer",
    srcs = ["special_chars.txt"],
    compress = True,
)

# Test 17: Image with multiple diverse layers
oci_image(
    name = "test_multilayer",
    base = ":alpine_base",
    entrypoint = ["/app/app.sh"],
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin:/app/bin",
        "APP_HOME": "/app",
        "LOG_LEVEL": "debug",
    },
    layers = [
        ":test_layer",
        ":app_layer",
        ":config_layer",
        ":data_layer",
    ],
    working_dir = "/app",
)

# Test 18: Environment variable merging
oci_image(
    name = "test_env_base",
    base = ":alpine_base",
    env = {
        "BASE_VAR": "base_value",
        "SHARED_VAR": "from_base",
    },
)

oci_image(
    name = "test_env_override",
    base = ":test_env_base",
    env = {
        "SHARED_VAR": "overridden",
        "NEW_VAR": "new_value",
    },
)

# Test 19: Label merging
oci_image(
    name = "test_labels_base",
    base = ":alpine_base",
    image_labels = {
        "org.opencontainers.image.vendor": "Test Vendor",
        "shared.label": "from_base",
    },
)

oci_image(
    name = "test_labels_override",
    base = ":test_labels_base",
    image_labels = {
        "shared.label": "overridden",
        "org.opencontainers.image.version": "2.0.0",
        "custom.label.with-special_chars": "value-with_underscores",
    },
)

# Test 20-22: CMD and ENTRYPOINT combinations
oci_image(
    name = "test_cmd_only",
    base = ":alpine_base",
    cmd = [
        "/bin/sh",
        "-c",
        "echo 'cmd only'",
    ],
)

oci_image(
    name = "test_entrypoint_only",
    base = ":alpine_base",
    entrypoint = [
        "/bin/sh",
        "-c",
        "echo 'entrypoint only'",
    ],
)

oci_image(
    name = "test_cmd_and_entrypoint",
    base = ":alpine_base",
    cmd = ["echo 'both set'"],
    entrypoint = [
        "/bin/sh",
        "-c",
    ],
)

# Test 23: Exposed ports
oci_image(
    name = "test_exposed_ports",
    base = ":alpine_base",
    exposed_ports = [
        "8080/tcp",
        "9090/tcp",
        "53/udp",
    ],
)

# Test 24: Volumes
oci_image(
    name = "test_volumes",
    base = ":alpine_base",
    volumes = [
        "/data",
        "/var/log",
        "/app/config",
    ],
)

# Test 25: User changes
oci_image(
    name = "test_user_root",
    base = ":alpine_base",
    user = "root",
)

oci_image(
    name = "test_user_numeric",
    base = ":alpine_base",
    user = "1000:1000",
)

# Test 26: Working directory changes
oci_image(
    name = "test_workdir",
    base = ":alpine_base",
    working_dir = "/workspace/project",
)

# Test 27: Empty layer (just metadata change)
oci_image(
    name = "test_metadata_only",
    base = ":alpine_base",
    env = {"METADATA_ONLY": "true"},
    layers = [],
)

# Test 28: Many layers (stress test)
oci_image(
    name = "test_many_layers",
    base = ":alpine_base",
    layers = [
        ":test_layer",
        ":app_layer",
        ":config_layer",
        ":data_layer",
        ":special_chars_layer",
        ":test_layer",  # Duplicate layer
        ":app_layer",
        ":config_layer",
    ],
)

# Test 29-30: Special characters in env and labels
oci_image(
    name = "test_special_chars_metadata",
    base = ":alpine_base",
    env = {
        "URL": "https://example.com:8080/path?query=value&other=123",
        "JSON": '{"key":"value","nested":{"foo":"bar"}}',
        "SPACES": "value with spaces",
        "EQUALS": "key=value=something",
    },
    image_labels = {
        "url.label": "https://example.com",
        "json.label": '{"test":true}',
        "special-chars_label.v1": "value-123_test",
    },
    layers = [":special_chars_layer"],
)

# Test 31-32: Different registries
# Removed ghcr.io test - authentication issues

oci_pull(
    name = "nginx_latest",
    image = "docker.io/library/nginx:alpine",
    platform = "linux/amd64",
)

# Test 34: Build from non-alpine base
oci_image(
    name = "test_busybox_based",
    base = ":busybox_base",
    cmd = ["/bin/sh"],
    layers = [":test_layer"],
)

# Test 35: Build from debian base
oci_image(
    name = "test_debian_based",
    base = ":debian_base",
    env = {"DEBIAN_FRONTEND": "noninteractive"},
    layers = [
        ":app_layer",
        ":config_layer",
    ],
)

# Test 36-38: Unpack tests
oci_unpack(
    name = "test_alpine_unpacked",
    image = ":alpine_base",
    tag = "latest",
)

oci_unpack(
    name = "test_multilayer_unpacked",
    image = ":test_multilayer",
    tag = "latest",
)

oci_unpack(
    name = "test_busybox_unpacked",
    image = ":busybox_base",
    tag = "latest",
)

# Test 39: Complete application image
oci_image(
    name = "test_complete_app",
    base = ":alpine_base",
    cmd = ["--verbose"],
    entrypoint = [
        "/bin/sh",
        "/app/app.sh",
    ],
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "APP_VERSION": "1.2.3",
        "APP_ENV": "production",
        "PORT": "8080",
    },
    exposed_ports = [
        "8080/tcp",
        "8081/tcp",
    ],
    image_labels = {
        "org.opencontainers.image.title": "Complete Test App",
        "org.opencontainers.image.description": "Full-featured test application",
        "org.opencontainers.image.version": "1.2.3",
        "org.opencontainers.image.authors": "Test Team",
        "org.opencontainers.image.vendor": "Test Vendor Inc",
        "org.opencontainers.image.licenses": "Apache-2.0",
    },
    layers = [
        ":app_layer",
        ":config_layer",
        ":data_layer",
    ],
    user = "nobody",
    volumes = [
        "/app/data",
        "/app/logs",
    ],
    working_dir = "/app",
)

# Test 40: Chained image building (3 levels)
oci_image(
    name = "test_chain_level1",
    base = ":alpine_base",
    env = {"LEVEL": "1"},
    layers = [":test_layer"],
)

oci_image(
    name = "test_chain_level2",
    base = ":test_chain_level1",
    env = {"LEVEL": "2"},
    layers = [":app_layer"],
)

oci_image(
    name = "test_chain_level3",
    base = ":test_chain_level2",
    env = {"LEVEL": "3"},
    layers = [":config_layer"],
)

# Test 41-42: Multi-platform with different configs
oci_image(
    name = "test_platform_specific_amd64",
    base = ":alpine_amd64",
    env = {
        "ARCH": "amd64",
        "PLATFORM": "x86_64",
        "OPTIMIZATIONS": "sse4.2,avx2",
    },
    image_labels = {
        "arch": "amd64",
        "platform.features": "sse4.2,avx2",
    },
    layers = [":app_layer"],
)

oci_image(
    name = "test_platform_specific_arm64",
    base = ":alpine_arm64",
    env = {
        "ARCH": "arm64",
        "PLATFORM": "aarch64",
        "OPTIMIZATIONS": "neon",
    },
    image_labels = {
        "arch": "arm64",
        "platform.features": "neon",
    },
    layers = [":app_layer"],
)

# Test 43: Multi-platform index with more metadata
oci_index(
    name = "test_multiplatform_full",
    images = [
        ":test_platform_specific_amd64",
        ":test_platform_specific_arm64",
    ],
    platforms = [
        "linux/amd64",
        "linux/arm64",
    ],
)

# Removed test 44 - distroless base not available

# ============================================================================
# Repack workflow tests
# ============================================================================

oci_unpack(
    name = "test_for_repack_unpacked",
    image = ":test_complete_app",
    tag = "latest",
)

# The whole root filesystem as one layer.
oci_repack(
    name = "test_repacked",
    bundle = ":test_for_repack_unpacked",
    tag = "repacked",
)

# On the image it came from, with nothing changed, so no layer is added.
oci_repack(
    name = "test_repacked_on_base",
    base = ":test_complete_app",
    bundle = ":test_for_repack_unpacked",
)

# ============================================================================
# Native binaries
# ============================================================================

shims.cxx_binary(
    name = "native_hello",
    srcs = ["hello.c"],
    target_compatible_with = ["config//cpu:x86_64"],
)

# The binary's own Nix runtime, copied in.
shims.oci.native_binary_image(
    name = "native_hello_image",
    base = "third-party//oci-images:chainguard_glibc_dynamic_amd64",
    binary = ":native_hello",
    destination = "/usr/local/bin/hello",
    target_compatible_with = ["config//cpu:x86_64"],
)

# Repointed at the base's glibc instead.
shims.oci.native_binary_image(
    name = "native_hello_repointed_image",
    base = "third-party//oci-images:chainguard_glibc_dynamic_amd64",
    binary = ":native_hello",
    destination = "/usr/local/bin/hello",
    include_nix_store = False,
    interpreter = "/lib64/ld-linux-x86-64.so.2",
    rpath = "/usr/lib",
    target_compatible_with = ["config//cpu:x86_64"],
)

# The first layer carries the binary's glibc from the Nix store, if it was
# linked against one, and the second never does. Unpacking puts each binary
# where its interpreter can find it.
shims.oci.unpack(
    name = "native_hello_unpacked",
    image = ":native_hello_image",
    target_compatible_with = ["config//cpu:x86_64"],
)

shims.oci.unpack(
    name = "native_hello_repointed_unpacked",
    image = ":native_hello_repointed_image",
    target_compatible_with = ["config//cpu:x86_64"],
)

shims.command_test(
    name = "native-binary-layers",
    script = """
        nix="$(location :native_hello_unpacked)/rootfs"
        test -x "$nix/usr/local/bin/hello"
        # The C toolchain is Nix's in the dev shell and the host's elsewhere,
        # as on a CI runner. A host-linked binary has no store roots to copy.
        if grep -aq /nix/store/ "$(location :native_hello)"; then
            ls -d "$nix"/nix/store/*-glibc-* >/dev/null
            interp="`grep -ao '/nix/store/[a-z0-9]*-glibc-[^/]*/lib/ld-linux-x86-64.so.2' "$nix/usr/local/bin/hello" | head -1`"
            test -e "$nix$interp"
        else
            test ! -e "$nix/nix"
        fi

        repointed="$(location :native_hello_repointed_unpacked)/rootfs"
        test -x "$repointed/usr/local/bin/hello"
        test ! -e "$repointed/nix"
        grep -aq /lib64/ld-linux-x86-64.so.2 "$repointed/usr/local/bin/hello"
        ! grep -aq /nix/store/ "$repointed/usr/local/bin/hello"
    """,
    target_compatible_with = ["config//cpu:x86_64"],
)

# ============================================================================
# Every image and index above, checked descriptor by descriptor
# ============================================================================

LAYOUTS = [
    "alpine_base",
    "alpine_amd64",
    "alpine_arm64",
    "busybox_base",
    "debian_base",
    "nginx_latest",
    "test_image_simple",
    "test_image_full",
    "test_image_layered",
    "test_app_amd64",
    "test_app_arm64",
    "test_app_multiplatform",
    "test_multilayer",
    "test_env_base",
    "test_env_override",
    "test_labels_base",
    "test_labels_override",
    "test_cmd_only",
    "test_entrypoint_only",
    "test_cmd_and_entrypoint",
    "test_exposed_ports",
    "test_volumes",
    "test_user_root",
    "test_user_numeric",
    "test_workdir",
    "test_metadata_only",
    "test_many_layers",
    "test_special_chars_metadata",
    "test_busybox_based",
    "test_debian_based",
    "test_complete_app",
    "test_chain_level1",
    "test_chain_level2",
    "test_chain_level3",
    "test_platform_specific_amd64",
    "test_platform_specific_arm64",
    "test_multiplatform_full",
    "test_repacked",
    "test_repacked_on_base",
]

# The native binary images build only for x86_64.
NATIVE_LAYOUTS = [
    "native_hello_image",
    "native_hello_repointed_image",
]

shims.command_test(
    name = "validate-layouts",
    cmd = [
        "$(exe root//buck/tools/oci:oci)",
        "validate",
    ] + ["$(location :{})".format(name) for name in LAYOUTS] + shims.select({
        "config//cpu:x86_64": ["$(location :{})".format(name) for name in NATIVE_LAYOUTS],
        "DEFAULT": [],
    }),
)

# A Docker archive is an OCI layout too, so the extracted tar must validate.
oci_archive(
    name = "test_complete_app_docker",
    image = ":test_complete_app",
    image_name = "test-complete-app",
    tag = "v1",
)

shims.command_test(
    name = "validate-archive",
    script = """
        out="`mktemp -d`"
        trap 'rm -rf "$out"' EXIT
        tar -xf "$(location :test_complete_app_docker)" -C "$out"
        test -f "$out/manifest.json"
        "$(exe root//buck/tools/oci:oci)" validate "$out"
    """,
)
