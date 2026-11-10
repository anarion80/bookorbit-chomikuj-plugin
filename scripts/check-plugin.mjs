#!/usr/bin/env node

// Stub shape/safety check for the built plugin.
// Todo 20 replaces this with a real BookOrbit plugin contract check.

import { existsSync } from 'node:fs';

const builtFile = new URL('../dist/index.mjs', import.meta.url);

if (!existsSync(builtFile)) {
  console.error('dist/index.mjs not built');
  process.exit(1);
}

console.log('dist/index.mjs present (stub check - no contract validation yet)');
process.exit(0);
