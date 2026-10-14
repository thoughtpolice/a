# OCI Image Rules for Buck2

Comprehensive OCI (Open Container Initiative) container image support for Buck2.

## Features

- **Pull images from registries**: Download images from Docker Hub, GitHub Container Registry, etc.
- **Build images**: Create images by layering tarballs on base images with full config control
- **Package native binaries**: Strip and relocate ELF binaries, or carry their exact Nix runtime closure
- **Export to Docker**: Produce archives accepted directly by `docker load`
- **Push to registries**: `buck2 run` a push target to copy an image to any registry
- **Smoke-test with Docker**: Load an OCI layout, wait for readiness, and clean up automatically
- **Unpack/repack images**: Extract image filesystems, modify them, and rebuild images
- **Multi-platform support**: Build image indexes supporting multiple architectures
- **Self-contained**: One Go tool, built from source, does all of it

## Architecture

### Tools

- **`buck/tools/oci`**: A Go program, with only the standard library and
  `golang.org/x`, behind every rule here and `tar_file`. It reads and writes
  OCI image layouts, speaks the registry HTTP API with token authentication,
  writes Docker archives, applies layers with whiteouts, and finds a native
  binary's Nix closure. Run `buck2 run //buck/tools/oci:oci -- help` for its
  commands.
- **patchelf** (v0.19.1): Repoints native binaries at compatible base runtimes,
  built from source in `third-party//by-name/pa/patchelf`.

### Design Principles

1. **Hermetic builds**: All operations are reproducible and cacheable
2. **No daemon required**: Unlike Docker, no background service needed
3. **OCI-native**: Implements OCI Image Spec v1.0 directly
4. **Efficient**: Reuses layers, content-addressable storage
5. **Type-safe**: Full Buck2 rule integration with providers

## Rules

### `oci_pull`

Pull an OCI image from a container registry.

```python
load("@buck//lib/oci:defs.bzl", "oci_pull")

oci_pull(
    name = "alpine_base",
    image = "docker.io/library/alpine",
    digest = "sha256:...",  # optional but recommended
    platform = "linux/amd64",
)
```

**Attributes:**
- `image` (string): Image reference (e.g., "docker.io/library/alpine")
- `digest` (string, optional): Specific digest to pull
- `platform` (string): Platform (default: "linux/amd64")

**Output:** OCI image layout directory

### `oci_image`

Build a new OCI image from a base image plus additional layers and configuration.

```python
load("@buck//lib/oci:defs.bzl", "oci_image")
load("@buck//lib/tar:defs.bzl", "tar_file")

tar_file(
    name = "app_layer",
    srcs = [":my_binary"],
    compress = True,
)

oci_image(
    name = "my_app_image",
    base = ":alpine_base",
    layers = [":app_layer"],
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "APP_ENV": "production",
    },
    entrypoint = ["/usr/local/bin/my_binary"],
    cmd = ["--serve"],
    working_dir = "/app",
    user = "nobody",
    image_labels = {
        "org.opencontainers.image.source": "https://github.com/example/repo",
        "org.opencontainers.image.version": "1.0.0",
    },
)
```

**Attributes:**
- `base` (dep): Base OCI image (from `oci_pull` or another `oci_image`)
- `layers` (list[dep]): Tar files to add as layers
- `env` (dict[str, str]): Environment variables
- `image_labels` (dict[str, str]): OCI image labels (metadata)
- `entrypoint` (list[str]): Entrypoint command
- `cmd` (list[str]): Default command arguments
- `working_dir` (string): Working directory
- `user` (string): User to run as

**Output:** OCI image layout directory

### `native_binary_layer` and `oci_native_binary_image`

`native_binary_layer` installs an ELF executable at an explicit image path. By
default it reads `PT_INTERP`, `DT_RPATH`, and `DT_RUNPATH`, copies every
referenced `/nix/store/<hash>-...` root, then follows embedded Nix references,
ELF runtime paths, and cross-store symlinks to a fixed point. This is the safe
choice for an arbitrary container base because the executable keeps the exact
runtime against which it was linked.

`oci_native_binary_image` is the convenient application-level macro. It emits
the layer, the `<name>` OCI layout, and a `<name>-docker` archive:

