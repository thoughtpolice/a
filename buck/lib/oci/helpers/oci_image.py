# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Build OCI images using pure Python manipulation of OCI image layouts.
No external tools required - implements OCI spec directly.
"""

import argparse
import hashlib
import json
import shutil
import sys
import tarfile
from pathlib import Path
from typing import Any, Dict, List, Optional


def sha256_digest(data: bytes) -> str:
    """Compute SHA256 digest in OCI format"""
    return "sha256:" + hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    """Compute SHA256 digest of a file"""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def is_gzip(path: Path) -> bool:
    """Check if a file is gzip-compressed by checking magic bytes"""
    with open(path, "rb") as f:
        magic = f.read(2)
        return magic == b'\x1f\x8b'


def sha256_tar_uncompressed(path: Path) -> str:
    """
    Compute SHA256 of uncompressed tar (diffID).
    This is required for the config's rootfs.diff_ids field.
    """
    import gzip

    h = hashlib.sha256()

    # Check if file is gzip-compressed
    if is_gzip(path):
        # Decompress and hash the uncompressed tar
        with gzip.open(path, "rb") as f:
            while chunk := f.read(8192):
                h.update(chunk)
    else:
        # Hash the tar file directly
        with open(path, "rb") as f:
            while chunk := f.read(8192):
                h.update(chunk)

    return "sha256:" + h.hexdigest()


class OciImageBuilder:
    """Build OCI images by manipulating image layouts"""

    def __init__(self, base_path: str, output_path: str):
        self.base_path = Path(base_path)
        self.output_path = Path(output_path)
        self.output_path.mkdir(parents=True, exist_ok=True)

        # Load base image
        self.base_index = self._load_json(self.base_path / "index.json")
        self.base_manifest_desc = self.base_index["manifests"][0]
        self.base_manifest = self._load_blob(self.base_manifest_desc["digest"])
        self.base_config = self._load_blob(self.base_manifest["config"]["digest"])

    def _load_json(self, path: Path) -> Dict:
        """Load and parse a JSON file"""
        with open(path) as f:
            return json.load(f)

    def _load_blob(self, digest: str) -> Dict:
        """Load a blob from the base image by digest"""
        algo, hash_val = digest.split(":", 1)
        blob_path = self.base_path / "blobs" / algo / hash_val
        return self._load_json(blob_path)

    def _write_blob(self, data: bytes, digest: str) -> Path:
        """Write a blob to the output image"""
        algo, hash_val = digest.split(":", 1)
        blob_dir = self.output_path / "blobs" / algo
        blob_dir.mkdir(parents=True, exist_ok=True)
        blob_path = blob_dir / hash_val
        blob_path.write_bytes(data)
        return blob_path

    def _copy_blob(self, digest: str):
        """Copy a blob from base to output"""
        algo, hash_val = digest.split(":", 1)
        src = self.base_path / "blobs" / algo / hash_val
        dst = self.output_path / "blobs" / algo
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst / hash_val)

    def build(
        self,
        layers: List[str],
        env: Optional[Dict[str, str]] = None,
        entrypoint: Optional[List[str]] = None,
        cmd: Optional[List[str]] = None,
        working_dir: Optional[str] = None,
        user: Optional[str] = None,
        labels: Optional[Dict[str, str]] = None,
        exposed_ports: Optional[List[str]] = None,
        volumes: Optional[List[str]] = None,
        created: str = "1970-01-01T00:00:00Z",
    ) -> str:
        """
        Build a new OCI image from base + new layers + config changes.

        Returns the output directory path.
        """
        print("Building OCI image...", file=sys.stderr)
        print(f"Base: {self.base_path}", file=sys.stderr)
        print(f"Output: {self.output_path}", file=sys.stderr)
        print(f"Adding {len(layers)} new layers", file=sys.stderr)

        # Step 1: Copy all base layers
        print("Copying base image layers...", file=sys.stderr)
        for layer_desc in self.base_manifest["layers"]:
            self._copy_blob(layer_desc["digest"])

        # Step 2: Process new layers and compute diffIDs
        new_layer_descriptors = []
        new_diff_ids = []

        for i, layer_path in enumerate(layers):
            print(f"Processing layer {i + 1}/{len(layers)}: {layer_path}", file=sys.stderr)
            layer_file = Path(layer_path)

            # Copy layer to blobs
            layer_digest = sha256_file(layer_file)
            self._copy_blob_file(layer_file, layer_digest)

            # Compute diffID (uncompressed digest)
            diff_id = sha256_tar_uncompressed(layer_file)

            # Create layer descriptor - detect compression by file content
            if is_gzip(layer_file):
                media_type = "application/vnd.oci.image.layer.v1.tar+gzip"
            else:
                media_type = "application/vnd.oci.image.layer.v1.tar"

            new_layer_descriptors.append({
                "mediaType": media_type,
                "digest": layer_digest,
                "size": layer_file.stat().st_size,
            })
            new_diff_ids.append(diff_id)

        # Step 3: Create new config
        print("Creating new image configuration...", file=sys.stderr)
        new_config = self._create_config(
            new_diff_ids,
            env,
            entrypoint,
            cmd,
            working_dir,
            user,
            labels,
            exposed_ports,
            volumes,
            created,
        )
        config_json = json.dumps(new_config, indent=2, sort_keys=True).encode()
        config_digest = sha256_digest(config_json)
        self._write_blob(config_json, config_digest)

        # Step 4: Create new manifest
        print("Creating new image manifest...", file=sys.stderr)
        all_layers = self.base_manifest["layers"] + new_layer_descriptors
        new_manifest = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": config_digest,
                "size": len(config_json),
            },
            "layers": all_layers,
        }
        manifest_json = json.dumps(new_manifest, indent=2, sort_keys=True).encode()
        manifest_digest = sha256_digest(manifest_json)
        self._write_blob(manifest_json, manifest_digest)

        # Step 5: Create index.json
        print("Creating index...", file=sys.stderr)
        index = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": manifest_digest,
                    "size": len(manifest_json),
                    "annotations": {
                        "org.opencontainers.image.ref.name": "latest",
                    },
                }
            ],
        }
        with open(self.output_path / "index.json", "w") as f:
            json.dump(index, f, indent=2, sort_keys=True)

        # Step 6: Create oci-layout marker
        oci_layout = {"imageLayoutVersion": "1.0.0"}
        with open(self.output_path / "oci-layout", "w") as f:
            json.dump(oci_layout, f, indent=2)

        print(f"Successfully built OCI image at {self.output_path}", file=sys.stderr)
        return str(self.output_path)

    def _copy_blob_file(self, src_file: Path, digest: str):
        """Copy a file to the blobs directory with the given digest"""
        algo, hash_val = digest.split(":", 1)
        dst = self.output_path / "blobs" / algo
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_file, dst / hash_val)

    def _create_config(
        self,
        new_diff_ids: List[str],
        env: Optional[Dict[str, str]],
        entrypoint: Optional[List[str]],
        cmd: Optional[List[str]],
        working_dir: Optional[str],
        user: Optional[str],
        labels: Optional[Dict[str, str]],
        exposed_ports: Optional[List[str]],
        volumes: Optional[List[str]],
        created: str,
    ) -> Dict[str, Any]:
        """Create new image configuration based on base + modifications"""
        # Start with base config
        config = json.loads(json.dumps(self.base_config))

        # Update rootfs with new layers
        all_diff_ids = config["rootfs"]["diff_ids"] + new_diff_ids
        config["rootfs"]["diff_ids"] = all_diff_ids

        # Update config section
        if "config" not in config:
            config["config"] = {}

        if env is not None:
            # Merge with existing env vars
            existing_env = {
                e.split("=", 1)[0]: e.split("=", 1)[1]
                for e in config["config"].get("Env", [])
                if "=" in e
            }
            existing_env.update(env)
            config["config"]["Env"] = [f"{k}={v}" for k, v in existing_env.items()]

        if entrypoint is not None:
            config["config"]["Entrypoint"] = entrypoint

        if cmd is not None:
            config["config"]["Cmd"] = cmd

        if working_dir is not None:
            config["config"]["WorkingDir"] = working_dir

        if user is not None:
            config["config"]["User"] = user

        if labels is not None:
            if "Labels" not in config["config"]:
                config["config"]["Labels"] = {}
            config["config"]["Labels"].update(labels)

        if exposed_ports is not None and exposed_ports:
            if "ExposedPorts" not in config["config"]:
                config["config"]["ExposedPorts"] = {}
            for port in exposed_ports:
                config["config"]["ExposedPorts"][port] = {}

        if volumes is not None and volumes:
            if "Volumes" not in config["config"]:
                config["config"]["Volumes"] = {}
            for volume in volumes:
                config["config"]["Volumes"][volume] = {}

        config["created"] = created

        # Add history entries for new layers
        for i, _ in enumerate(new_diff_ids):
            config["history"].append({
                "created": config["created"],
                "created_by": f"buck2 oci_image (layer {i + 1}/{len(new_diff_ids)})",
            })

        return config


def main():
    parser = argparse.ArgumentParser(description="Build OCI images")
    parser.add_argument("--base", required=True, help="Base OCI image directory")
    parser.add_argument("--output", required=True, help="Output OCI image directory")
    parser.add_argument(
        "--layers", nargs="*", default=[], help="Tar files to add as layers"
    )
    parser.add_argument(
        "--env", action="append", help="Environment variables (KEY=VALUE)"
    )
    parser.add_argument("--entrypoint", help="Entrypoint (comma-separated)")
    parser.add_argument("--cmd", help="Command (comma-separated)")
    parser.add_argument("--workdir", help="Working directory")
    parser.add_argument("--user", help="User")
    parser.add_argument("--label", action="append", help="Labels (KEY=VALUE)")
    parser.add_argument("--exposed-port", action="append", help="Exposed ports")
    parser.add_argument("--volume", action="append", help="Volume mount points")
    parser.add_argument(
        "--created",
        required=True,
        help="RFC 3339 creation timestamp for the image and new history entries",
    )

    args = parser.parse_args()

    # Parse env vars
    env_dict = None
    if args.env:
        env_dict = {}
        for e in args.env:
            if "=" in e:
                k, v = e.split("=", 1)
                env_dict[k] = v

    # Parse entrypoint
    entrypoint = None
    if args.entrypoint:
        entrypoint = [s.strip() for s in args.entrypoint.split(",") if s.strip()]

    # Parse cmd
    cmd = None
    if args.cmd:
        cmd = [s.strip() for s in args.cmd.split(",") if s.strip()]

    # Parse labels
    labels = None
    if args.label:
        labels = {}
        for lbl in args.label:
            if "=" in lbl:
                k, v = lbl.split("=", 1)
                labels[k] = v

    # Build the image
    builder = OciImageBuilder(args.base, args.output)
    builder.build(
        layers=args.layers,
        env=env_dict,
        entrypoint=entrypoint,
        cmd=cmd,
        working_dir=args.workdir,
        user=args.user,
        labels=labels,
        exposed_ports=args.exposed_port,
        volumes=args.volume,
        created=args.created,
    )


if __name__ == "__main__":
    main()
