<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Anthropic project-artifact ab024cdc (Apache-2.0) informed the dashboard/state workflow. Modified: new local typed evidence specification and explicit reconciliation contract. -->
# JSON specification and refresh contract

Call the native `project_artifact` tool with `{mode:"create"|"refresh", spec_file,
output, previous?, overwrite?}`. Paths are workspace-relative (absolute paths must
still be inside the workspace), bounded regular files, no symlink components.
`overwrite` defaults false. `previous` is refresh-only and defaults to output;
missing/invalid state fails without changing the output. Output cannot replace the
spec file. The renderer does not fetch, run commands, install dependencies, or
publish. JSON parsing/rendering and HTML output are bounded to 8 MiB; arrays to
2000 items and text fields to 100000 characters. Cancelled work does not publish
if cancellation is observed before the atomic write starts.
The 2000-item bound applies after refresh retention too; remove obsolete records
explicitly before adding a record to a full collection. Failed reconciliation
does not publish or replace the prior artifact. Text inputs require valid UTF-8.

## Required top-level fields

| Field | Contract |
|---|---|
| `project_id` | Stable ID, never changed on refresh |
| `as_of` | ISO UTC timestamp ending `Z`; at least previous as-of on refresh |
| `title`, `summary`, `phase`, `goal` | Nonempty plain text; phase can state actual gate/health |
| `criteria` | Nonempty array `{id,statement,check,status,group?}`; falsifiable checks |
| `workstreams` | Array of rows below; rendered state must contain at least one |
| `evidence` | Array below; rendered state must contain at least one |
| `next_steps` | Array `{who,action,unblocks}`; if empty supply nonempty `no_action_reason` |

Optional fields: `out_of_scope: string[]`, `sections: Section[]`,
`customizations`, `remove`. Unknown fields are ignored, not rendered or persisted.
No field accepts raw HTML. Empty optional text should be omitted, not supplied as
an empty string. IDs use 1–80 ASCII letters/digits/dot/underscore/hyphen, start
with a letter/digit, and are unique within each collection.

### Evidence

`{id,label,detail,freshness,observed_at?,url?,reason?}`.
`freshness` is `live`, `stale`, or `unknown`. Live evidence requires actual
`observed_at` (ISO UTC); it cannot exceed `as_of`. Stale/unknown evidence requires
an explicit nonempty `reason`. A prior observation timestamp can remain on stale
evidence to show when it was last checked. `detail` states the actual observed
result/basis, not just a pointer. Optional URL accepts only HTTP(S) with no embedded
credentials; following a source link is an explicit reader action, not fetching.
Evidence may be a local checked file, a tool observation, or a retrieved source.

### Workstreams

`{id,title,owner,status,evidence:string[],freshness,observed_at?,reason?,
depends_on?:string[],detail?,verification?}`. Unknown owner is explicit text
(e.g. “Not recorded”), not an invented person. Status is plain text; common values
are `done`, `in progress`, `next`, `blocked`, `caveat`. Live requires observed_at,
at least one evidence ID, and only live evidence. Stale/unknown requires reason.
Dependencies reference existing different workstream IDs. Missing referenced
evidence/dependencies is an error, including after an explicit removal.

For PR rows additionally supply **all** `{repo,number,workstream,draft,ci,unresolved,
state}`. `number` is a positive safe integer; `unresolved` a nonnegative safe integer;
`draft` boolean; other PR fields nonempty text. These exact keys survive round-trip
and field-specific delta reporting. `workstream` is the X.Y sequence label; `id`
is the stable row key (prefer repo+PR identity, distinct across repositories).
Use `verification`/`detail` to record observed checks, what landed, confirmed fixes,
commits, and meaningful file changes. Never fabricate a SHA or test result.

### Optional sections

`{id,title,paragraphs:string[],evidence:string[],freshness,reason?}`. Paragraphs must
be nonempty. Live sections require at least one live evidence reference; evidence
observation timestamps establish their freshness. Non-live sections need reason.
Reserved IDs: `over`, `work`, `evidence`, `artifact-state`, and prefixes `tab-`,
`heading-`, `e-`. Catalog IDs (`att`,`bg`,`plan`,`risk`,`faq`) stay stable. Optional
SWE sections can use `architecture`, `findings`, `rollout` when substantive.

### Customizations

