// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/** Minimal cross-request async-lifetime repro; no storage or Workflow APIs. */
export class Serial {
  tail = Promise.resolve();

  fetch(request) {
    const id = new URL(request.url).pathname;
    const result = this.tail.then(async () => {
      console.log("START", id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      console.log("END", id);
      return new Response("done " + id);
    });
    this.tail = result.catch(() => {});
    return result;
  }
}

export default {
  async fetch(_request, env) {
    const stub = env.SERIAL.getByName("one");
    const replies = await Promise.all([
      stub.fetch("http://do/a"),
      stub.fetch("http://do/b"),
    ]);
    return Response.json(
      await Promise.all(replies.map((reply) => reply.text())),
    );
  },
};
