# Buck2 <-> Cargo integration

This folder holds needed fixups and integrations for buck2 to use rust packages from https://crates.io

## Adding Cargo packages

If you need a new Rust package, or to make one available, you MUST ADD IT TO @Cargo.toml BEFORE YOU CAN
USE IT IN BUILD FILES!

## Please please please please

IF YOU MODIFY @Cargo.toml -- YOU MUST REGENERATE THE BUCK FILE!!!

```
$ROOT_OF_REPO/bootstrap/reindeer --third-party-dir $ROOT_OF_REPO/buck/third-party/rust buckify
```

YOU MUST ALWAYS DO THIS!!!
