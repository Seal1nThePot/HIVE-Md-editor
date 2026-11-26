import {HighlightStyle,syntaxHighlighting,StreamLanguage} from '@codemirror/language';
import {javascriptLanguage,jsxLanguage,typescriptLanguage,tsxLanguage} from '@codemirror/lang-javascript';
import {htmlLanguage} from '@codemirror/lang-html';
import {cssLanguage} from '@codemirror/lang-css';
import {jsonLanguage} from '@codemirror/lang-json';
import {csharp} from '@codemirror/legacy-modes/mode/clike';
import {tags,classHighlighter,highlightTree} from '@lezer/highlight';
import type {SyntaxNode} from '@lezer/common';

export const csharpLanguage=StreamLanguage.define(csharp);
const languages={js:javascriptLanguage,javascript:javascriptLanguage,jsx:jsxLanguage,ts:typescriptLanguage,typescript:typescriptLanguage,tsx:tsxLanguage,html:htmlLanguage,css:cssLanguage,json:jsonLanguage,cs:csharpLanguage,'c#':csharpLanguage,csharp:csharpLanguage};
export function fencedCodeLanguage(info:string){
  const name=info.trim().split(/\s+/)[0].toLowerCase();
  return Object.prototype.hasOwnProperty.call(languages,name)?languages[name as keyof typeof languages]:null;
}
// Scope each style to an embedded language so Markdown outside the fence keeps
// its existing colours. Mix toward document text for both light and dark themes.
const rules=[
  {tag:[tags.keyword,tags.modifier,tags.controlKeyword],color:'color-mix(in srgb, var(--hive-document-text, var(--text)) 60%, #a258d4)'},
  {tag:[tags.string,tags.regexp],color:'color-mix(in srgb, var(--hive-document-text, var(--text)) 60%, #249e66)'},
  {tag:[tags.number,tags.bool,tags.null],color:'color-mix(in srgb, var(--hive-document-text, var(--text)) 60%, #df7b29)'},
  {tag:[tags.comment],color:'color-mix(in srgb, var(--hive-document-text, var(--text)) 70%, var(--hive-document-bg, #fff))',fontStyle:'italic'},
  {tag:[tags.function(tags.variableName),tags.definition(tags.variableName),tags.tagName,tags.attributeName,tags.propertyName],color:'color-mix(in srgb, var(--hive-document-text, var(--text)) 65%, #3d8bdf)'},
];
export const fencedCodeHighlight=[...new Set(Object.values(languages))].map(language=>syntaxHighlighting(HighlightStyle.define(rules,{scope:language})));

export function codeLanguageLabel(info:string){
  const name=info.trim().split(/\s+/)[0];
  const labels:Record<string,string>={ts:'TypeScript',typescript:'TypeScript',tsx:'TSX',js:'JavaScript',javascript:'JavaScript',jsx:'JSX',html:'HTML',css:'CSS',json:'JSON',cs:'C#','c#':'C#',csharp:'C#',py:'Python',python:'Python',bash:'Bash',sh:'Shell',sql:'SQL',md:'Markdown',markdown:'Markdown'};
  return labels[name.toLowerCase()]??name;
}
/** Slice the complete fence body, retaining blank lines, tabs and indentation. */
export function fencedCodeBody(text:string,node:SyntaxNode){
  const marks=node.getChildren('CodeMark');
  const opening=marks[0];
  if(!opening)return node.getChildren('CodeText').map(part=>text.slice(part.from,part.to)).join('');
  const newline=text.indexOf('\n',opening.to);
  if(newline<0||newline>=node.to)return '';
  const closing=marks[1];
  const end=closing?Math.max(newline+1,text.lastIndexOf('\n',closing.from-1)):node.to;
  return text.slice(newline+1,end);
}
export function codeHighlightRanges(text:string,info:string){
  const language=fencedCodeLanguage(info);
  const ranges:{from:number;to:number;className:string}[]=[];
  if(language)highlightTree(language.parser.parse(text),classHighlighter,(from,to,className)=>ranges.push({from,to,className}));
  return ranges;
}
