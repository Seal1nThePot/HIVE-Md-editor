const path=require('node:path');
const {promises:fs}=require('node:fs');

// This handler is attached only to the application's own backend IPC channel.
function createFileRevealHandler({shell,stat=target=>fs.lstat(target)}){
  return async message=>{
    const openDirectory=message?.type==='hive-open-directory';
    const reply={type:openDirectory?'hive-open-directory-result':'hive-reveal-result',id:message?.id,ok:false};
    try{
      const target=message?.path;
      if(!openDirectory&&message?.type!=='hive-reveal-file')return reply;
      if(typeof message.id!=='string'||!/^[-a-f0-9]{36}$/.test(message.id)||typeof target!=='string'||target.includes('\0')||target.length>32767||!path.isAbsolute(target))return reply;
      const item=await stat(target);
      if(item.isSymbolicLink())return reply;
      if(openDirectory){
        if(!item.isDirectory())return reply;
        reply.ok=await shell.openPath(target)==='';
      }else if(item.isFile()||item.isDirectory()){
        shell.showItemInFolder(target);reply.ok=true;
      }
    }catch{}
    return reply;
  };
}
module.exports={createFileRevealHandler};
