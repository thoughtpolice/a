#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [ "hegel-core==0.10.0" ]
# ///
from hegel.__main__ import main
if __name__ == "__main__":
    main()
