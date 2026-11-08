import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';

const digest = text => createHash('sha256').update(text).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class FileConflict extends Error {}

// Antivirus and the hub's file watcher can briefly hold a file on Windows. Recheck the source before every retry.
export async function atomicWrite(file, text, expectedHash, { allowMissing = false, renameFile = rename } = {}) {
  const tmp = `${file}.workbench-${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { flag: 'wx', mode: 0o600 });
    for (let attempt=0; ; attempt++) {
      let current;
      try { current = await readFile(file, 'utf8'); }
      catch (error) {
        if (allowMissing && error.code === 'ENOENT') current = '';
        else if (error.code === 'ENOENT') throw new FileConflict('文件已被其他程序修改，请重新加载后再保存');
        else if (['EPERM','EBUSY','EACCES'].includes(error.code) && attempt < 7) { await delay(80 * (attempt + 1)); continue; }
        else throw error;
      }
      if (digest(current) !== expectedHash) throw new FileConflict('文件已被其他程序修改，请重新加载后再保存');
      try { await renameFile(tmp, file); return; }
      catch (error) {
        if (!['EPERM','EBUSY','EACCES'].includes(error.code) || attempt >= 7) throw error;
        await delay(80 * (attempt + 1));
      }
    }
  } finally { await unlink(tmp).catch(() => {}); }
}
