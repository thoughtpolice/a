These are the `hex0` bootstrapping binaries: minimal ~300-byte programs that can
be hand audited and inspected.

The behavior of `hex0` can be approximated with:

```bash
sed 's/[;#].*$//g' $input_file | xxd -r -p > $output_file
```
