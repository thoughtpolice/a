# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run the Cloudflare live smoke test.

Usage (through `buck2 run root//src/celld/api/cloudflare:live-smoke-run -- [ARGS]`):

  here, with a token:  CLOUDFLARE_API_TOKEN=... buck2 run ... -- [ARGS]
  on an exe.dev VM:    buck2 run ... -- --vm my-vm.exe.xyz [ARGS]

On a VM the script goes through the Cloudflare HTTP proxy integration
(`--integration NAME`, default `cloudflare`), so the token never leaves
exe.dev. ARGS go to the script: --account ID, --zone NAME, --write,
--intel, --scan (see tests/live/smoke.ts).

Here, Deno is the repository's `buck/bin/deno`, allowed only the
Cloudflare API, siteverify and the token variable. On a VM, the bundle is
copied to `~/.cache/celld-live` and Deno is fetched there once, pinned to
the version and digest in `buck/bin/deno`. The JSON report goes to stdout,
progress to stderr, and the exit status is the script's.
"""

import json
import os
import shlex
import subprocess
import sys

REMOTE_DIR = ".cache/celld-live"

PLATFORMS = {
    "x86_64": "linux-x86_64",
    "aarch64": "linux-aarch64",
}


def ssh(dest: str, command: str, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ssh", "-o", "BatchMode=yes", dest, command], check=False, **kwargs
    )


def deno_release(dotslash_path: str, platform: str) -> dict:
    with open(dotslash_path, encoding="utf-8") as f:
        text = f.read()
    manifest = json.loads(text[text.index("{") :])
    entry = manifest["platforms"][platform]
    if entry["hash"] != "sha256" or entry["format"] != "zip":
        sys.exit(f"live-smoke: unexpected deno entry for {platform}: {entry}")
    return {
        "url": entry["providers"][0]["url"],
        "digest": entry["digest"],
        "path": entry["path"],
    }


def run_here(bundle: str, deno: str, args: list[str]) -> int:
    if not os.environ.get("CLOUDFLARE_API_TOKEN", "").strip():
        sys.exit("live-smoke: set CLOUDFLARE_API_TOKEN, or pass --vm to use an exe.dev integration")
    return subprocess.run(
        [
            deno,
            "run",
            "--no-prompt",
            "--allow-net=api.cloudflare.com,challenges.cloudflare.com",
            "--allow-env=CLOUDFLARE_API_TOKEN",
            bundle,
            *args,
        ],
        check=False,
    ).returncode


def run_on_vm(bundle: str, dotslash: str, dest: str, args: list[str]) -> int:
    arch = ssh(dest, "uname -m", capture_output=True, text=True)
    if arch.returncode != 0:
        sys.stderr.write(arch.stderr)
        return arch.returncode
    platform = PLATFORMS.get(arch.stdout.strip())
    if platform is None:
        sys.exit(f"live-smoke: unsupported VM architecture {arch.stdout.strip()!r}")
    deno = deno_release(dotslash, platform)

    # The digest names the install directory, so a Deno bump fetches anew.
    deno_dir = f"{REMOTE_DIR}/deno-{deno['digest'][:16]}"
    install = f"""set -eu
mkdir -p {deno_dir}
cd {deno_dir}
if [ ! -x deno ]; then
  curl -sSfL -o deno.zip {shlex.quote(deno["url"])}
  echo {shlex.quote(deno["digest"] + "  deno.zip")} | sha256sum -c --quiet
  python3 -c 'import sys, zipfile; zipfile.ZipFile("deno.zip").extract(sys.argv[1])' {shlex.quote(deno["path"])}
  chmod +x deno
  rm deno.zip
fi
"""
    done = ssh(dest, install)
    if done.returncode != 0:
        return done.returncode

    copied = subprocess.run(
        ["scp", "-q", "-o", "BatchMode=yes", bundle, f"{dest}:{REMOTE_DIR}/cloudflare-live-smoke.js"],
        check=False,
    )
    if copied.returncode != 0:
        return copied.returncode

    if "--integration" not in args:
        args = ["--integration", "cloudflare", *args]
    run = " ".join(
        [f"{deno_dir}/deno", "run", "--no-prompt", "--allow-net", f"{REMOTE_DIR}/cloudflare-live-smoke.js"]
        + [shlex.quote(arg) for arg in args]
    )
    return ssh(dest, run).returncode


def main() -> int:
    if len(sys.argv) < 3:
        sys.exit("usage: live_smoke.py BUNDLE DENO [--vm DEST] [ARGS...]")
    bundle, deno, *args = sys.argv[1:]
    if "--vm" in args:
        i = args.index("--vm")
        if i + 1 >= len(args):
            sys.exit("live-smoke: --vm needs a destination")
        dest = args[i + 1]
        return run_on_vm(bundle, deno, dest, args[:i] + args[i + 2 :])
    return run_here(bundle, deno, args)


if __name__ == "__main__":
    sys.exit(main())
