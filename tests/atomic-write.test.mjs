// A temporarily locked file should be saved, but a concurrent edit must survive the retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, FileConflict } from '../atomic-write.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
test('temporary file locks retry without overwriting a concurrent edit',async()=>{
  const dir=await mkdtemp(path.join(await realpath(tmpdir()),'workbench-write-'));
  const file=path.join(dir,'rules.txt');
  try {
    await writeFile(file,'original');let tries=0;
    await atomicWrite(file,'updated',hash('original'),{renameFile:async(...args)=>{if(tries++===0){const e=new Error('locked');e.code='EPERM';throw e;}await rename(...args);}});
    assert.equal(await readFile(file,'utf8'),'updated');assert.equal(tries,2);
    tries=0;
    await assert.rejects(atomicWrite(file,'ours',hash('updated'),{renameFile:async()=>{tries++;await writeFile(file,'other change');const e=new Error('locked');e.code='EBUSY';throw e;}}),FileConflict);
    assert.equal(tries,1);assert.equal(await readFile(file,'utf8'),'other change');
  } finally {await rm(dir,{recursive:true,force:true});}
});
