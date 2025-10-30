// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@cliffy/command";
import { createClient } from "./server.ts";

if (import.meta.main) {
  await new Command()
    .name("cloudcc")
    .version("0.1.0")
    .description("Cloud C/C++ Compiler")
    .env(
      "CLOUDCC_URL=<url:string>",
      "Server URL (default: http://localhost:3000)",
      { prefix: "CLOUDCC_" },
    )
    .globalOption(
      "-u, --url <url:string>",
      "Server URL to connect to",
      { default: "http://localhost:3000" },
    )
    .globalOption(
      "-v, --verbose",
      "Enable verbose logging",
    )
    // List users command
    .command("list", "List all users")
    .action(async (options) => {
      if (options.verbose) {
        console.log(`Connecting to ${options.url}...`);
      }
      const trpc = createClient(options.url);
      const users = await trpc.user.list.query();
      console.log("Users:", JSON.stringify(users, null, 2));
    })
    // Get user by ID command
    .command("get <id:string>", "Get a user by ID")
    .action(async (options, id) => {
      if (options.verbose) {
        console.log(`Connecting to ${options.url}...`);
        console.log(`Fetching user ${id}...`);
      }
      const trpc = createClient(options.url);
      const user = await trpc.user.byId.query(id);
      if (user) {
        console.log("User:", JSON.stringify(user, null, 2));
      } else {
        console.error(`User with ID ${id} not found`);
        Deno.exit(1);
      }
    })
    // Create user command
    .command("create <name:string>", "Create a new user")
    .action(async (options, name) => {
      if (options.verbose) {
        console.log(`Connecting to ${options.url}...`);
        console.log(`Creating user ${name}...`);
      }
      const trpc = createClient(options.url);
      const user = await trpc.user.create.mutate({ name });
      console.log("Created user:", JSON.stringify(user, null, 2));
    })
    // Stream example command
    .command("stream", "Test streaming iterable example")
    .action(async (options) => {
      if (options.verbose) {
        console.log(`Connecting to ${options.url}...`);
        console.log("Starting stream...");
      }
      const trpc = createClient(options.url);
      const iterable = await trpc.examples.iterable.query();
      for await (const i of iterable) {
        console.log("Received:", i);
      }
      if (options.verbose) {
        console.log("Stream complete.");
      }
    })
    // Demo command (original behavior)
    .command("demo", "Run demonstration of all features")
    .action(async (options) => {
      if (options.verbose) {
        console.log(`Connecting to ${options.url}...`);
      }
      const trpc = createClient(options.url);

      console.log("\n=== Listing all users ===");
      const users = await trpc.user.list.query();
      console.log("Users:", users);

      console.log("\n=== Creating a new user ===");
      const createdUser = await trpc.user.create.mutate({ name: "sachinraja" });
      console.log("Created user:", createdUser);

      console.log("\n=== Getting user by ID ===");
      const user = await trpc.user.byId.query("1");
      console.log("User 1:", user);

      console.log("\n=== Testing iterable stream ===");
      const iterable = await trpc.examples.iterable.query();
      for await (const i of iterable) {
        console.log("Iterable:", i);
      }

      console.log("\n=== Demo complete ===");
    })
    .parse(Deno.args);
}
