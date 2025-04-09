// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// ---------------------------------------------------------------------------------------------------------------------
// MARK: Types + Parameters

type IndexRecord = {
  size: number;
  chunks: number;
  prefix: string[];
  ttldate: number;
};

// Default key TTL is 1 day.
const DEFAULT_KEY_TTL_MS = (1000 * 60) * 60 * 24;

// The kv queue is used to notify the server that a new log has been uploaded
// via watch events.
const LATEST_LOG_KEY = "logs/latest";

// ---------------------------------------------------------------------------------------------------------------------

// If the user specifies DENO_KV_URL, then they also need DENO_KV_ACCESS_TOKEN.
// This is in the case they want to use a locally hosted denokv service, OR they
// want to plug their local deno instances into Deno Deploy KV.
//
// Otherwise, just call raw Deno.openKv()

let kv = null;
if (Deno.env.get("DENO_KV_URL") !== undefined) {
  if (Deno.env.get("DENO_KV_ACCESS_TOKEN") === undefined) {
    console.error("DENO_KV_URL is set, but DENO_KV_ACCESS_TOKEN is not.");
    Deno.exit(1);
  }

  const url = Deno.env.get("DENO_KV_URL");
  kv = await Deno.openKv(Deno.env.get("DENO_KV_URL"));
  console.log(`Deno KV: remote=${url}`);
} else {
  const isDenoDeploy = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;
  kv = await Deno.openKv();
  console.log("Deno KV:", isDenoDeploy ? "cloud" : "local");
}

kv.listenQueue(async (msg: IndexRecord) => {
  await kv.set([LATEST_LOG_KEY], msg, { expireIn: DEFAULT_KEY_TTL_MS });
});

// ---------------------------------------------------------------------------------------------------------------------
// MARK: HTTP Server Interface

const cache = await caches.open("buck2-logs");