```python
load("@root//buck/shims:shims.bzl", depot = "shims")

depot.oci.native_binary_image(
    name = "worker-image",
    binary = ":worker",
    base = ":base",
    destination = "/usr/local/bin/worker",
    cmd = ["serve"],
    exposed_ports = ["8080/tcp"],
)
```

For a pinned base whose glibc and compiler runtimes are known to be ABI
compatible, the binary can instead be repointed at the base libraries. This is
smaller because it does not duplicate the Nix store in the image:

```python
depot.oci.native_binary_image(
    name = "worker-image",
    binary = ":worker",
    base = "third-party//oci-images:chainguard_glibc_dynamic_amd64",
    destination = "/usr/local/bin/worker",
    include_nix_store = False,
    interpreter = "/lib64/ld-linux-x86-64.so.2",
    rpath = "/usr/lib",
)
```

Only use the second form when the base runtime has been validated against the
toolchain. PatchELF is built from source as part of the OCI toolchain, so this
mode does not depend on a host package. The `strip` setting accepts `none`,
`debug` (the default), or `all`.

### `oci_archive`

Export any OCI layout as a Docker archive independently of the native-binary
macro:

```python
depot.oci.archive(
    name = "worker-docker",
    image = ":worker-image",
    image_name = "worker",
    tag = "latest",
)
```

The output can be imported with `docker load -i <output>`. Like `docker save`
since Docker 25, it is both a legacy Docker archive and an OCI image layout,
and it holds the image's layers as they are. `tag` controls the
tag embedded in that archive; `source_tag` selects an existing tag from the OCI
layout and defaults to `latest`, which is what `oci_image` produces.

### `oci_push`

Push an image or a multi-platform index to a registry. Pushing is a side
effect, so it happens when the target runs, never during a build:

```python
depot.oci.push(
    name = "worker-push",
    image = ":worker-image",
    # Optional. Lets `buck2 run :worker-push` with no arguments push
    # ghcr.io/example/worker:latest, and `-- --tag v1` push :v1.
    repository = "ghcr.io/example/worker",
    tags = ["latest"],
)
```

```bash
buck2 run //path/to:worker-push -- ghcr.io/example/worker:v1
buck2 run //path/to:worker-push -- --tag v1 --tag latest
buck2 run //path/to:worker-push -- --dry-run ttl.sh/me-worker:1h
```

Each destination needs an explicit tag. When a push succeeds the target
prints the image by digest, `ghcr.io/example/worker@sha256:...`, on stdout,
so a script can capture the exact image it pushed. `oci:PATH[:TAG]` writes
into an image layout instead of a registry, and
`docker-archive:PATH:NAME[:TAG]` writes an archive for `docker load`.

The push opens every blob of the layout before it starts, and checks each
one's digest as it uploads it, so rebuilding the image while a push runs
can't change what gets pushed. An `oci_index` layout, which lists one
manifest per platform, is wrapped in a single image index and pushed as one
multi-platform image. Failed requests are retried three times
(`--retry-times`), and a layer the repository already has isn't uploaded
again.

Credentials come from the files skopeo, podman and docker use, in this
order: `REGISTRY_AUTH_FILE`, `$XDG_RUNTIME_DIR/containers/auth.json`,
`~/.config/containers/auth.json`, then `~/.docker/config.json`, whose
credential helpers work too. `--authfile PATH` replaces them all. Log in
with whichever you have:

```bash
docker login ghcr.io   # or: podman login ghcr.io
```

### `oci_container_test`

Run an image under Docker and require both a fixed readiness log line and a
still-running container. The test streams the OCI layout to `docker load`
and removes its temporary container and tag on normal, failure, and SIGTERM
exit paths:

```python
depot.oci.container_test(
    name = "worker-image-smoke",
    image = ":worker-image",
    ready_log = "worker ready",
    timeout_seconds = 15,
)
```

The host running the test must provide a working Docker daemon.

### `oci_unpack`

Unpack an OCI image to a filesystem bundle for inspection or modification.

```python
load("@buck//lib/oci:defs.bzl", "oci_unpack")

oci_unpack(
    name = "unpacked_image",
    image = ":my_app_image",
    tag = "latest",
)
```

