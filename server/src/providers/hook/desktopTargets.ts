import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ServerTarget } from '../../serverConfig.js';
import { isServerTarget } from '../../serverConfig.js';

/** Read the owner-only native desktop registration, if its process is live. */
export function readDesktopTarget(home = os.homedir()): ServerTarget | undefined {
  try {
    const file = path.join(home, '.pixel-agents', 'desktop', 'instance.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!isServerTarget(value)) return undefined;
    process.kill(value.pid, 0);
    return value;
  } catch {
    return undefined;
  }
}
