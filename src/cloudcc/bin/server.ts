// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import {
  createTRPCClient,
  httpBatchStreamLink,
  httpSubscriptionLink,
  splitLink,
} from "@trpc/client";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { Command } from "@cliffy/command";
import { commands as _llvmCommands, runLLVM } from "@yowasp/clang";

import { publicProcedure, router, transformer } from "../trpc.ts";
import { db } from "../db.ts";

/**
 * The server-side application router, whose type reflects the routes.
 *
 * NOTE: This constant MUST NOT EVER be exported!
 */
const appRouter = router({
  user: {
    list: publicProcedure.query(async () => {
      const users = await db.user.findMany();
      return users;
    }),
    byId: publicProcedure.input(z.string()).query(async (opts) => {
      const { input } = opts;
      const user = await db.user.findById(input);
      return user;
    }),
    create: publicProcedure
      .input(z.object({ name: z.string() }))
      .mutation(async (opts) => {
        const { input } = opts;
        const user = await db.user.create(input);
        return user;
      }),
  },
  examples: {
    iterable: publicProcedure.query(async function* () {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        yield i;
      }
    }),
  },
});

/**
 * Create a tRPC client connected to the given URL.
 *
 * @param url - The URL of the tRPC server.
 * @returns A tRPC client instance.
 */
export const createClient = (url: string) =>
  createTRPCClient<typeof appRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: httpSubscriptionLink({
          url,
          transformer,
        }),
        false: httpBatchStreamLink({
          url,
          transformer,
        }),
      }),
    ],
  });

if (import.meta.main) {
  await new Command()
    .name("cloudcc-server")
    .version("0.1.0")
    .description("Cloud Compiler Cache - tRPC Server")
    .env(
      "CLOUDCC_PORT=<port:number>",
      "Server port (default: 3000)",
      { prefix: "CLOUDCC_" },
    )
    .env(
      "CLOUDCC_HOST=<host:string>",
      "Server host (default: localhost)",
      { prefix: "CLOUDCC_" },
    )
    .option(
      "-p, --port <port:number>",
      "Port to listen on",
      { default: 3000 },
    )
    .option(
      "-H, --host <host:string>",
      "Host to bind to",
      { default: "localhost" },
    )
    .option(
      "-v, --verbose",
      "Enable verbose logging",
    )
    .action(async (options) => {
      if (options.verbose) {
        console.log("Starting Cloud Compiler Cache server...");
        console.log(`Configuration:`, {
          port: options.port,
          host: options.host,
        });
      }

      if (options.verbose) {
        console.log("Prefetching LLVM resources...");
      }
      await runLLVM(undefined, undefined, {
        fetchProgress: (args) => {
          if (options.verbose) {
            console.log(
              `Fetching LLVM: ${args.doneLength}/${args.totalLength} bytes`,
            );
          }
        },
      });
      if (options.verbose) {
        console.log("LLVM resources ready.");
      }

      const server = createHTTPServer({
        router: appRouter,
      });

      server.listen(options.port);
      console.log(
        `Server running at http://${options.host}:${options.port}`,
      );
    })
    .parse(Deno.args);
}