**Attributes:**
- `image` (dep): OCI image to unpack
- `tag` (string): Tag to unpack (default: "latest")

**Output:** OCI runtime bundle directory: `rootfs/`, a rootless `config.json`
for a runtime such as `runc` or `crun`, and `oci-unpack.json`, which records
each path's original owner and mode for `oci_repack`. The unpack is rootless:
files belong to the user running the build, device nodes are skipped, and the
owner can always read every file and enter every directory.

### `oci_repack`

Repack a bundle from `oci_unpack` back into an OCI image. Without `base`, the
whole root filesystem becomes the image's one layer. With `base`, which has to
be the image the bundle was unpacked from, the image is the base plus one layer
of what changed, with whiteouts for removed paths. Paths whose content is
unchanged keep their recorded owners and modes.

```python
load("@buck//lib/oci:defs.bzl", "oci_repack")

oci_repack(
    name = "modified_image",
    bundle = ":unpacked_image",
    tag = "modified",
)
```

**Attributes:**
- `bundle` (dep): Bundle directory (from `oci_unpack` or manual creation)
- `base` (dep, optional): The image the bundle was unpacked from
- `tag` (string): Tag for output image (default: "latest")

**Output:** OCI image layout directory

### `oci_index`

Create a multi-platform image index combining multiple platform-specific images.

```python
load("@buck//lib/oci:defs.bzl", "oci_image", "oci_index")

oci_image(
    name = "app_amd64",
    base = ":alpine_amd64",
    layers = [":app_layer_amd64"],
    # ... config ...
)

oci_image(
    name = "app_arm64",
    base = ":alpine_arm64",
    layers = [":app_layer_arm64"],
    # ... config ...
)

oci_index(
    name = "app_multiplatform",
    images = [":app_amd64", ":app_arm64"],
    platforms = ["linux/amd64", "linux/arm64"],
)
```

**Attributes:**
- `images` (list[dep]): Platform-specific images
- `platforms` (list[str]): Corresponding platform strings

**Output:** OCI image index directory

## Implementation Details

### OCI Image Structure

An OCI image layout consists of:

```
image/
├── oci-layout          # Version marker
├── index.json          # Entry point (points to manifests)
└── blobs/
    └── sha256/
        ├── <manifest>  # Image manifest
        ├── <config>    # Image configuration
        └── <layer>...  # Layer tar archives
```

### Layer Composition

Layers are applied in order from base to top:

1. Base image layers (from `base` attribute)
2. New layers (from `layers` attribute)

Each layer is a tar archive (optionally compressed) containing filesystem changes.

### Content Addressing

All blobs (manifests, configs, layers) are stored by their SHA256 digest:
- `blobs/sha256/<hash>` contains the blob content
- Manifests reference blobs by `sha256:<hash>` digest
- This enables deduplication and verification

### DiffIDs vs Digests

- **Digest**: SHA256 of the compressed tar (stored in manifest)
- **DiffID**: SHA256 of the uncompressed tar (stored in config)
- Both are required for OCI compliance

## Testing

`buck2 test //buck/lib/oci/... //buck/tools/oci/...` runs the tool's unit
tests, which include a registry served over TLS, and validates every test
image blob by blob. Images can also be checked and inspected by hand:

```bash
# Check descriptors, digests and diff IDs
buck2 run //buck/tools/oci:oci -- validate buck-out/v2/.../image

# Extract and examine
buck2 run //buck/tools/oci:oci -- unpack --image buck-out/v2/.../image --output bundle
ls -la bundle/rootfs/

# Build and load a Docker archive
archive=$(buck2 build //path/to:worker-image-docker --show-full-simple-output)
docker load -i "$archive"
docker run --rm worker:latest --version
```

## Future Enhancements

Possible future additions:

- **oci_copy**: Copy images between registries
- **oci_import**: Import from Docker tar format
- **Layer caching**: Advanced layer deduplication
- **Signature support**: Image signing and verification

## References

- [OCI Image Specification](https://github.com/opencontainers/image-spec)
- [OCI Distribution Specification](https://github.com/opencontainers/distribution-spec)
- [patchelf](https://github.com/NixOS/patchelf)
