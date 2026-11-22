import {it,expect} from 'vitest';
import {EventEmitter} from 'node:events';
import {desktopShell} from './desktop-shell.mjs';

it('correlates native reveal requests and rejects timeout, disconnect, and send failures',async()=>{
  const channel=new EventEmitter();channel.connected=true;const sent=[];channel.send=(message,callback)=>{sent.push(message);callback();};const bridge=desktopShell(channel,{timeoutMs:20});
  const first=bridge.revealFile('C:\\文稿\\a & b.md'),second=bridge.revealFile('D:\\other.md');
  channel.emit('message',{type:'hive-reveal-result',id:sent[1].id,ok:true});await expect(second).resolves.toBeUndefined();
  channel.emit('message',{type:'hive-reveal-result',id:sent[0].id,ok:false});await expect(first).rejects.toThrow('无法打开');
  await expect(bridge.revealFile('C:\\timeout.md')).rejects.toThrow('无法打开');
  const disconnected=bridge.revealFile('C:\\disconnect.md');channel.emit('disconnect');await expect(disconnected).rejects.toThrow('无法打开');
  channel.send=()=>{throw Error('private path');};await expect(bridge.revealFile('C:\\send.md')).rejects.toThrow('无法打开');
  bridge.dispose();expect(channel.listenerCount('message')).toBe(0);expect(channel.listenerCount('disconnect')).toBe(0);
});

it('matches directory replies separately from file reveal replies',async()=>{
  const channel=new EventEmitter();channel.connected=true;
  const sent=[];channel.send=(message,callback)=>{sent.push(message);callback();};
  const bridge=desktopShell(channel);
  try{
    const directory='D:\\模板 & 配色', opening=bridge.openDirectory(directory), reveal=bridge.revealFile('D:\\test.md');
    expect(sent[0]).toMatchObject({type:'hive-open-directory',path:directory});
    channel.emit('message');
    channel.emit('message',{type:'hive-reveal-result',id:sent[0].id,ok:true});
    channel.emit('message',{type:'hive-reveal-result',id:sent[1].id,ok:true});
    await expect(reveal).resolves.toBeUndefined();
    channel.emit('message',{type:'hive-open-directory-result',id:sent[0].id,ok:false});
    await expect(opening).rejects.toMatchObject({status:503});
    const retry=bridge.openDirectory(directory);
    channel.emit('message',{type:'hive-open-directory-result',id:sent[2].id,ok:true});
    await expect(retry).resolves.toBeUndefined();
  }finally{bridge.dispose();}
});
