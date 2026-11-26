import type {EditorState} from '@codemirror/state';
import type {SyntaxNode} from '@lezer/common';
import {markdownTree} from './markdownParse';
import {isDrivePath} from '../files/localDocumentPath';

const key=(s:string)=>s.replace(/\\([\\\[\]])/g,'$1').trim().replace(/\s+/g,' ').toLowerCase();
function children(node:SyntaxNode){const result:SyntaxNode[]=[];for(let n=node.firstChild;n;n=n.nextSibling)result.push(n);return result;}
/** Find the Markdown link under the pointer, including full and collapsed references. */
export function linkAt(state:EditorState,pos:number):string|undefined{
  const tree=markdownTree(state),doc=state.doc;let node:SyntaxNode|null=tree.resolveInner(pos,1);
  let bareUrl:SyntaxNode|null=null;
  while(node&&node.name!=='Link'&&node.name!=='Autolink'){
    if(node.name==='Image'||node.name==='LinkReference')return;
    if(node.name==='URL')bareUrl=node;
    node=node.parent;
  }
  if(!node)return bareUrl?doc.sliceString(bareUrl.from,bareUrl.to):undefined;
  const parts=children(node),url=parts.find(n=>n.name==='URL');
  if(url)return doc.sliceString(url.from,url.to);
  const marks=parts.filter(n=>n.name==='LinkMark'),label=parts.find(n=>n.name==='LinkLabel');
  if(marks.length<2)return;
  const text=doc.sliceString(marks[0].to,marks[1].from),reference=label?doc.sliceString(label.from+1,label.to-1)||text:text;
  let result:string|undefined;
  const walk=(n:SyntaxNode)=>{if(result)return;if(n.name==='LinkReference'){const a=n.getChild('LinkLabel'),b=n.getChild('URL');if(a&&b&&key(doc.sliceString(a.from+1,a.to-1))===key(reference))result=doc.sliceString(b.from,b.to);return;}for(let child=n.firstChild;child;child=child.nextSibling)walk(child);};
  walk(tree.topNode);return result;
}
/** Resolve relative links within their document's origin, or return an explicit drive path. */
export function resolveLinkTarget(document:string,target:string):string{
  let raw=target.trim();if(raw.startsWith('<')&&raw.endsWith('>'))raw=raw.slice(1,-1);
  const hash=raw.indexOf('#');if(hash>=0)raw=raw.slice(0,hash);
  const absolute=isDrivePath(raw);
  try{raw=decodeURIComponent(raw);}catch{throw new Error('链接路径的百分号编码无效。');}
  if(absolute)return raw.replace(/\\/g,'/');
  if(!document)throw new Error('请先保存当前文稿，再跳转链接。');
  raw=raw.replace(/\\([\\()[\] #])/g,'$1');
  if(!raw)return document;
  if(/^[a-z][a-z\d+.-]*:/i.test(raw)||/^[\\/]/.test(raw)||raw.includes('\\')||raw.includes('?')||/[\x00-\x1f]/.test(raw))throw new Error('此链接不是仓库内的 Markdown 文件。');
  if(isDrivePath(document))return document.slice(0,document.lastIndexOf('/')+1)+raw;
  const parts=document.split('/').slice(0,-1);
  for(const part of raw.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)throw new Error('链接路径超出当前仓库。');parts.pop();}else parts.push(part);}
  const path=parts.join('/');if(!/\.md$/i.test(path))throw new Error('链接目标必须是 Markdown 文件（.md）。');return path;
}
