<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# celld web kit

Worker SSR and browser hydration use one compiled component source. Buck
selects server/client output; the browser entry imports no server runtime.

## Full-stack examples

### Switchboard: live channel chat

[`examples/chat/`](examples/chat/) is an IRC-style browser chat backed by real
SQLite Durable Objects and `@celld/web/realtime`, not seeded messages or users.

```sh
buck2 run root//src/celld/web/kit/examples/chat:switchboard-dev
buck2 test root//src/celld/web/kit/examples/chat/...
```

Open `http://127.0.0.1:9876/`. To retain its prepared project and SQLite storage,
use `-- --port 9877 --state /tmp/switchboard`; use a fresh state directory after
rebuilding when you want changed code.

- Public channels have persistent names, topics and the latest 200 messages.
  The catalog is capped at 32 channels; messages are trimmed and limited to
  2000 UTF-16 code units. Duplicate creation never replaces a topic.
- Guest nicknames use encrypted, Secure, HttpOnly session cookies. Typed HTTP
  mutations require CSRF tokens; sockets require the authenticated guest and a
  matching Origin. Only literal loopback development addresses permit plain
  HTTP credentials. Use `127.0.0.1`, not `localhost`.
- The Svelte UI has live presence, five-second typing expiry, per-channel
  drafts, background unread counts, loaded-history search and responsive rails.
  Enter sends, Shift-Enter adds a line, and IME composition does not send.
  Reading older messages preserves scroll position and exposes a jump-to-tail
  control rather than moving the reader.
- Ordinary links and enter/create/send/leave forms also work without
  JavaScript, including phone layouts. Those pages show a server snapshot;
  search, typing, live updates and keyboard shortcuts require hydration.
- HTTP snapshots and socket replay share ordered sequence numbers. Promoting
  an unvisited background room resumes from its HTTP cursor, recovering gaps
  even when a later live frame arrived first. Navigation waits for
  cookie-changing actions and rejects stale reads after logout.
- A disconnected send retains its draft. An uncertain acknowledgement warns
  the user to check the transcript before retrying; publishing is not promised
  to be exactly once.

`Page.svelte` composes the rails, header, transcript, composer and dialogs.
`model.ts` owns their concrete `ChatModel` contract; `chat.svelte.ts` owns
per-page rune state, room clients, replay and navigation. The session and
channel forms are reused by ordinary server-rendered sections and enhanced
native modals; modal behavior comes from the existing interaction actions.
`contract.ts` is the shared Sieve HTTP/message contract. `rooms.ts` owns the
SQLite catalog and validated realtime rooms; `server.ts` and `worker.ts` own
guest authentication, CSRF, SSR and asset serving.

The HTTP spec and ten real-runtime scenarios cover authorization, CSRF,
identity spoofing, grouped presence, ordered messages, native redirects,
escaping, channel isolation, restart/replay, both payload/catalog bounds and
HTTPS tunnel-origin authentication.

**Public guest demonstration, not private chat:** nicknames are not verified
accounts, all history is public, and there is no moderation system. Do not
enter sensitive information. The public `SESSION_SECRET` in the test spec is
development-only; deployment must supply its own secret of at least 32 UTF-8
bytes. The packaged Worker has no fallback secret.

#### HTTPS quick tunnels

Cloudflared terminates HTTPS and forwards plain HTTP to celld. Switchboard
must know the external origin; it does not trust arbitrary forwarded headers.

1. Keep `cloudflared tunnel --url http://127.0.0.1:9876` running and copy its
   generated `https://…trycloudflare.com` origin.
2. Restart Switchboard with that exact origin and a fresh session secret:

   ```sh
   SECRET="$(openssl rand -hex 32)"
   buck2 run root//src/celld/web/kit/examples/chat:switchboard-dev -- \
     --var PUBLIC_ORIGIN=https://your-generated-host.trycloudflare.com \
     --var SESSION_SECRET="$SECRET"
   ```

3. Open the HTTPS tunnel URL and choose a nickname again.

Keep the tunnel running while restarting Switchboard so its hostname stays
the same. A new tunnel hostname requires updating `PUBLIC_ORIGIN` and
restarting the runner. If using `--state`, choose a fresh directory after a
code rebuild: retained projects contain their previous build.

`PUBLIC_ORIGIN` accepts only an HTTPS origin, with no path or query. It governs
session transport security, CSRF, redirects and WebSocket Origin checks
together. Requests with a different Origin remain forbidden, including
interactive forms opened directly on the local HTTP URL while configured
for the tunnel. Omitting it preserves loopback-only HTTP development.
Do not expose the public test-fixture session secret through a tunnel.


### Fieldnotes: shared notebook

[`examples/`](examples/) contains **Fieldnotes**, a real shared notebook backed
by a SQLite Durable Object, not seeded browser data.

```sh
buck2 run root//src/celld/web/kit/examples:fieldnotes-dev
buck2 test root//src/celld/web/kit/examples/...
```

Both runners default to `http://127.0.0.1:9876/`. The dev runner prepares a private project and
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

## Shared presentation styles

Both examples use [`../ui/styles.css`](../ui/styles.css), exported as
`root//src/celld/web/ui:ui.css`. Declare it in `tailwind.css(css_srcs = [...])`
and import `@import "./ui.css";` after the Tailwind import. That is the declared
artifact's staged name, not a filesystem path out of the consumer package.

Applications supply the six `@theme` color tokens `canvas`, `surface`, `ink`,
`muted`, `accent` and `error`, plus their font tokens and document/layout rules.
The shared component layer uses those tokens rather than a fixed palette:

- `ui-button` with `ui-button-primary` / `ui-button-quiet`; `ui-input`,
  `ui-label`, `ui-hint`, `ui-error` and `ui-fieldset`.
- `ui-notice[data-tone]`, `ui-panel`, `ui-heading`, `ui-link` and `ui-body`.
- `ui-nav-link`, `ui-tab`, menu, dialog, disclosure, tooltip, prose and
  keyboard-list styles, including their ARIA-driven active states.

Disabled fieldsets dim once, not once per nested control. Markup keeps short
semantic class names; app-specific geometry stays in its stylesheet or a few
local layout utilities. These classes do not replace the existing
`@celld/web/interactions` keyboard, focus and ownership contracts.



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

