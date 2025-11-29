# buck2-cache-server

An experiment to build a `localhost`-only implementation of the RBE API. This is
intended to serve a CAS and ActionCache so that you can use it even if you don't
have servers for remote execution available.

Another goal is to use [`gha-action`][gha-action] to interface with GHA caches
on GitHub so you can get a transparent RBE cache for free.

## Run it

```bash
buck2 run //src/tools/cache-server --
```

[gha-action]: https://github.com/DeterminateSystems/magic-nix-cache/tree/main/gha-cache
