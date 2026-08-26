# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Generate exact HTTP body fixtures without checking megabyte blobs into source.

The output directory is a Buck artifact passed to Hurl's --file-root option.
large-part.bin meets S3's minimum nonfinal multipart size; the other two files
exercise arbitrary binary bytes and an empty payload. No network or randomness.
"""

from pathlib import Path
import sys


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: generate.py OUTPUT_DIRECTORY")
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    (output / "large-part.bin").write_bytes(b"a" * (5 * 1024 * 1024))
    (output / "smallbinary.bin").write_bytes(bytes([0, 1, 2, 255]))
    (output / "empty.bin").write_bytes(b"")


if __name__ == "__main__":
    main()
