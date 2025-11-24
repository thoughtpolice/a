# OCI Image Rules for Buck2

Comprehensive OCI (Open Container Initiative) container image support for Buck2.

## Features

- **Pull images from registries**: Download images from Docker Hub, GitHub Container Registry, etc.
- **Build images**: Create images by layering tarballs on base images with full config control
- **Unpack/repack images**: Extract image filesystems, modify them, and rebuild images
- **Multi-platform support**: Build image indexes supporting multiple architectures
- **Pure implementation**: Core image building uses pure Python OCI spec implementation
- **Battle-tested tools**: Uses skopeo for registry ops and umoci for filesystem operations

## Architecture

### Tools

- **skopeo** (v1.20.0): Registry pull/push operations
- **umoci** (v0.6.0): Unpack/repack filesystem bundles
- **Pure Python**: Manifest and config manipulation (no external tools)

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

**Output:** OCI runtime bundle directory (contains `rootfs/` and `config.json`)

### `oci_repack`

Repack a modified filesystem bundle back into an OCI image.

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
- `base` (dep, optional): Base image to repack from
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

Test images can be inspected with standard OCI tools:

```bash
# Inspect with skopeo
skopeo inspect oci:buck-out/v2/.../image

# Inspect with umoci
umoci stat --image buck-out/v2/.../image:latest

# Extract and examine
umoci unpack --image buck-out/v2/.../image:latest bundle
ls -la bundle/rootfs/
```

## Comparison to Old Implementation

### Old (crane-based)

- Heavy dependency on crane
- Inefficient: local registry server + multiple crane calls
- Limited layer manipulation
- Worked around crane bugs

### New (skopeo + umoci + pure Python)

- Minimal tool dependencies (only where needed)
- Pure Python for core operations (faster, more flexible)
- Direct OCI spec implementation
- Full control over all image aspects
- No workarounds needed

## Future Enhancements

Possible future additions:

- **oci_push**: Push images to registries
- **oci_copy**: Copy images between registries
- **oci_export**: Export to Docker tar format
- **oci_import**: Import from Docker tar format
- **Layer caching**: Advanced layer deduplication
- **Signature support**: Image signing and verification

## References

- [OCI Image Specification](https://github.com/opencontainers/image-spec)
- [skopeo](https://github.com/containers/skopeo)
- [umoci](https://umo.ci/)
