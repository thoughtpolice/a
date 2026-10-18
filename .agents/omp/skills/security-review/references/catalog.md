<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official security-guidance/hooks/patterns.py and README.md at ab024cdc (Apache-2.0); all frozen catalog IDs retained. -->

# Catalog and invocation contract

Call `security_patterns` with one of:

- `{ "paths": ["src/view.ts", ".github/workflows/build.yml"] }`
- `{ "path": "example.py", "content": "torch.load(model, weights_only=True)" }`

The native tool uses the injected schema builder and read approval. It rejects both/neither mode, absent content labels, traversal/absolute/control-character paths, symlink file components, directories, malformed UTF-8 and NUL-bearing file input. Labels never trigger filesystem reads. Limits: 32 explicitly selected files, 256 KiB UTF-8 per input, 2 MiB aggregate. Duplicate normalized paths fail. Paths are relative to the selected workspace; no glob expansion, recursion or implicit language guesses.

Result: `status: heuristic-candidates-only`, selected `files` with byte counts, `candidates`, and `limitations`. Each candidate has stable numeric `ruleId`, `ruleName`, `kind`, relative `path`, 1-based line/UTF-16 column (null for a path-only reminder), and a static message. No matched source snippets, credentials or dynamic source values are included. At most the first location of each rule in each file is returned; overlapping rules are not suppressed.

## All 25 rules

JS gate = case-sensitive suffix `.js .jsx .ts .tsx .mjs .cjs .mts .cts .vue .svelte`.
Python gate = `.py .pyi .ipynb`. Documentation exclusions = `.md .mdx .txt .rst .json .yaml .yml`. Ungated rules retain upstream semantics; validate language manually.

| ID / name | Match and guard |
| --- | --- |
| 1 `github_actions_workflow` | Path contains `.github/workflows/`, ends `.yml/.yaml`; reminder on any contents, **not** an expression/injection match. Review untrusted event title/body/comment/review, commit message/author, pages name, PR head ref/label/default branch, client payload and `github.head_ref` in run/checkout refs. |
| 2 `child_process_exec` | JS; `child_process.exec`, `execSync(` or bare `exec(`; bare regex excludes identifier/dot prefix, not the explicit substrings. |
| 3 `new_function_injection` | JS; `new Function` substring. |
| 4 `eval_injection` | Bare `eval(` excluding identifier/dot prefix (so `model.eval()` is ignored); skip documentation suffixes. |
| 5 `react_dangerously_set_html` | JS; `dangerouslySetInnerHTML`. |
| 6 `document_write_xss` | JS; `document.write`. |
| 7 `innerHTML_xss` | JS; `.innerHTML =` or `.innerHTML=`. |
| 8 `pickle_deserialization` | Python; `pickle.load/loads/Unpickler` or bounded `pkl_load(`; not dump or similarly named loaders. |
| 9 `os_system_injection` | Python; `os.system(` allowing whitespace or `from os import system`. |
| 10 `python_subprocess_shell` | `subprocess.run/call/Popen/check_output/check_call(` with same-line `shell=True`. |
| 11 `go_exec_shell_injection` | `exec.Command(` with double-quoted `sh`, `bash`, `/bin/sh` or `/bin/bash` as the executable. |
| 12 `unsafe_yaml_load` | `yaml.load(` unless a word beginning `Safe` appears before `)`/newline within 80 characters. |
| 13 `node_createcipher_no_iv` | `crypto.createCipher/createDecipher` with word boundary; not `createCipheriv/createDecipheriv`. |
| 14 `aes_ecb_mode` | `AES.MODE_ECB`, `modes.ECB(` or quoted `aes-<digits>-ecb`. |
| 15 `tls_verification_disabled` | `verify=False`, `rejectUnauthorized:false`, `InsecureSkipVerify:true`, `NODE_TLS_REJECT_UNAUTHORIZED=0` (optional leading quote), `ssl._create_unverified_context`, `check_hostname=False`. |
| 16 `marshal_loads` | `marshal.load/loads(`, not dump. |
| 17 `shelve_open` | `shelve.open(`. |
| 18 `xml_unsafe_parse` | ElementTree/ET `parse/fromstring/XML`, minidom `parse/parseString`, xml.sax `parse/make_parser`; verify parser/version semantics rather than assuming every XML call is vulnerable. |
| 19 `pickle_variants_load` | cPickle/cloudpickle/dill `load/loads(`. |
| 20 `outerHTML_xss` | JS; `.outerHTML =` or `.outerHTML=`. |
| 21 `insertAdjacentHTML_xss` | JS; `.insertAdjacentHTML(`. |
| 22 `script_src_without_sri` | External HTTP(S)/protocol-relative script tag, no `integrity=` in bounded tag lookahead; case-sensitive, quoted src. |
| 23 `torch_unsafe_load` | `torch.load` or `.torch_load(` unless same-line `weights_only=True` before `)` within 200 characters; explicit False still matches. |
| 24 `yaml_unsafe_load_variants` | `yaml.unsafe_load(` or `.yaml_unsafe_load(`. |
| 25 `pickle_wrapper_load` | joblib.load, pd/pandas.read_pickle, .cloudpickle_load; np/numpy.load only with explicit same-line `allow_pickle=True` within 200 characters. |

## Known heuristic boundaries

These are regex/substrings, not parsed ASTs: aliases, whitespace changes, casing, comments/strings, sanitizer calls, trust provenance and reachability can produce misses or false positives. JS/Python gates intentionally exclude docs for selected rules, but ungated rules may match prose. File suffixes are case-sensitive. Safe constant HTML/shell strings can still be candidates.

Multiline YAML/torch safe arguments may produce false positives because guards only inspect 80/200 characters on the same line. Multiline subprocess shell or NumPy allow_pickle arguments may be missed. XML and torch behavior depends on library/runtime version; verify it. Script regex permits multiline tag text, bounded to 400 characters for the integrity exclusion, 200 before src, 300 in the URL and 100 after; attribute presence does not validate an SRI digest, and integrity beyond the lookahead may be missed. No regex is run with global mutable state.

Rule 1 intentionally preserves the licensed path-check behavior. Validate direct untrusted expressions in `run:` separately from safe environment-variable transfer with shell quoting. For checkout refs built from `client_payload.pr_number`, verify numeric validation and authority as well as syntax. A workflow reminder is never a vulnerability finding.
