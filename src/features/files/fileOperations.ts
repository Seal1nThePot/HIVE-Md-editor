import type {RefObject} from 'react';
import type {EditorSession} from '../editor/editorSessionTypes';

export type FileActivityUpdate=(busy:boolean,openingFile:boolean)=>void;
const activity=new WeakMap<object,Map<object,boolean>>();
/** A completed or superseded operation can release only its own loading indicator. */
export function beginFileActivity(owner:object,setBusy:FileActivityUpdate,openingFile=false){
  let pending=activity.get(owner);if(!pending){pending=new Map();activity.set(owner,pending);}
  const update=()=>{
    const busy=pending.size>0;
    setBusy(busy,busy&&[...pending.values()].every(value=>value));
  };
  const token={};pending.set(token,openingFile);update();let done=false;
  return ()=>{if(done)return;done=true;pending.delete(token);update();};
}
type Read={cancel:()=>void};
const reads=new WeakMap<object,Map<string,Read>>();
export function beginFileRead(owner:RefObject<Map<string,EditorSession>>,id:string,scope:()=>boolean,setBusy:FileActivityUpdate,isOpen?:(id:string)=>boolean,openingFile=false){
  let pending=reads.get(owner);if(!pending){pending=new Map();reads.set(owner,pending);}
  const original=owner.current.get(id),doc=(original?.view?.state||original?.state)?.doc,path=original?.disk?.path,landing=original?.landing,version=original?.contentVersion||0,wasOpen=isOpen?.(id);
  const release=beginFileActivity(owner,setBusy,openingFile);let ended=false;
  const ticket={
    current:()=>!ended&&scope()&&pending!.get(id)===ticket,
    valid:()=>{
      const now=owner.current.get(id);
      return ticket.current()&&now===original&&((now?.view?.state||now?.state)?.doc===doc)&&now?.disk?.path===path&&now?.landing===landing&&(now?.contentVersion||0)===version&&(!wasOpen||!isOpen||isOpen(id));
    },
    cancel(){if(ended)return;ended=true;if(pending!.get(id)===ticket)pending!.delete(id);release();},
  };
  pending.get(id)?.cancel();pending.set(id,ticket);return ticket;
}
