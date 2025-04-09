// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { debounce } from "jsr:@std/async/debounce";
import { parseArgs } from "jsr:@std/cli/parse-args";
import { exists } from "jsr:@std/fs/exists";
import { toReadableStream } from "jsr:@std/io/to-readable-stream";

const flags = parseArgs(Deno.args, {
  string: ["host"],
  boolean: ["help", "watch"],
  default: { "host": "http://localhost:8000", watch: false },
});

let projectDir = String(flags._[0] || ".");
if (!(await exists(projectDir))) {
  console.error("Directory does not exist:", projectDir);
  Deno.exit(1);
} else {
  // go ahead and create buck-out/v2/log immediately if it isn't there and begin
  // watching that so we can pick up logs as soon as possible
  projectDir = `${projectDir}/buck-out/v2/log`;
  if (await exists(projectDir)) {
    console.log("Found buck-out/ log directory:", projectDir);
  } else {
    console.log("Creating buck-out/ log directory:", projectDir);
    await Deno.mkdir(projectDir, { recursive: true });
  }
}

console.log("Uploading logs to", flags.host);
const uploadLog = async (
  filename: string,
) => {
  const logFormat = "pb-zst"; // FIXME (aseipp): this should be configurable
  const basename = filename.split("/").pop();
  if (basename === undefined) {
    return;
  }

  const parts = basename?.split("_");
  const timestamp = parts[0];
  const logType = parts[1];
  const uuid = parts[2];

  const f = await Deno.open(filename);
  const sz = (await f.stat()).size;

  console.log("Log file discovered:", sz, timestamp, logType, uuid);
  const req = new Request(`${flags.host}/v1/logs/upload`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": `${sz}`,

      "x-timestamp": timestamp,
      "x-type": logType,
      "x-uuid": uuid,
      "x-format": logFormat,
    },
    body: toReadableStream(f),
  });

  const resp = await fetch(req);
  const respBody = await resp.text();
  console.log("Upload response:", resp.status, respBody);
  return resp;
};

const watchLogEvent = debounce(async (event: Deno.FsEvent) => {
  const file = event.paths[0];
  if (!file.endsWith("_events.pb.zst")) {
    return;
  }

  if (event.kind === "access") {
    // log path looks like: 20240622-211843_build_07d6980a-fb21-4073-8d98-e72f876cdb16_events.pb.zst
    // we want to parse out these parts:
    // - 20240622-211843 (date)
    // - build (type)
    // - 07d6980a-fb21-4073-8d98-e72f876cdb16 (uuid)

    await uploadLog(file);
  }
}, 200);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (flags.watch) {
  let watcher = Deno.watchFs(projectDir);
  do {
    console.log("Watching directory", projectDir);
    for await (const event of watcher) {
      if (event.kind === "remove" && event.paths[0] === projectDir) {
        console.log("Directory removed, restarting watcher...");

        // loop until the directory is recreated
        let backoff = 5; // milliseconds, exponential
        while (!(await exists(projectDir))) {
          await sleep(backoff);
          backoff *= 2;
          if (backoff > 500) {
            backoff = 500;
          }
        }

        watcher = Deno.watchFs(projectDir);
        break; // to do-while
      }

      watchLogEvent(event);
    }
  } while (true);
} else {
  for await (const entry of Deno.readDir(projectDir)) {
    if (entry.isFile && entry.name.endsWith("_events.pb.zst")) {
      await uploadLog(`${projectDir}/${entry.name}`);
    }
  }
}
