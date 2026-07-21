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

## Container image

`:cache-server-image` is an OCI image layout based on the pinned
Chainguard/Wolfi `glibc-dynamic` runtime. `:cache-server-image-docker` is the
same image as a Docker archive. The image runs as uid 65532 and listens on all
container interfaces at port 8080.

```bash
# Release mode keeps the application layer substantially smaller.
buck2 build -m mode//:build-mode[release] \
  //src/tools/cache-server:cache-server-image-docker

archive=$(buck2 build -m mode//:build-mode[release] \
  //src/tools/cache-server:cache-server-image-docker \
  --show-full-simple-output)
docker load -i "$archive"
docker run --rm -p 8080:8080 cache-server:latest
```

The Docker readiness smoke can also be run directly:

```bash
buck2 test -m mode//:build-mode[release] \
  //src/tools/cache-server:cache-server-image-smoke
```

The baked command is `serve --address 0.0.0.0:8080`; extra arguments passed to
`docker run` replace that command. The default store is in-memory. Set
`CACHE_SERVER_STORE` to a writable mounted path for persistent storage.

[gha-action]: https://github.com/DeterminateSystems/magic-nix-cache/tree/main/gha-cache
