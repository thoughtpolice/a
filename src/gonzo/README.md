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
# on the daemon's machine: it prints its join code as it starts
buck2 run //src/gonzo -- serve
buck2 run //src/gonzo -- code      # prints it again

# on another machine
buck2 run //src/gonzo/worker/bin:gonzo-worker -- --join acid-bunny-crown-dwarf-ivory-swamp
```

The join code is six random words, made up the first time the daemon runs
and kept in the store's directory (`mesh/join-code`). The daemon announces
itself under it on the BitTorrent mainline DHT, where workers find it. What
the DHT sees is derived from the code through Argon2id, so the code cannot
be found by trying codes against it. Where the DHT cannot be reached,
`gonzo ticket` prints a ticket, which carries the daemon's addresses
instead (`--remote-workers ticket` to accept tickets alone, `off` to accept
no remote workers).

The code and the ticket are credentials: whoever holds one can join as a
worker, and the daemon caches what its workers report. Removing
`mesh/join-code` from the store's directory, and restarting, makes up a new
code; removing `mesh/join-key` revokes every ticket. See
[notes/execution.md](notes/execution.md) for the design.
