<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# celld web kit

Worker SSR and browser hydration use one compiled component source. Buck
selects server/client output; the browser entry imports no server runtime.

## Full-stack example

[`examples/`](examples/) contains **Fieldnotes**, a real shared notebook backed
by a SQLite Durable Object, not seeded browser data.

```sh
buck2 run root//src/celld/web/kit/examples:fieldnotes-dev
buck2 test root//src/celld/web/kit/examples/...
```

Open `http://127.0.0.1:9876/`. The dev runner prepares a private project and
temporary storage; Ctrl-C stops it. Add `-- --port 9877 --state /tmp/fieldnotes`
to keep the prepared project and its SQLite storage across runs. A retained
state directory also retains that project’s built code: choose a fresh directory
after rebuilding source when you want the new build.

The example connects the complete pipeline:

- `contract.ts`: shared Sieve schemas and `GET /`, `GET /guide`, `POST /notes`
  descriptors; HTML and JSON responses use the same page contract.
- `notebook.ts`, `server.ts`, `worker.ts`: persistent SQLite reads and atomic
  inserts, bounded form bodies, real Worker SSR, and local asset serving.
- `Page.svelte`, `draft.svelte.ts`: a small page coordinator and an explicit
  shared `Draft` contract with per-page rune state.
- `components/`: focused header, keyboard-help dialog, editor, notebook/preview
  and guide components, compiled from the same sources for server and browser.
- `styles.css`: CSS-first Tailwind theme and base focus/visibility rules; the
  pinned compiler scans the declared page/component sources directly.
- `browser.ts`: hydration, `createClient<App>()` with a **type-only** server
  contract import, typed navigation/history, and enhanced form validation,
  pending/error/success handling. Form listeners are replaced when navigation
  unmounts and remounts the composer.
- Headless `use:` actions: keyboard-help modal, notebook/draft tabs, optional
  details disclosure, display-order menu and storage tooltip.
- `BUILD`: checked first-party libraries, minified Worker and browser bundles,
  CSS, authored-source maps, packaged assets and the standard example harness.

| Component | Owns |
| --- | --- |
| `Page.svelte` | Page data, navigation/action state, shared draft and controlled tab/order state |
| `components/Header.svelte` | Navigation and the keyboard-help trigger |
| `components/KeyboardHelp.svelte` | Native modal and its local open state |
| `components/NoteEditor.svelte` | Form, derived field/action feedback, disclosure and storage tooltip |
| `components/Notebook.svelte` | Tabs, order menu, saved notes and the shared live draft preview |
| `components/Guide.svelte` | Guide content |


Typing updates a local draft and preview. Saving validates on the server,
persists a note and returns the updated page. Failed saves retain the draft;
ordinary links and the HTML form still work with JavaScript disabled. The HTTP
spec covers rejection without mutation, the body cap and persistence through a
runtime restart.

**Local-only anonymous demonstration:** every visitor sees the same notebook.
It has no private accounts or access control; do not enter sensitive information
or deploy it publicly as a private note service.


## Server pages

Import server-only APIs from `@celld/web/kit/server`. This entry point imports
`svelte/server`; never re-export it from a browser-facing module. A browser
entry imports its separately client-compiled component and `hydratePage` from
the browser kit entry. Bare Svelte imports are provided by the Buck toolchain,
not an npm installation.

```ts
import Page from "@example/page";
import { renderPage } from "@celld/web/kit/server";

return renderPage(Page, { message: "Hello", count: 1 }, {
  title: "Welcome",
  scripts: ["/assets/page.js"],
  styles: ["/assets/page.css"],
});
```

`renderPage(Component, props, options?)` returns a `Response` whose component
props are checked against Svelte's `Component<Props>` type. It calls the real
Svelte server renderer and preserves the exact rendered body, including all
hydration boundary comments, inside `<div id="celld-page">`. The browser must
hydrate that target with the corresponding client-compiled component.

The complete rendered head is preserved. `title` is escaped document text;
`lang` and asset URLs are escaped attribute values. `head` is **trusted authored
HTML**, like the compiler's rendered head: never pass request values to it.
Supply the title either through `title` or `<svelte:head>`/`head`, not both;
ambiguous titles throw. `scripts` are explicit external module script URLs and
`styles` are explicit stylesheet URLs. Relative, HTTP and HTTPS URLs are
accepted; executable/data schemes are refused. There is no inline executable
bootstrap and no inferred asset manifest.