console.log("Server started", import.meta.url);
export default {
  async fetch(request: Request): Promise<Response> {
    // MARK: URL routing
    const url = new URL(request.url);
    const key = url.pathname.slice(1);

    if (key === "" || key === null) {
      const status = 200;
      const body = "<!doctype html>" + app(request);
      return new Response(
        body,
        {
          status,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        },
      );
    }

    // MARK: Log upload
    if (key.startsWith("v1/logs/upload")) {
      if (request.method !== "PUT") {
        return new Response("Method not allowed", { status: 405 });
      }

      if (request.body === null) {
        return new Response("Invalid request", { status: 400 });
      }

      const uuid = request.headers.get("x-uuid");
      const logType = request.headers.get("x-type");
      const logFormat = request.headers.get("x-format");
      const ts = request.headers.get("x-timestamp");
      if (
        uuid === null || ts === null || logType === null || logFormat === null
      ) {
        return new Response("Missing parameter", { status: 400 });
      }

      if (logFormat !== "pb-zst") {
        return new Response("Invalid log format", { status: 400 });
      }

      const tss = ts.split("-");
      if (tss.length != 2) {
        return new Response("Invalid timestamp", { status: 400 });
      }

      const [tsDate, tsDateTs] = [tss[0], tss[1]];

      // given the above components, we have the following kv layout
      //
      // logs/$uuid                           -> [size, chunks, idx1/$date/$dateTs/$logType/$uuid]
      // idx1/$date/$dateTs/$logType/$uuid/1  -> binary log data
      // idx1/$date/$dateTs/$logType/$uuid/2  -> binary log data
      // idx1/$date/$dateTs/$logType/$uuid/3  -> binary log data
      // ...
      //

      const kkid = ["logs", uuid];
      const kkprefix = ["logs", "idx1", tsDate, tsDateTs, logType, uuid];
      const stream = request.body;

      // now, read the stream in chunks and write them to the db
      let idx = 1;
      let size = 0;

      console.log("Uploading log", uuid, "with format", logFormat);
      for await (const chunk of stream) {
        const expireIn = DEFAULT_KEY_TTL_MS * 2; // XXX FIXME (aseipp): explain
        const res = await kv.set([...kkprefix, idx.toString()], chunk, {
          expireIn,
        });
        if (!res.ok) {
          return new Response("Internal error: failed to write log", {
            status: 500,
          });
        }
        idx++;
        size += chunk.length;
      }

      console.log(
        "Uploaded log",
        uuid,
        "of size",
        size,
        "with",
        idx - 1,
        "chunks",
      );

      // finally, write the log entry since we're done, and enqueue it
      const ttldate = Date.now() + DEFAULT_KEY_TTL_MS;
      const val: IndexRecord = {
        size,
        ttldate,
        chunks: idx - 1,
        prefix: kkprefix,
      };
      const res = await kv.atomic()
        .check({ key: kkid, versionstamp: null })
        .set(kkid, val, { expireIn: DEFAULT_KEY_TTL_MS })
        .commit();
      if (res.ok) {
        kv.enqueue(val);
        return new Response("OK", { status: 200 });
      } else {
        return new Response("Already exists", { status: 404 });
      }
    } else if (key.startsWith("v1/logs/get")) {
      // MARK: Log retrieval
      const ks = key.split("/").slice(3);
      if (ks.length != 1) {
        return new Response("Invalid Request", { status: 400 });
      }

      const cached = await cache.match(request);
      if (cached !== undefined) {
        console.log("Cache hit", ks, request);
        return cached;
      }

      const kk = ["logs", ks[0]];
      const obj = await kv.get(kk);
      if (obj.value === null && obj.versionstamp === null) {
        return new Response("Not found", { status: 404 });
      }

      const rec = obj.value as IndexRecord;
      const prefixstr = rec.prefix.join("/");
      console.log(prefixstr, "Log retrieval requested", rec);

      // the ttl is only the earliest expiry, so if the value is returned but
      // should have been expired, don't return it
      if (rec.ttldate < Date.now()) {
        return new Response("Not found", { status: 404 });
      }

      let size = 0;
      let idx = 1;
      // iterate the keyspace and write out each blob to a stream
      const body = new ReadableStream({
        async start(controller) {
          while (true) {
            const res = await kv.get([...rec.prefix, idx.toString()]);
            if (res.value === null && res.versionstamp === null) {
              break;
            }

            controller.enqueue(res.value as Uint8Array);
            size += (res.value as Uint8Array).length;
            idx++;
          }

          console.log(prefixstr, "Log chunks", idx - 1, "size", size);
          controller.close();
        },

        cancel() {
          console.log(prefixstr, "Log retrieval cancelled");
        },
      });

      const res = new Response(body, {
        headers: {
          "content-type": "application/octet-stream",
        },
      });
      cache.put(request, res.clone());
      return res;
    } else if (key.startsWith("v1/logs/watch")) {
      // MARK: /v1/logs/watch SSE
      let logFormat = url.searchParams.get("fmt");
      logFormat = logFormat === null ? "text" : logFormat;
      logFormat = ["text", "html"].includes(logFormat) ? logFormat : "text";

      const headers = { "Content-Type": "text/event-stream" };
      const stream = kv.watch([[LATEST_LOG_KEY]]).getReader();
      const body = new ReadableStream({
        async start(controller) {
          while (true) {
            if ((await stream.read()).done) {
              return;
            }

            const obj = await kv.get(["logs/latest"]);
            const data = obj.value as IndexRecord;
            if (data === null) {
              continue;
            }

            if (logFormat === "html") {
              const fdata = `<div><p class="">Log uploaded: ${
                data.prefix.join("/")
              }</p><p class="font-bold">Size: ${data.size}</p></div>`;

              controller.enqueue(
                new TextEncoder().encode(
                  `event: logupload\ndata: ${fdata}\n\n`,
                ),
              );
            } else if (logFormat === "text") {
              const fdata = data.prefix.join("/") + " " + data.size;
              controller.enqueue(
                new TextEncoder().encode(
                  `event: logupload\ndata: ${fdata}\n\n`,
                ),
              );
            } else {
              console.log("Invalid log format", logFormat);
              controller.close();
            }
          }
        },

        cancel() {
          stream.cancel();
        },
      });
      return new Response(body, { headers });
    } else {
      return new Response("Invalid request", { status: 404 });
    }
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// MARK: HTML

function app(request: Request): string {
  const url = request.url + (request.url.endsWith("/") ? "" : "/");
  return `
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <title>Buck2 Logs</title>
      </head>
      <body>
        <div>
          <h2>Log uploads</h2>
          <div hx-ext="sse" sse-connect="${url}v1/logs/watch?fmt=html">
            <div sse-swap="logupload" hx-swap="afterbegin">
            </div>
          </div>
        </div>
        <script
          src="https://unpkg.com/htmx.org@2.0.0"
          integrity="sha384-wS5l5IKJBvK6sPTKa2WZ1js3d947pvWXbPJ1OmWfEuxLgeHcEbjUUA5i9V5ZkpCw"
          crossorigin="anonymous"
        >
        </script>
        <script
          src="https://unpkg.com/htmx-ext-sse@2.0.0/sse.js"
          integrity="sha384-6BQ0r6BgBJ1HfQB7E0C7K6AP8k83MKLid3v0xFpx8W2e4hh4B9mCeEOmXq2XGs5P"
          crossorigin="anonymous"
        >
        </script>
      </body>
    </html>
  `;
}
