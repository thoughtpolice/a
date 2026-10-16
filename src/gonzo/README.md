# gonzo

An experiment to build a `localhost`-only implementation of the RBE API. This is
intended to serve a CAS and ActionCache so that you can use it even if you don't
have servers for remote execution available.

Another goal is to use [`gha-action`][gha-action] to interface with GHA caches
on GitHub so you can get a transparent RBE cache for free.

## Run it

```bash
buck2 run //src/gonzo --
```

It listens on `127.0.0.1:8980` (Buildbarn's port; 8080 is too often
taken by something else). The store defaults to `gonzo/store` under `$XDG_CACHE_HOME` (usually
`~/.cache/gonzo/store`), so every checkout on the machine shares it; pass
`--store` for another location, or `--store memory` for a throwaway one.

[gha-action]: https://github.com/DeterminateSystems/magic-nix-cache/tree/main/gha-cache

## Execute actions

The daemon also executes actions: it runs a worker for its own machine (one
slot per CPU; `--local-worker-slots` to change it), and other machines can
join it as workers over [iroh](https://www.iroh.computer), from anywhere:

```bash
# on the daemon's machine
buck2 run //src/gonzo -- serve --accept-workers
buck2 run //src/gonzo -- ticket

# on another machine
buck2 run //src/gonzo/worker/bin:gonzo-worker -- --join <ticket>
```

The ticket is a credential: whoever holds it can join as a worker, and the
daemon caches what its workers report. Removing `mesh/join-key` from the
store's directory, and restarting, revokes every ticket. See
[notes/execution.md](notes/execution.md) for the design.
