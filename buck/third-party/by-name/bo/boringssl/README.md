## BoringSSL Notes

When you update this package, including the git commit and archive hash, also
download `gen/sources.bzl` from that exact commit.  Do not use the moving
`main` branch: mixing its source list with a different archive revision can
silently omit, add, or rename files in the Buck build.

Set `GIT_COMMIT` to the same value used in `PACKAGE`, then run:

```sh
GIT_COMMIT=922c15f36cc75db5af33c46f9ea8934553fb808e
curl --fail --location \
    --output buck/third-party/by-name/bo/boringssl/BUILD.generated.bzl \
    "https://raw.githubusercontent.com/google/boringssl/${GIT_COMMIT}/gen/sources.bzl"
```

Review the manifest diff together with the BoringSSL revision change before
updating the archive hash.
