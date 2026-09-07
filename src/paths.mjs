import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = process.env.ATS_STATUS_HOME || path.join(os.homedir(), '.ats-status');
export const profileDir = (site) => path.join(HOME, 'profiles', site);
export const capturedFile = (site) => path.join(HOME, 'captured', `${site}.json`);
export const metaFile = (site) => path.join(HOME, 'meta', `${site}.json`);
export const outFile = (site) => path.join(HOME, 'out', `${site}.json`);
export const historyFile = (site) => path.join(HOME, 'out', `${site}.history.jsonl`);
export const rawFile = (site) => path.join(HOME, 'out', `${site}.raw.json`);
export const appsFile = () => path.join(HOME, 'apps.json');
export const correctionsFile = () => path.join(HOME, 'corrections.json');
export const dashboardFile = () => path.join(HOME, 'out', 'dashboard.html');
export const reportStateFile = () => path.join(HOME, 'out', '_report.last.json');

export function ensureDirs() {
  for (const d of ['profiles', 'captured', 'meta', 'out']) fs.mkdirSync(path.join(HOME, d), { recursive: true });
}
