import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import prefs from './preferences.cjs';
import {readFileSync} from 'node:fs';

describe('desktop preference persistence', () => {
  it('rejects credentials, prototype keys, invalid values and oversized data', () => {
    for (const data of [JSON.parse('{"__proto__":"x"}'), {'hive.apiKey':'secret'}, {'hive.appearance.v1':3}, {'hive.appearance.v1':'x'.repeat(131073)}, {'hive.reasoning.["s","m"]':'secret'}])
      expect(() => prefs.normalize(data)).toThrow();
    expect(prefs.allowed('hive.explorer.v1:workspace')).toBe(true);
    expect(prefs.allowed('hive.views.v1:workspace')).toBe(true);
    expect(prefs.allowed('hive.recentDocuments.v1:workspace')).toBe(true);
    for(const key of ['hive.aiButtonLayout.v1','hive.recentRepositories.v1','hive.aiResponsePreferences.v1'])expect(prefs.allowed(key)).toBe(true);
  });
  it('persists typography alongside old appearance settings with matching preload/main allowlists',async()=>{
    const preload=readFileSync(new URL('./preload.cjs',import.meta.url),'utf8'),main=readFileSync(new URL('./preferences.cjs',import.meta.url),'utf8');
    expect(preload.match(/const exact = new Set\((\[[^\n]+\])\)/)?.[1]).toBe(main.match(/const exact = new Set\((\[[^\n]+\])\)/)?.[1]);
    expect(preload.match(/(\[[^\n]+\])\.some\(prefix => key\.startsWith\(prefix\)/)?.[1]).toBe(main.match(/(\[[^\n]+\])\.some\(prefix => key\.startsWith\(prefix\)/)?.[1]);
    const value=JSON.stringify({version:1,preset:'novel',maxWidth:760,lineHeight:2.05,paragraphSpacing:.35,firstLineIndent:true}),dir=await mkdtemp(path.join(os.tmpdir(),'hive-typography-'));
    try{const file=path.join(dir,'prefs.json');await prefs.preferenceStore(file).save({'hive.appearance.v1':'{"version":1,"editorSize":18}','hive.typography.v1':value,'hive.theme.v1':value,'hive.frontmatter-visible.v1':'false'});const saved=await prefs.preferenceStore(file).read();expect(saved['hive.typography.v1']).toBe(value);expect(saved['hive.theme.v1']).toBe(value);expect(saved['hive.frontmatter-visible.v1']).toBe('false');}finally{await rm(dir,{recursive:true,force:true});}
  });
  it('persists every supported reasoning level through the desktop preference allowlist',()=>{
    const key='hive.reasoning.["service","model"]';
    const levels=['default','off','minimal','low','medium','high','xhigh','max'];
    const preload=readFileSync(new URL('./preload.cjs',import.meta.url),'utf8');
    const included=preload.match(/(\['default'[^\n]+?\])\.includes\(value\)/)?.[1];
    expect(included).toBe('['+levels.map(level=>"'"+level+"'").join(',')+']');
    for(const level of levels)expect(prefs.normalize({[key]:level})[key]).toBe(level);
  });
  it('atomically saves changed snapshots, preserves deletions and skips repeated snapshots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(),'hive-prefs-'));
    try {
      const file=path.join(dir,'preferences.json'), store=prefs.preferenceStore(file);
      expect({...await store.read()}).toEqual({});
      await store.save({'hive.appearance.v1':'dark','hive.views.v1:one':'views'});
      const before=await stat(file);
      await store.save({'hive.views.v1:one':'views','hive.appearance.v1':'dark'});
      expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
      await store.save({'hive.appearance.v1':'light'}); await store.flush();
      expect(JSON.parse(await readFile(file,'utf8'))).toEqual({'hive.appearance.v1':'light'});
      expect({...await prefs.preferenceStore(file).read()}).toEqual({'hive.appearance.v1':'light'});
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
