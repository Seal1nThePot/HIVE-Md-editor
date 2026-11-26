import {describe,expect,it,vi} from 'vitest';
import {appendChatAttachments} from '../chat/chatAttachments';
import type {Entry} from '../files/explorerState';
import {workspaceAnnotationAttachment} from './workspaceAnnotationAttachment';

const entries:Entry[]=[
  {type:'folder',name:'A',path:'A',children:[
    {type:'file',name:'Note.md',path:'A/Note.md'},
    {type:'folder',name:'Child',path:'A/Child',children:[{type:'file',name:'Inner.md',path:'A/Child/Inner.md'}]},
  ]},
  {type:'folder',name:'B',path:'B',children:[{type:'file',name:'Note.md',path:'B/Note.md'}]},
  {type:'file',name:'Image.png',path:'Image.png'},
];
function fixture(){
  const repositories=[{id:'active',name:'A',root:'D:/private/A'},{id:'selected',name:'B',root:'D:/private/B'}];
  const request=vi.fn<typeof fetch>(async()=>Response.json({path:'B/Note.md',text:'Saved B'}));
  const findOpenDocument=(path:string)=>path==='A/Note.md'?'Unsaved A':undefined;
  return {workspaceId:'active',entries,repositories,request,findOpenDocument};
}

describe('workspace annotation attachments',()=>{
  it('keeps same-name files distinct and prefers the exact open buffer',async()=>{
    const source=fixture();
    const a=await workspaceAnnotationAttachment({kind:'file',path:'A/Note.md'},source);
    expect(source.request).not.toHaveBeenCalled();
    const b=await workspaceAnnotationAttachment({kind:'file',path:'B/Note.md'},source);
    expect(source.request).toHaveBeenCalledWith('/api/file?path=B%2FNote.md');
    const message=appendChatAttachments('Read', [{...a,id:'a'},{...b,id:'b'}]);
    expect(JSON.parse(message.split('\n').at(-1)!)).toMatchObject([
      {text:'Unsaved A',reference:{workspaceId:'active',path:'A/Note.md'}},
      {text:'Saved B',reference:{workspaceId:'active',path:'B/Note.md'}},
    ]);
  });

  it('captures a directory subtree and scopes each repository card to its own ID',async()=>{
    const source=fixture();
    const folder=await workspaceAnnotationAttachment({kind:'folder',path:'A'},source);
    expect(folder).toMatchObject({kind:'folder',reference:{workspaceId:'active',path:'A'},text:'A/Note.md\nA/Child/\nA/Child/Inner.md'});
    const repository=await workspaceAnnotationAttachment({kind:'repository',repositoryId:'selected'},source);
    expect(repository).toMatchObject({kind:'repository',reference:{workspaceId:'active',repositoryId:'selected'},text:'仓库：B'});
    expect(source.request).not.toHaveBeenCalled();
  });

  it('rejects missing targets, unsupported binary files and mismatched read results',async()=>{
    const source=fixture();
    await expect(workspaceAnnotationAttachment({kind:'file',path:'Missing.md'},source)).rejects.toThrow('已变化');
    await expect(workspaceAnnotationAttachment({kind:'file',path:'Image.png'},source)).rejects.toThrow('Markdown 文稿');
    expect(source.request).not.toHaveBeenCalled();
    source.request.mockResolvedValueOnce(Response.json({path:'A/Note.md',text:'wrong file'}));
    await expect(workspaceAnnotationAttachment({kind:'file',path:'B/Note.md'},source)).rejects.toThrow('不一致');
  });
});