`{title?,accent?,tab_labels?:{[tabId]:text},tab_order?:string[],notes?:{[tabId]:text}}`.
Title is a user display override. Accent must be `#RRGGBB`; check contrast visually
when changing it. Tab-order entries prioritize existing IDs; other tabs retain
catalog order. Unknown IDs are inert so a temporarily absent tab can later return.
Labels and notes merge by key on refresh; absent values survive. Title/accent/order
replace only when supplied. To remove a customization, edit the prior state or
provide a replacement value; null/empty text is not a deletion marker. Browser
selection is stored separately by project ID in localStorage when available;
without storage, the first tab/hash works normally. No browser-local preference
is represented as newly fetched project evidence.

## Refresh semantics

The HTML has exactly one canonical `<script type="application/json"
id="artifact-state">` containing a validated version-1 snapshot of all facts and
customizations. Parse with `parseArtifactHTML`, never execute extracted scripts.
It rejects missing/duplicate state blocks, unsupported versions, and invalid data.

- Top-level title/summary/phase/goal/criteria/next steps are a **current complete**
  description; out-of-scope defaults empty. These are not partial patches.
- Rows/evidence/optional sections reconcile by ID. Supplied live/unknown replaces
  prior facts. Supplied stale keeps prior facts when present, changing freshness
  and reason only; without prior facts it uses the explicitly supplied stale data.
- Unsupplied prior entries remain stale with “Not supplied in this refresh…” reason.
  They do not become deleted or newly verified. Optional sections follow this rule.
- `remove:{workstreams?:string[],evidence?:string[],sections?:string[]}` explicitly
  deletes verified removals. Supply-and-remove of one ID fails. Remove associated
  references or dependent rows too; dangling references fail.
- Delta reports added/removed IDs and changed field names for workstreams,
  evidence, sections, criteria, and changed project/customization fields. Only
  advancing `as_of` or `observed_at` is not substantive change. New stale/unknown
  transitions, reasons, PR CI/thread counts, owner, title, status, and source detail
  **are** reported. First creation has `first_render:true` and no invented delta.

## Filled deterministic example

This is explicitly illustrative evidence for exercising the UI, not a live claim
about a user's project. Replace it with actual gathered evidence for production.

```json
{
  "project_id": "local-release",
  "as_of": "2026-10-01T12:00:00Z",
  "title": "Local release readiness",
  "summary": "Package validation is complete; rollout awaits an owner decision.",
  "phase": "Ready for rollout decision",
  "goal": "Ship the validated package without changing the recovery procedure.",
  "criteria": [{"id":"recover","statement":"Recovery remains available","check":"Run recovery and observe the previous version restored","status":"done"}],
  "workstreams": [{"id":"1.0","title":"Package validation","owner":"Release team","status":"done","freshness":"live","observed_at":"2026-10-01T11:55:00Z","evidence":["validation"],"verification":"Illustrative smoke: recovery restored the prior version."}],
  "evidence": [{"id":"validation","label":"Illustrative recovery observation","detail":"A deterministic example: recovery restored the prior version.","freshness":"live","observed_at":"2026-10-01T11:55:00Z"}],
  "next_steps": [{"who":"Release owner","action":"Choose the rollout window","unblocks":"Start the validated rollout"}],
  "customizations": {"tab_labels":{"work":"Release sequence"},"notes":{"over":"Example fixture only; replace with live facts before sharing."}}
}
```

## Visual smoke scenarios

Generate this example with `buildArtifact` or the tool and serve the HTML locally.
At 1280px and 390px, verify complete headings/text, local table scrolling, next
steps above tabs, keyboard Arrow/Home/End, evidence link target, no external
requests, dark mode, and no-JS full content. Choose Workstreams, refresh at the same
path, reload, and observe its browser-local selection remains when storage works.
Refresh with later timestamps only: no substantive delta. Refresh with omitted
workstreams and evidence: old facts remain visibly stale; custom labels/notes
persist. Change `status`, add a workstream/evidence, or explicitly remove a row:
verify exact delta. Put `</script><img src=x onerror=alert(1)>` in title/detail/notes:
it displays as text, state round-trips, and no code executes. Unsafe URL, empty
criteria, wrong project ID, backwards as-of, duplicate state, dangling evidence,
escaping path, existing output without overwrite: all must fail without publishing.
