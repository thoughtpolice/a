# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run @celld/mcp's live test on an exe.dev VM.

Usage (through `buck2 run root//src/celld/mcp:live-run -- VM [OPTIONS]`):

  VM                  the VM's ssh destination, such as `celld-mcp-test.exe.xyz`
  --port N            the VM port to serve on; default 8000, the proxy's port
  --token-file PATH   a VM-scoped exe.dev token for the HTTPS proxy; else
                      $EXEDEV_TOKEN; else one is minted with
                      `ssh exe.dev ssh-key generate-api-key --vm=... --exp=1d`
  --no-proxy          skip the run through https://<vm>.exe.xyz
  --no-interop        skip the official TypeScript SDK interop run
  --sdk-version V     the @modelcontextprotocol/client version; default 2.1.0

What it does:

1. Installs, under ~/.cache/celld-live on the VM, the celld binary for the
   VM's architecture (the toolchain's pinned release, copied from this
   machine and checked by digest) and Deno (pinned by the repository's
   buck/bin/deno DotSlash file), unless already there.
2. Copies the runtime-test project (tests/runtime/worker.ts, with the
   McpChangeHub and McpTasks Durable Objects) to a fresh run directory and
   starts `celld dev` on the port, refusing to start if anything already
   listens there.
3. Runs the TypeScript live client (tests/live/client.ts) from this machine
   against https://<vm>.exe.xyz through exe.dev's proxy, sending the token
   in X-Exedev-Authorization; then on the VM against localhost; then the
   official SDK interop script on the VM.
4. Stops the server and removes the run directory, whatever happened.

The JSON report goes to stdout, progress to stderr; the exit status is 0
only if every run passed. Tokens are never printed or written to disk here.
"""

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
import time

REMOTE = ".cache/celld-live"  # Relative to the VM user's home; made absolute in main.
PLATFORMS = {"x86_64": "linux-x86_64", "aarch64": "linux-aarch64"}


def log(message):
    print(f"live-run: {message}", file=sys.stderr, flush=True)


def ssh(dest, command, **kwargs):
    return subprocess.run(["ssh", "-o", "BatchMode=yes", dest, command], check=False, **kwargs)


def ssh_ok(dest, command, what):
    done = ssh(dest, command, capture_output=True, text=True)
    if done.returncode != 0:
        sys.exit(f"live-run: {what} failed ({done.returncode}): {done.stderr.strip()}")
    return done.stdout


def scp(source, dest, target, recursive=False):
    command = ["scp", "-q", "-o", "BatchMode=yes"] + (["-r"] if recursive else []) + [source, f"{dest}:{target}"]
    if subprocess.run(command, check=False).returncode != 0:
        sys.exit(f"live-run: copying {source} failed")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def deno_release(dotslash_path, platform):
    with open(dotslash_path, encoding="utf-8") as f:
        text = f.read()
    entry = json.loads(text[text.index("{"):])["platforms"][platform]
    if entry["hash"] != "sha256" or entry["format"] != "zip":
        sys.exit(f"live-run: unexpected deno entry for {platform}: {entry}")
    return {"url": entry["providers"][0]["url"], "digest": entry["digest"], "path": entry["path"]}


def install_deno(dest, dotslash, platform):
    deno = deno_release(dotslash, platform)
    directory = f"{REMOTE}/deno-{deno['digest'][:16]}"
    ssh_ok(dest, f"""set -eu
mkdir -p {directory}
cd {directory}
if [ ! -x deno ]; then
  curl -sSfL -o deno.zip {shlex.quote(deno["url"])}
  echo {shlex.quote(deno["digest"] + "  deno.zip")} | sha256sum -c --quiet
  python3 -c 'import sys, zipfile; zipfile.ZipFile("deno.zip").extract(sys.argv[1])' {shlex.quote(deno["path"])}
  chmod +x deno
  rm deno.zip
