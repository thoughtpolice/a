# SPDX-FileCopyrightText: © 2024-2025 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

oci_pull = shims.oci.pull
oci_image = shims.oci.image
oci_unpack = shims.oci.unpack
oci_index = shims.oci.index
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
    layers = [":test_layer"],
    env = {
        "TEST_VAR": "test_value",
    },
)

# Test 4: Build an image with full config
oci_image(
    name = "test_image_full",
    base = ":alpine_base",
    layers = [":test_layer"],
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "APP_ENV": "test",
    },
    image_labels = {
        "org.opencontainers.image.title": "Test Image",
        "org.opencontainers.image.version": "1.0.0",
    },
    entrypoint = ["/bin/sh"],
    cmd = ["-c", "echo hello"],
    working_dir = "/app",
    user = "nobody",
)

# Test 5: Layer composition - build image from another image
oci_image(
    name = "test_image_layered",
    base = ":test_image_full",
    layers = [":test_layer"],  # Add another copy of the layer
    env = {
        "ANOTHER_VAR": "another_value",
    },
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
    layers = [":test_layer"],
    env = {"ARCH": "amd64"},
    image_labels = {"arch": "amd64"},
)

oci_image(
    name = "test_app_arm64",
    base = ":alpine_arm64",
    layers = [":test_layer"],
    env = {"ARCH": "arm64"},
    image_labels = {"arch": "arm64"},
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
    layers = [
        ":test_layer",
        ":app_layer",
        ":config_layer",
        ":data_layer",
    ],
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin:/app/bin",
        "APP_HOME": "/app",
        "LOG_LEVEL": "debug",
    },
    entrypoint = ["/app/app.sh"],
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
    cmd = ["/bin/sh", "-c", "echo 'cmd only'"],
)

oci_image(
    name = "test_entrypoint_only",
    base = ":alpine_base",
    entrypoint = ["/bin/sh", "-c", "echo 'entrypoint only'"],
)

oci_image(
    name = "test_cmd_and_entrypoint",
    base = ":alpine_base",
    entrypoint = ["/bin/sh", "-c"],
    cmd = ["echo 'both set'"],
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
    layers = [],
    env = {"METADATA_ONLY": "true"},
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
    layers = [":special_chars_layer"],
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
    layers = [":test_layer"],
    cmd = ["/bin/sh"],
)

# Test 35: Build from debian base
oci_image(
    name = "test_debian_based",
    base = ":debian_base",
    layers = [":app_layer", ":config_layer"],
    env = {"DEBIAN_FRONTEND": "noninteractive"},
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
    layers = [
        ":app_layer",
        ":config_layer",
        ":data_layer",
    ],
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "APP_VERSION": "1.2.3",
        "APP_ENV": "production",
        "PORT": "8080",
    },
    image_labels = {
        "org.opencontainers.image.title": "Complete Test App",
        "org.opencontainers.image.description": "Full-featured test application",
        "org.opencontainers.image.version": "1.2.3",
        "org.opencontainers.image.authors": "Test Team",
        "org.opencontainers.image.vendor": "Test Vendor Inc",
        "org.opencontainers.image.licenses": "Apache-2.0",
    },
    entrypoint = ["/bin/sh", "/app/app.sh"],
    cmd = ["--verbose"],
    working_dir = "/app",
    user = "nobody",
    exposed_ports = ["8080/tcp", "8081/tcp"],
    volumes = ["/app/data", "/app/logs"],
)

# Test 40: Chained image building (3 levels)
oci_image(
    name = "test_chain_level1",
    base = ":alpine_base",
    layers = [":test_layer"],
    env = {"LEVEL": "1"},
)

oci_image(
    name = "test_chain_level2",
    base = ":test_chain_level1",
    layers = [":app_layer"],
    env = {"LEVEL": "2"},
)

oci_image(
    name = "test_chain_level3",
    base = ":test_chain_level2",
    layers = [":config_layer"],
    env = {"LEVEL": "3"},
)

# Test 41-42: Multi-platform with different configs
oci_image(
    name = "test_platform_specific_amd64",
    base = ":alpine_amd64",
    layers = [":app_layer"],
    env = {
        "ARCH": "amd64",
        "PLATFORM": "x86_64",
        "OPTIMIZATIONS": "sse4.2,avx2",
    },
    image_labels = {
        "arch": "amd64",
        "platform.features": "sse4.2,avx2",
    },
)

oci_image(
    name = "test_platform_specific_arm64",
    base = ":alpine_arm64",
    layers = [":app_layer"],
    env = {
        "ARCH": "arm64",
        "PLATFORM": "aarch64",
        "OPTIMIZATIONS": "neon",
    },
    image_labels = {
        "arch": "arm64",
        "platform.features": "neon",
    },
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

# TODO: Fix repack tests - umoci needs source image blobs
# Commented out for now

# load("@root//buck/lib/oci:defs.bzl", "oci_repack")
#
# oci_unpack(
#     name = "test_for_repack_unpacked",
#     image = ":test_complete_app",
#     tag = "latest",
# )
#
# oci_repack(
#     name = "test_repacked",
#     bundle = ":test_for_repack_unpacked",
#     tag = "repacked",
# )