A second element, `<script id="celld-boot" type="application/json">`, contains
`{ "version": 1, "props": ... }`. It is data, not executable JavaScript. The
serialization escapes `<`, `>`, `&`, U+2028 and U+2029 as JSON escapes, so a prop
containing `</script>` cannot end that element. `targetId` and `bootId` may change
the two defaults; use the same IDs in the browser. They must be distinct,
nonempty IDs without whitespace.

Props must be a plain JSON object. Core's immutable `jsonSnapshot` supplies the
single snapshot consumed by SSR and hydration and rejects unsupported values:
undefined, functions/snippets, symbols, bigint, nonfinite numbers, cycles,
nonplain objects (including dates/maps/sets), accessors, hidden/symbol/prototype
keys and sparse/decorated arrays. Negative zero is refused because JSON changes
its identity. Getters and `toJSON` hooks are not executed. Shared references are
allowed if they do not form cycles. Snapshot defaults bound data to 32 levels,
4096 members/values and 64 KiB encoded JSON; `snapshotLimits` forwards core's
`maxDepth`, `maxItems` and `maxBytes` overrides. Components must not mutate this
frozen data. Client callbacks and snippets belong in the browser entry, not the
hydration payload.

`PageOptions` also accepts `ResponseInit` status, status text and headers. HTML
uses `text/html; charset=utf-8`; a conflicting supplied content type is replaced.
Supplied content length is removed because it would describe a different
representation. Statuses 204, 205 and 304 return a null body without rendering
or serializing props. When handling HEAD without a router, the caller must strip
the body itself: `renderPage` has no request to inspect.

### One page and API contract

Define the GET route once in a browser-safe module using
`defineRoute` from `@celld/web/router/client`. Its `response` Sieve schema
describes the page props, and its `params`/`query` schemas describe the request.
Use that same definition in the server router and typed browser client.

```typescript
import Page from '@app/views';
import { router } from '@celld/web/router';
import { respondPage } from '@celld/web/kit/server';
import { pageRoute } from './shared.ts';

const app = router({ auth: 'none' }).register(pageRoute, async (context) => {
  const props = await loadPage(context.params);
  return respondPage(context, pageRoute, Page, props, {
    scripts: ['/app.js'],
    styles: ['/app.css'],
  });
});
```

`respondPage` runs inside the existing handler, after normal router
authentication, authorization, request validation, CSRF and middleware.
`auth: 'none'` above is an explicit public example, not an adapter default.
The adapter does not register another route or invoke the loader.

The synchronous response schema parses the loader's input once. Only its
stripped/transformed object output reaches SSR, boot data or JSON; invalid
props become the router's opaque 500. An explicit `responses[status]` schema,
or a default entry when no explicit entry exists, takes precedence over
`response`. Literal status-specific schemas also control the input and
component prop types. Bodyless statuses do not parse unused props.

Negotiation uses the router's `Context.accepts`: document requests receive
HTML; the typed client's default `Accept: application/json` receives the
props object, not the boot envelope. Equal-quality wildcards and absent
Accept prefer HTML. Refused media types produce 406. Responses merge
`Vary: Accept` into supplied headers; later middleware must preserve it.
HEAD validates props and retains negotiated headers without a body.


## Browser hydration and assets

Compile the same public component import for both entry points:

```typescript
import Page from '@app/views';
import { hydratePage } from '@celld/web/kit/browser';
import { unmount } from 'svelte';

const page = hydratePage(Page);
// await unmount(page) when this page is discarded.
```

`hydratePage` reads the versioned boot element and hydrates the existing
`#celld-page` markup with Svelte. It does not replace SSR with a second render.
Options accept an explicit `target`, matching `bootId`, an already-decoded
`boot` envelope, or `parseProps` for application validation. Importing the
module on a Worker does not access browser globals.

```python
celld.browser(
    name = "browser",
    main = "src/browser.ts",
    deps = [":views", "root//src/celld/web/kit:kit"],
)
celld.project(
    name = "project",
    src = ":worker",
    assets = ":browser",
    assets_binding = "ASSETS",
    assets_run_worker_first = True,
)
```