fi""", "installing deno")
    return f"{directory}/deno"


def install_celld(dest, archive):
    digest = sha256(archive)
    directory = f"{REMOTE}/celld-{digest[:16]}"
    present = ssh(dest, f"test -x {directory}/celld", capture_output=True).returncode == 0
    if not present:
        log(f"copying celld ({digest[:16]}) to the VM")
        ssh_ok(dest, f"mkdir -p {directory}", "making the celld directory")
        scp(archive, dest, f"{directory}/celld.gz")
        ssh_ok(dest, f"""set -eu
cd {directory}
echo {shlex.quote(digest + "  celld.gz")} | sha256sum -c --quiet
gunzip -f celld.gz
chmod +x celld""", "installing celld")
    return f"{directory}/celld"


def mint_token(vm_name):
    done = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "exe.dev", "ssh-key", "generate-api-key",
         f"--vm={vm_name}", "--label=mcp-live", "--exp=1d", "--json"],
        check=False, capture_output=True, text=True)
    if done.returncode != 0:
        sys.exit(f"live-run: minting a VM token failed: {done.stderr.strip()}")
    try:
        found = json.loads(done.stdout)
    except json.JSONDecodeError:
        found = done.stdout
    # The token is the first exe0./exe1. string in the answer.
    stack = [found]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            for word in item.split():
                if word.startswith(("exe0.", "exe1.")):
                    return word
        elif isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    sys.exit("live-run: no token in the generate-api-key answer")


def parse_report(stdout):
    try:
        return json.loads(stdout[stdout.index("{"):])
    except (ValueError, json.JSONDecodeError):
        return {"unparsed": stdout[-4000:]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--client", required=True)
    parser.add_argument("--interop", required=True)
    parser.add_argument("--deno", required=True, help="buck/bin/deno (DotSlash)")
    parser.add_argument("--celld-x86_64", required=True)
    parser.add_argument("--celld-aarch64", required=True)
    parser.add_argument("vm")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--token-file")
    parser.add_argument("--no-proxy", action="store_true")
    parser.add_argument("--no-interop", action="store_true")
    parser.add_argument("--sdk-version", default="2.1.0")
    args = parser.parse_args()

    global REMOTE
    dest = args.vm
    vm_name = dest.split(".")[0]
    arch, home = ssh_ok(dest, 'uname -m; echo "$HOME"', "reaching the VM").split()
    REMOTE = f"{home}/{REMOTE}"
    platform = PLATFORMS.get(arch)
    if platform is None:
        sys.exit(f"live-run: unsupported VM architecture {arch!r}")
    deno = install_deno(dest, args.deno, platform)
    celld = install_celld(dest, args.celld_x86_64 if arch == "x86_64" else args.celld_aarch64)

    listening = ssh_ok(dest, f"ss -ltnH '( sport = :{args.port} )'", "checking the port")
    if listening.strip():
        sys.exit(f"live-run: something already listens on port {args.port} of {dest}; not touching it")

    run = f"{REMOTE}/mcp-live/run-{int(time.time())}-{os.getpid()}"
    ssh_ok(dest, f"mkdir -p {run}", "making the run directory")
    report = {"vm": dest, "arch": arch, "port": args.port, "runs": []}
    try:
        scp(args.project, dest, f"{run}/project", recursive=True)
        scp(args.client, dest, f"{run}/client.js")
        scp(args.interop, dest, f"{run}/sdk_interop.ts")
        # setsid gives celld its own process group, so stopping it stops
        # everything it started and nothing else.
        ssh_ok(dest, f"""set -eu
cd {run}
chmod -R u+w project
env -u RUST_LOG NO_COLOR=1 setsid nohup {celld} dev project --host 0.0.0.0 --port {args.port} \\
  --logs --no-watch > celld.log 2>&1 < /dev/null &
