import path from 'node:path';
import { fileURLToPath } from 'node:url';

// server/src/config/paths.ts -> repo root is three levels up. Never hardcode absolute paths.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const KNOWLEDGE_BASE_DIR = path.join(DATA_DIR, 'knowledge_base');
export const REPORTS_DIR = path.join(REPO_ROOT, 'reports');
