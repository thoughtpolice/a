// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

// The fixtures below are trimmed captures of real reports produced by this
// repository's pinned buck2, plus one handcrafted report exercising the
// shapes that are awkward to reproduce on demand (shared cause indexes,
// multiple configurations, legacy string errors, fill-out-failures).

// fixtureSuccessBuild is a `buck2 build` report: all targets succeed and
// carry configured graph sizes.
const fixtureSuccessBuild = `{
  "trace_id": "b1d22bda-529d-43cf-8e44-d04281f6a22c",
  "success": true,
  "results": {
    "depot//buck/tools/quicktd:quicktd": {
      "success": "SUCCESS",
      "outputs": {"DEFAULT": ["buck-out/v2/art/depot/1a608cc1468ec806/buck/tools/quicktd/__quicktd__/quicktd.exe"]},
      "other_outputs": {},
      "configured_graph_size": 7,
      "configured": {
        "cfg:<empty>#1a608cc1468ec806": {
          "errors": [],
          "success": "SUCCESS",
          "outputs": {"DEFAULT": ["buck-out/v2/art/depot/1a608cc1468ec806/buck/tools/quicktd/__quicktd__/quicktd.exe"]},
          "other_outputs": {},
          "configured_graph_size": 7
        }
      },
      "errors": []
    },
    "depot//buck/tools/check-dotslash-file:check-hashes": {
      "success": "SUCCESS",
      "outputs": {"DEFAULT": ["buck-out/v2/art/depot/1a608cc1468ec806/buck/tools/check-dotslash-file/__check-hashes__/hashes.py"]},
      "other_outputs": {},
      "configured_graph_size": 5,
      "configured": {
        "cfg:<empty>#1a608cc1468ec806": {
          "errors": [],
          "success": "SUCCESS",
          "outputs": {"DEFAULT": ["buck-out/v2/art/depot/1a608cc1468ec806/buck/tools/check-dotslash-file/__check-hashes__/hashes.py"]},
          "other_outputs": {},
          "configured_graph_size": 5
        }
      },
      "errors": []
    },
    "depot//src/tools/omnifix:omnifix": {
      "success": "SUCCESS",
      "outputs": {"DEFAULT": ["buck-out/v2/art/depot/0e3cc681e4081ce8/src/tools/omnifix/__omnifix__/omnifix"]},
      "other_outputs": {},
      "configured_graph_size": 52,
      "configured": {
        "cfg:<empty>#1a608cc1468ec806": {
          "errors": [],
          "success": "SUCCESS",
          "outputs": {"DEFAULT": ["buck-out/v2/art/depot/0e3cc681e4081ce8/src/tools/omnifix/__omnifix__/omnifix"]},
          "other_outputs": {},
          "configured_graph_size": 52
        }
      },
      "errors": []
    },
    "tilde//aseipp/hello:hello": {
      "success": "SUCCESS",
      "outputs": {"DEFAULT": ["buck-out/v2/art/tilde/deadbeef00000000/aseipp/hello/__hello__/hello"]},
      "other_outputs": {"extra": ["buck-out/v2/art/tilde/deadbeef00000000/aseipp/hello/__hello__/hello.dwp"]},
      "configured_graph_size": 12,
      "configured": {
        "cfg:<empty>#1a608cc1468ec806": {
          "errors": [],
          "success": "SUCCESS",
          "outputs": {"DEFAULT": ["buck-out/v2/art/tilde/deadbeef00000000/aseipp/hello/__hello__/hello"]},
          "other_outputs": {},
          "configured_graph_size": 12
        }
      },
      "errors": []
    }
  },
  "failures": {},
  "project_root": "/home/exedev/a",
  "truncated": false,
  "strings": {},
  "total_configured_graph_sketch": "V1:AAAA"
}`

