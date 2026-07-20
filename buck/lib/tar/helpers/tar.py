# SPDX-FileCopyrightText: © 2024-2026 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

import argparse
import gzip
import os
import sys
import tarfile


def normalize_tarinfo(tarinfo):
    tarinfo.uid = 0
    tarinfo.gid = 0
    tarinfo.uname = ""
    tarinfo.gname = ""
    tarinfo.mtime = 0
    tarinfo.pax_headers = {}

    if tarinfo.isdir():
        tarinfo.mode = 0o755
    elif tarinfo.isfile():
        tarinfo.mode = 0o755 if tarinfo.mode & 0o111 else 0o644
    elif tarinfo.issym():
        tarinfo.mode = 0o777

    return tarinfo


def add_paths(tar, paths, prefix):
    for path in paths:
        if not os.path.exists(path):
            raise FileNotFoundError(f"Path not found: {path}")

        basename = os.path.basename(path)
        if prefix:
            prefix_clean = prefix.strip("/")
            arcname = f"{prefix_clean}/{basename}" if prefix_clean else basename
        else:
            arcname = basename

        # Buck presents source artifacts through a symlink farm. Resolve only
        # that top-level link so the archive contains the declared artifact,
        # not an absolute link back into the workspace.
        tar.add(
            os.path.realpath(path),
            arcname=arcname,
            filter=normalize_tarinfo,
        )


def create_tar(paths, compress, filename, prefix=None):
    if compress == "true":
        with open(filename, "wb") as output:
            with gzip.GzipFile(
                filename="",
                mode="wb",
                fileobj=output,
                mtime=0,
            ) as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as tar:
                    add_paths(tar, paths, prefix)
    else:
        with tarfile.open(filename, "w") as tar:
            add_paths(tar, paths, prefix)


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
