import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGameHost, exampleEntities } from './game-host.mjs';

const modulePath = new URL('../publish/hosted-gameplay.wasm', import.meta.url);
const module = new WebAssembly.Module(fs.readFileSync(modulePath));
const host = createGameHost(module, exampleEntities());

for (const seconds of [0.5, 1, 0.5]) {
  assert.equal(host.step(seconds), 2);
  console.log(`After ${seconds}s: ${JSON.stringify(host.snapshot())}`);
}

const before = host.snapshot();
assert.throws(
  () => host.run('Demo.HostedGameplay.FailAfterMove', 101),
  WebAssembly.RuntimeError,
);
assert.equal(host.lastFault(), 6);
assert.deepEqual(host.snapshot(), before);
console.log(
  'Trapped frame discarded its queued movement; entity state is unchanged.',
);
assert.equal(host.step(0.5), 2);
assert.equal(host.lastFault(), 0);
console.log(`Recovered next frame: ${JSON.stringify(host.snapshot())}`);
