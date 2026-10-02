<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

<div class="mb-6 max-w-2xl sm:mb-8">
  <h1 class="text-[28px] leading-8 font-bold tracking-tight sm:text-[32px] sm:leading-10" data-page-focus>How Fieldnotes works</h1>
  <p class="mt-2 text-muted">One notebook, one typed contract, and the same components on the server and in your browser.</p>
</div>
<article id="fieldnotes-guide" class="max-w-[75ch] divide-y divide-slate-200 [&_section]:py-6 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:leading-7 [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:mb-2 [&_h3]:font-semibold [&_p]:mb-3 [&_p]:text-slate-600 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:text-sm [&_code]:text-ink [&_code]:[overflow-wrap:anywhere]">
  <section aria-labelledby="guide-pipeline">
    <h2 id="guide-pipeline">From source to page</h2>
    <ol class="list-decimal space-y-6 pl-6 marker:font-medium marker:text-accent [&_li]:pl-2">
      <li>
        <h3>Compile natively</h3>
        <p>Buck compiles the page components and rune-based draft module through the native Rust Svelte compiler and Oxc. Server and browser builds come from the same authored sources; no npm compiler or UI bridge sits between them.</p>
      </li>
      <li>
        <h3>Check and bundle</h3>
        <p>Deno checks TypeScript against the package’s declared imports and bundles the browser entry. The native toolchain also owns linting, formatting, minification and the import graph. The pinned Tailwind compiler scans these components and builds the CSS served as a local asset.</p>
      </li>
      <li>
        <h3>Render, then hydrate</h3>
        <p>The Worker renders the notebook with real saved notes and includes a JSON boot payload. The browser hydrates that existing HTML rather than replacing it with a second page. The draft factory creates local reactive state for this mounted page.</p>
      </li>
    </ol>
  </section>
  <section aria-labelledby="guide-contract">
    <h2 id="guide-contract">The contract is shared</h2>
    <p>The server and typed browser client use the same route definitions and Sieve schemas. <code>GET /</code> returns the notebook, <code>GET /guide</code> returns this guide, and <code>POST /notes</code> validates and saves a note. The page data contains only the current view and saved notes.</p>
    <p>A saved title is trimmed and must contain 3–80 characters. Optional details can contain up to 400 characters. Server validation errors appear beside the corresponding field; a failed save keeps your draft so you can correct it and try again.</p>
  </section>
  <section aria-labelledby="guide-storage">
    <h2 id="guide-storage">Drafts are local. Notes persist.</h2>
    <p>Typing changes only your local draft and its live preview. Saving sends the form to the Worker, which writes to the <code>notes</code> SQLite table in the <code>Notebook</code> Durable Object. The <code>NOTEBOOK</code> binding opens the named <code>fieldnotes</code> instance, so page loads read the same persistent notebook.</p>
    <p>This is a shared example notebook, with no private accounts. Everyone using it sees the same saved notes. Do not enter secrets or personal information. Unsaved drafts are not stored and will be lost if you reload or close the page.</p>
    <p>During local development, celld keeps this server-side data under the project’s <code>.celld/dev</code> directory. Restarting with the same storage keeps saved notes; deleting that storage clears them. No browser localStorage is used.</p>
  </section>
  <section aria-labelledby="guide-browser">
    <h2 id="guide-browser">Useful even before hydration</h2>
    <p>The notebook and guide are ordinary links, and saving is a real HTML form. With JavaScript, navigation loads typed page data and forms show pending, validation, error and success states in place. New requests supersede older ones, so a late reply cannot replace the current page.</p>
    <p>The five headless interaction actions provide the native keyboard-help dialog, notebook tabs, optional-details disclosure, display-order command menu and storage tooltip. They supply keyboard and focus behavior; these components supply the content and appearance.</p>
    <a class="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4 hover:text-blue-700" href="/">Return to your notebook</a>
  </section>
</article>
