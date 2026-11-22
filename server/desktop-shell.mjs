import {randomUUID} from 'node:crypto';

/** The backend resolves local paths before requesting native Explorer operations. */
export function desktopShell(channel,{timeoutMs=5000}={}){
  const pending=new Map();
  const fail=()=>Object.assign(new Error('无法打开系统资源管理器，请重试。'),{status:503});
  function finish(id,error){const request=pending.get(id);if(!request)return;pending.delete(id);clearTimeout(request.timer);if(error)request.reject(error);else request.resolve();}
  const message=value=>{
    const request=pending.get(value?.id);
    if(request&&request.replyType===value.type)finish(value.id,value.ok===true?null:fail());
  };
  const disconnect=()=>{for(const id of pending.keys())finish(id,fail());};
  channel.on('message',message);channel.on('disconnect',disconnect);
  function request(type,replyType,target){
    return new Promise((resolve,reject)=>{
      if(!channel.connected||typeof channel.send!=='function'){reject(fail());return;}
      const id=randomUUID(),timer=setTimeout(()=>finish(id,fail()),timeoutMs);
      pending.set(id,{resolve,reject,timer,replyType});
      try{channel.send({type,id,path:target},error=>{if(error)finish(id,fail());});}catch{finish(id,fail());}
    });
  }
  return {
    revealFile:target=>request('hive-reveal-file','hive-reveal-result',target),
    openDirectory:target=>request('hive-open-directory','hive-open-directory-result',target),
    dispose(){disconnect();channel.removeListener('message',message);channel.removeListener('disconnect',disconnect);},
  };
}