// fixtureActionFailure is a `buck2 build` report where a genrule action
// failed: the error lives on the configured entry, with the message, stderr,
// and stdout interned in the string table.
const fixtureActionFailure = `{
  "trace_id": "dfa53fce-21cc-43ec-8c08-c91e2736af17",
  "success": false,
  "results": {
    "depot//probe:works": {
      "success": "SUCCESS",
      "outputs": {"DEFAULT": ["buck-out/v2/art/depot/1a608cc1468ec806/probe/__works__/out/ok.txt"]},
      "other_outputs": {},
      "configured_graph_size": 4,
      "configured": {
        "cfg:<empty>#1a608cc1468ec806": {
          "errors": [],
          "success": "SUCCESS",
          "outputs": {"DEFAULT": ["buck-out/v2/art/depot/1a608cc1468ec806/probe/__works__/out/ok.txt"]},
          "other_outputs": {},
          "configured_graph_size": 4
        }
      },
      "errors": []
    },
    "depot//probe:fails": {
      "success": "FAIL",
      "outputs": {},
      "other_outputs": {},
      "configured_graph_size": 4,
      "configured": {
        "cfg:<empty>#1a608cc1468ec806": {
          "errors": [
            {
              "message_content": "11246086378476528028",
              "action_error": {
                "name": {"category": "genrule", "identifier": ""},
                "key": {"owner": "depot//probe:fails (cfg:<empty>#1a608cc1468ec806)"},
                "digest": "c6514af582e6ff6fe3a2064c9d691825848866d4e700eb844e2d0ef944965d59:143",
                "error_content": "7172726661961959965",
                "stderr_content": "1398981844406151271",
                "stdout_content": "15235271120923596269",
                "error_diagnostics": null
              },
              "error_tags": ["ACTION_COMMAND_FAILURE", "ANY_ACTION_EXECUTION"],
              "cause_index": 0,
              "error_category": "USER"
            }
          ],
          "success": "FAIL",
          "outputs": {},
          "other_outputs": {},
          "configured_graph_size": 4
        }
      },
      "errors": []
    }
  },
  "failures": {},
  "project_root": "/home/exedev/a",
  "truncated": false,
  "strings": {
    "11246086378476528028": "Action failed: depot//probe:fails (cfg:<empty>#1a608cc1468ec806) (genrule)\nLocal command returned non-zero exit code 1\nStdout:\nsome diagnostic on stdout\nStderr:\nerror: fake compile failure in probe\n",
    "1398981844406151271": "error: fake compile failure in probe\n",
    "15235271120923596269": "some diagnostic on stdout\n",
    "7172726661961959965": "Local command returned non-zero exit code 1"
  },
  "error_category": "USER"
}`

// fixtureMissingTarget is a `buck2 build` report for a nonexistent target:
// the error sits on the unconfigured entry with no action error attached.
const fixtureMissingTarget = `{
  "trace_id": "46e0e8fc-173e-4722-8665-14eddfd87eda",
  "success": false,
  "results": {
    "depot//buck/tools/quicktd:nonexistent": {
      "success": "FAIL",
      "outputs": {},
      "other_outputs": {},
      "configured_graph_size": null,
      "configured": {},
      "errors": [
        {
          "message_content": "2672398970061002956",
          "action_error": null,
          "error_tags": ["MISSING_TARGET"],
          "cause_index": 0,
          "error_category": "USER"
        }
      ]
    }
  },
  "failures": {},
  "project_root": "/home/exedev/a",
  "truncated": false,
  "strings": {
    "2672398970061002956": "Unknown target ` + "`nonexistent`" + ` from package ` + "`depot//buck/tools/quicktd`" + `.\nDid you mean one of the 1 targets in depot//buck/tools/quicktd:BUILD?\n\nAvailable targets:\n  depot//buck/tools/quicktd:quicktd"
  }
}`

// fixtureTestReport is a `buck2 test` report: entries carry outputs but no
// configured graph sizes.
const fixtureTestReport = `{
  "trace_id": "0a35b21a-8b0f-4260-9ea9-a83672cbeb1c",
  "success": true,
  "results": {
    "depot//src/tools/omnifix:unit": {
      "success": "SUCCESS",
      "outputs": {"DEFAULT": ["buck-out/v2/art/depot/0e3cc681e4081ce8/src/tools/omnifix/__unit__/unit"]},
      "other_outputs": {},
      "configured_graph_size": null,
      "configured": {
        "cfg:<empty>#1a608cc1468ec806": {
          "errors": [],
          "success": "SUCCESS",
          "outputs": {"DEFAULT": ["buck-out/v2/art/depot/0e3cc681e4081ce8/src/tools/omnifix/__unit__/unit"]},
          "other_outputs": {},
          "configured_graph_size": null
        }
      },
      "errors": []
    }
  },
  "failures": {},
  "project_root": "/home/exedev/a",
  "truncated": true,
  "strings": {}
}`

