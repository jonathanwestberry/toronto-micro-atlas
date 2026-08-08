import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertFg04Workflow,
  inspectFg04Candidate,
  verifyFg04Transport,
} from './fg04-release.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const candidate = inspectFg04Candidate({ distDir: resolve(root, 'dist') });
assertFg04Workflow(readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8'));
const transport = await verifyFg04Transport();

console.log(JSON.stringify({ candidate, transport }, null, 2));
