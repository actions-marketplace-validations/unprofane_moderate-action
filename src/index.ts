/** The entry the runner loads, bundled into dist/index.js. */
import { run } from './main.ts';

process.exitCode = await run();