// fixtureSharedCause is handcrafted: one root cause (cause_index 3) taking
// down a library and its dependent in two configurations, one independent
// cause using the historical plain-string error encoding, a fill-out-failures
// entry with no results row, a failed target with no error details at all,
// and a CANCELED outcome.
const fixtureSharedCause = `{
  "trace_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "success": false,
  "results": {
    "depot//lib/broken:broken": {
      "success": "FAIL",
      "outputs": {},
      "other_outputs": {},
      "configured_graph_size": 40,
      "configured": {
        "cfg:linux-x86_64#1111111111111111": {
          "errors": [
            {
              "message_content": "100",
              "action_error": {
                "name": {"category": "rustc", "identifier": "emit-link"},
                "key": {"owner": "depot//lib/broken:broken (cfg:linux-x86_64#1111111111111111)"},
                "digest": "aa:1",
                "error_content": "101",
                "stderr_content": "102",
                "stdout_content": ""
              },
              "error_tags": ["ACTION_COMMAND_FAILURE"],
              "cause_index": 3,
              "error_category": "USER"
            }
          ],
          "success": "FAIL",
          "outputs": {},
          "other_outputs": {},
          "configured_graph_size": 40
        },
        "cfg:linux-arm64#2222222222222222": {
          "errors": [
            {
              "message_content": "100",
              "action_error": null,
              "error_tags": ["ANY_ACTION_EXECUTION"],
              "cause_index": 3,
              "error_category": "USER"
            }
          ],
          "success": "FAIL",
          "outputs": {},
          "other_outputs": {},
          "configured_graph_size": 40
        }
      },
      "errors": []
    },
    "depot//bin/uses-broken:uses-broken": {
      "success": "FAIL",
      "outputs": {},
      "other_outputs": {},
      "configured_graph_size": 90,
      "configured": {
        "cfg:linux-x86_64#1111111111111111": {
          "errors": [
            {
              "message_content": "100",
              "action_error": null,
              "error_tags": ["ANY_ACTION_EXECUTION"],
              "cause_index": 3,
              "error_category": "USER"
            }
          ],
          "success": "FAIL",
          "outputs": {},
          "other_outputs": {},
          "configured_graph_size": 90
        }
      },
      "errors": []
    },
    "depot//tools/flaky:flaky": {
      "success": "FAIL",
      "outputs": {},
      "other_outputs": {},
      "configured_graph_size": 8,
      "configured": {},
      "errors": ["download of https://example.com/dep.tar.gz failed: timeout"]
    },
    "depot//tools/silent:silent": {
      "success": "FAIL",
      "outputs": {},
      "other_outputs": {},
      "configured_graph_size": null,
      "configured": {},
      "errors": []
    },
    "depot//tools/gone:gone": {
      "success": "CANCELED",
      "outputs": {},
      "other_outputs": {},
      "configured_graph_size": null,
      "configured": {},
      "errors": []
    },
    "depot//tools/fine:fine": {
      "success": "SUCCESS",
      "outputs": {"DEFAULT": ["buck-out/v2/art/depot/1111/tools/fine/__fine__/fine"]},
      "other_outputs": {},
      "configured_graph_size": 11,
      "configured": {
        "cfg:linux-x86_64#1111111111111111": {
          "errors": [],
          "success": "SUCCESS",
          "outputs": {"DEFAULT": ["buck-out/v2/art/depot/1111/tools/fine/__fine__/fine"]},
          "other_outputs": {},
          "configured_graph_size": 11
        }
      },
      "errors": []
    }
  },
  "failures": {
    "depot//tools/unanalyzable:unanalyzable": "Unknown target ` + "`unanalyzable`" + ` from package ` + "`depot//tools`" + `."
  },
  "project_root": "/home/exedev/a",
  "truncated": false,
  "strings": {
    "100": "Action failed: depot//lib/broken:broken (cfg:linux-x86_64#1111111111111111) (rustc emit-link)\nLocal command returned non-zero exit code 1",
    "101": "Local command returned non-zero exit code 1",
    "102": "error[E0308]: mismatched types\n --> lib/broken/src/lib.rs:4:5\nerror: aborting due to 1 previous error\n"
  }
}`
