import { wireRuntime } from './runtime.js';

async function test() {
  console.log('Starting wireRuntime...');
  try {
    const runtime = await wireRuntime();
    console.log('wireRuntime finished! queue.connected =', runtime.queue.connected);
    await runtime.stop();
  } catch (err) {
    console.error('wireRuntime failed:', err);
  }
}

test();
