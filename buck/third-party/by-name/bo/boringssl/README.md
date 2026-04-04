## BoringSSL Notes

When you update this package, including the git commit and archive hash, make
sure you also re-download the proper `gen/sources.bzl` file, which is produced
automatically by a bot in the upstream `main` branch:

- https://github.com/google/boringssl/blob/main/gen/sources.bzl

```
curl -Lo \
    buck/third-party/bssl/BUILD.generated.bzl \
    https://raw.githubusercontent.com/google/boringssl/main/gen/sources.bzl
```
