// (web port) Playwright's cached Chromium (npx playwright install chromium), or CHROMIUM=<path to an executable>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function cachedChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  for (const base of [path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort().reverse())
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
                         'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
  }
  return undefined;
}
