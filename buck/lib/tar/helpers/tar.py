# SPDX-FileCopyrightText: © 2024-2025 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

import argparse
import tarfile
import os
import sys

def create_tar(paths, compress, filename, prefix=None):
    with tarfile.open(filename, "w:gz" if compress == "true" else "w") as tar:
        for path in paths:
            if not os.path.exists(path):
                raise FileNotFoundError(f"Path not found: {path}")

            # Determine the archive name
            basename = os.path.basename(path)
            if prefix:
                # Ensure prefix doesn't have leading/trailing slashes
                prefix_clean = prefix.strip("/")
                arcname = f"{prefix_clean}/{basename}" if prefix_clean else basename
            else:
                arcname = basename

            tar.add(path, arcname=arcname)

def read_paths(file_path):
    try:
        with open(file_path, "r") as file:
            return file.read().splitlines()
    except IOError as e:
        print(f"Failed to read file {file_path}: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Create a tar file from specified paths"
    )
    parser.add_argument(
        "--compress", required=True, help="Whether to gzip the tar file"
    )
    parser.add_argument(
        "--file_path",
        required=True,
        help="Path to the file containing paths to include in the tar file",
    )
    parser.add_argument("--filename", required=True, help="Name of the tar file")
    parser.add_argument(
        "--prefix",
        default=None,
        help="Directory prefix to add to all files (e.g., 'usr/local/bin')",
    )
    args = parser.parse_args()

    paths = read_paths(args.file_path)

    try:
        create_tar(paths, args.compress, args.filename, prefix=args.prefix)
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        sys.exit(1)