echo $! > celld.pid""", "starting celld")
        deadline = time.monotonic() + 90
        while True:
            logs = ssh_ok(dest, f"cat {run}/celld.log", "reading the celld log")
            if "ready  " in logs:
                break
            if time.monotonic() > deadline or ssh(dest, f"kill -0 $(cat {run}/celld.pid)",
                                                  capture_output=True).returncode != 0:
                sys.exit(f"live-run: celld did not become ready:\n{logs}")
            time.sleep(1)
        report["server"] = {
            "where": f"{dest}:{args.port}",
            "command": f"celld dev project --host 0.0.0.0 --port {args.port}",
            "celld": logs.splitlines()[0] if logs else "",
        }
        log(f"celld dev is serving on {dest}:{args.port}")

        if not args.no_proxy:
            token = None
            if args.token_file:
                with open(args.token_file, encoding="utf-8") as f:
                    token = f.read().strip()
            token = token or os.environ.get("EXEDEV_TOKEN") or mint_token(vm_name)
            origin = f"https://{vm_name}.exe.xyz" + ("" if args.port == 8000 else f":{args.port}")
            log(f"running the client here against {origin} through the exe.dev proxy")
            env = dict(os.environ, EXEDEV_TOKEN=token, NO_COLOR="1")
            done = subprocess.run(
                [args.deno, "run", "--allow-net", "--allow-env", args.client,
                 "--url", origin, "--where", "local"],
                check=False, capture_output=True, text=True, env=env)
            sys.stderr.write(done.stderr[-4000:] if done.returncode != 0 else "")
            report["runs"].append({"client": "@celld/mcp (TypeScript)", "from": "this machine",
                                   "to": origin, "exit": done.returncode,
                                   "report": parse_report(done.stdout)})

        log("running the client on the VM against localhost")
        done = ssh(dest, f"NO_COLOR=1 {deno} run --allow-net --allow-env {run}/client.js "
                         f"--url http://127.0.0.1:{args.port} --where vm",
                   capture_output=True, text=True)
        report["runs"].append({"client": "@celld/mcp (TypeScript)", "from": dest,
                               "to": f"http://127.0.0.1:{args.port}", "exit": done.returncode,
                               "report": parse_report(done.stdout)})

        if not args.no_interop:
            log(f"running @modelcontextprotocol/client@{args.sdk_version} on the VM")
            done = ssh(dest, f"NO_COLOR=1 DENO_DIR={REMOTE}/deno-dir {deno} run --allow-net --allow-env "
                             f"--allow-read --allow-write={REMOTE}/deno-dir --allow-sys "
                             f"{run}/sdk_interop.ts --url http://127.0.0.1:{args.port} "
                             f"--version {shlex.quote(args.sdk_version)}",
                       capture_output=True, text=True)
            if done.returncode != 0:
                sys.stderr.write(done.stderr[-4000:])
            report["runs"].append({"client": f"@modelcontextprotocol/client@{args.sdk_version}",
                                   "from": dest, "to": f"http://127.0.0.1:{args.port}",
                                   "exit": done.returncode, "report": parse_report(done.stdout)})
        report["celldLogTail"] = ssh_ok(dest, f"tail -n 20 {run}/celld.log", "reading the celld log").splitlines()
    finally:
        # Stop the whole process group, wait for the port to close, clean up.
        ssh(dest, f"""if [ -f {run}/celld.pid ]; then
  pid=$(cat {run}/celld.pid)
  kill -TERM -- -$pid 2>/dev/null || true
  for i in $(seq 1 40); do kill -0 $pid 2>/dev/null || break; sleep 0.25; done
  kill -KILL -- -$pid 2>/dev/null || true
fi
rm -rf {run}""", capture_output=True)
        still = ssh(dest, f"ss -ltnH '( sport = :{args.port} )'", capture_output=True, text=True).stdout.strip()
        report["stopped"] = still == ""
        log("stopped the server and removed the run directory" if still == ""
            else f"port {args.port} is still in use after stopping")

    print(json.dumps(report, indent=2))
    ok = report["stopped"] and all(run["exit"] == 0 for run in report["runs"])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
