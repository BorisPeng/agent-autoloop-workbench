import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.16.0') {
  throw new Error('Windows x64 builds require the official Node.js v24.16.0 x64 executable.');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, '.build'), { recursive: true });
await copyFile(process.execPath, path.join(root, '.build', 'node.exe'));