The browser target produces `app.js`, `app.js.map`, `app.css` and
`app.css.map`. Pass `/app.js` and `/app.css` to `renderPage`'s `scripts` and
`styles`; forward asset requests to the project's `ASSETS` binding. The Worker
and browser entries import the same component path, while Buck2 selects the
server and client compilation respectively. Only reachable client components
contribute component CSS; `styles = [...]` supplies compiled global CSS before
it. JavaScript and native component CSS maps retain authored Svelte source
content. Generated Tailwind CSS is explicitly unmapped. See the
[Tailwind build contract](../../../../buck/toolchains/celld/README.md#tailwind-and-global-styles)
for the direct compiler rule and declared candidate inputs.

The real local hydration fixture is
`toolchains//celld/tests/svelte:hydration-project`.

## Navigation and actions

`@celld/web/kit/navigation` exports `definePage`, `createPageMatcher`,
`createPageLoader`, `createNavigation` and their typed state/context contracts.
`definePage(sharedGETRoute, load)` attaches a loader to the descriptor registered
on the server; it does not duplicate method/path strings. The loader receives
`{url, params, query, signal}` and returns a typed client result or
`{ok: true, data}`. Raw URL values must be mapped explicitly to the client's
Sieve input types. Repeated query fields remain ordered arrays.

`createNavigation({pages, onState, commit, root?, window?, focus?})` installs
link/popstate handling. `commit(data, context)` updates the hydrated page and
may await Svelte `tick()`. Check `context.signal.aborted` immediately before
any asynchronous DOM mutation: the kit can suppress stale results and history
changes, but cannot undo an application callback that ignores its signal.
The router's existing matcher supplies static/parameter/wildcard precedence
and single decoding.

The controller exposes `navigate(url, {history?})`, `refresh()`, `state`,
`update(options)` and `destroy()`. History mode is `push` by default, or
`replace`/`none`; refreshing adds no entry. Back/forward loads the
browser-selected URL without another push. Failed loads retain the rendered
page and report an error. Server routes still own direct loads and reloads.
Hash navigation remains native; crossing to another page's fragment reloads
the real document.

Only ordinary unmodified same-origin primary link activation is enhanced.
External URLs, downloads, explicit targets/base targets, `rel="external"`,
hash links, unknown routes and previously prevented clicks remain native.
Keyboard link activation works normally. Successful navigation focuses
`[data-page-focus]`, then `h1`, then `main`, and scrolls to the top.
A necessary temporary tabindex remains until blur, update or destroy:
removing it immediately loses focus in Chromium. `focus: false` disables
focus/scroll changes; a callback may own them instead.

`@celld/web/kit/actions` exports `createAction`, `enhanceForm` and their
typed state/context contracts. `enhanceForm(form, {route, submit, onState,
focus?})` retains real method/action attributes and native constraint
validation. `submit(context, signal)` explicitly maps successful FormData
controls to `client.call(...)`. Context includes URL, method, params, query,
submitter and FormData, preserving repeated controls and the clicked button.
GET replaces the action query; POST retains it.

Only matching same-origin GET or urlencoded POST forms are enhanced.
POST descriptors must declare `bodyType: 'form'`. Targets, submitter
overrides, image-button coordinates, uploads, multipart/text/plain,
non-GET/POST methods, external/fragment actions and modified activation
retain native submission. The controller's `submit(submitter?)` calls
`requestSubmit`, not `form.submit`, so Enter and validation remain intact.

Both controllers publish `idle`, `pending`, `success(data)` and
`error(ClientFailure)`. New work aborts the previous request; stale completion
cannot overwrite current state, even if a loader ignores cancellation.
Update aborts and replaces options/listeners; destroy releases resources.
They do not add retries, caching or a second error protocol. DOM-independent
`createAction` and `createPageLoader` expose the same state machines.

Forms focus the first eligible named validation control, otherwise
`[data-action-error]`/`[data-action-success]`. Render application-owned status
and field errors from the actual typed failure. Use Svelte `flushSync` in
`onState` if those regions are created reactively before focus, or supply
a custom focus callback. Naturally focusable controls retain their tabindex.

## Accessible interaction primitives

Use [`@celld/web/interactions`](../interactions/README.md) for first-party
Svelte-compatible DOM actions: native modal dialog, tabs, disclosure, command
menu and tooltip. They own keyboard/ARIA/focus behavior and release listeners,
observers, timers and owned attributes on destroy. Supply stable IDs, accessible
names and application styles; modules are safe to import during SSR.
The hydration fixture binds every primitive through actual `use:` directives.

