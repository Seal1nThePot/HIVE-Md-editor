import {afterEach,describe,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pluginStore} from './plugins.mjs';

const sample = fileURLToPath(new URL('./plugin-examples/selection-lines.json',import.meta.url));
const roots = [];
afterEach(async ()=>{
  for(const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true});
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'hive-plugins-'));
  roots.push(root);
  const directory = path.join(root,'plugins');
  const state = path.join(root,'state');
  const opener = vi.fn();
  return {directory,opener,create:()=>pluginStore(directory,state,sample,opener)};
}

describe('local editor status plugins',()=>{
  it('installs the sample once, persists the toggle, and opens the exact catalog directory',async ()=>{
    const test = await fixture(),store = test.create();
    expect(await store.list()).toMatchObject({plugins:[],canOpenDirectory:true,canInstallSample:true});
    const id = 'hive.selection-lines';
    expect(await store.installSample()).toMatchObject({plugins:[{id,enabled:false,contribution:{metric:'selected-lines'}}],canInstallSample:false});
    await store.setEnabled({id,enabled:true});
    expect(await test.create().installSample()).toMatchObject({plugins:[{id,enabled:true}]});
    await test.create().setEnabled({id,enabled:false});
    expect(await store.list()).toMatchObject({plugins:[{id,enabled:false}]});
    await store.open();
    expect(test.opener).toHaveBeenCalledWith(await fs.realpath(test.directory));
  });

  it('quarantines bad, oversized and duplicate manifests without disabling an independent valid entry',async ()=>{
    const test=await fixture(),store=test.create();
    await store.installSample();
    const sampleContent=JSON.parse(await fs.readFile(sample,'utf8'));
    const write=(name,value)=>fs.writeFile(path.join(test.directory,name),value);
    await Promise.all([
      write('broken.json','{'),write('oversized.json','x'.repeat(16385)),
      write('duplicate.json',JSON.stringify(sampleContent)),
      write('independent.json',JSON.stringify({...sampleContent,id:'independent',contribution:{...sampleContent.contribution,metric:'line-length'}})),
      write('ignored.mjs','throw new Error("must not run")'),
    ]);
    const catalog=await store.list();
    expect(catalog.plugins.map(plugin=>plugin.id)).toEqual(['independent']);
    expect(catalog.errors.map(item=>item.file).sort()).toEqual(['broken.json','duplicate.json','hive-selection-lines.json','oversized.json']);
    await expect(store.setEnabled({id:'hive.selection-lines',enabled:true})).rejects.toMatchObject({status:404});
    expect(await store.setEnabled({id:'independent',enabled:true})).toMatchObject({plugins:[{id:'independent',enabled:true}]});
  });
});
