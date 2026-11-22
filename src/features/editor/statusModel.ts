import type {Text} from '@codemirror/state';
import {markdownContent} from '../../shared/markdownContent';

export const statusItems=[['save','保存状态'],['count','总字数'],['selection','选中字数'],['position','行与列'],['lines','总行数'],['paragraphs','段落数量'],['narrationDialogue','叙述／对话比例'],['averageParagraphLength','平均段长'],['eol','换行符'],['encoding','编码'],['format','文件格式']] as const;
export type StatusKey=typeof statusItems[number][0];
export type CountMode='characters'|'text';
export type StatusOptions={items:StatusKey[];countMode:CountMode};
export const defaultStatus:StatusKey[]=['count'];
export const countDescription='字符数含标点；纯字数仅计文字和数字。两者均不计空白与 Markdown 标记。';
export const paragraphDescription='普通段落、标题和每条列表项分别计数；连续换行不另起段落，代码块和空行不计。';
export const statusLabel=(key:StatusKey)=>statusItems.find(item=>item[0]===key)![1];
export const isStatusKey=(value:unknown):value is StatusKey=>statusItems.some(([key])=>key===value);
export function normalizeStatus(value:unknown):StatusKey[]{
  return Array.isArray(value)?[...new Set(value.filter(isStatusKey))]:[...defaultStatus];
}
export function normalizeStatusOptions(value:unknown):StatusOptions{
  if(Array.isArray(value))return {items:normalizeStatus(value),countMode:'characters'};
  const current=value&&typeof value==='object'?value as Partial<StatusOptions>:{};
  return {items:normalizeStatus(current.items),countMode:current.countMode==='text'?'text':'characters'};
}
export function readStatusOptions(storage:Pick<Storage,'getItem'>):StatusOptions{
  for(const [key,legacy] of [['hive.editor-status.v3',false],['hive.editor-status.v2',false],['hive.editor-status.v1',true]] as const){
    try{const raw=storage.getItem(key);if(!raw)continue;const data=JSON.parse(raw);
      if(key.endsWith('v3')&&data?.version===3&&Array.isArray(data.items))return normalizeStatusOptions(data);
      if(!key.endsWith('v3')&&Array.isArray(data))return normalizeStatusOptions(legacy?['save',...data]:data);
    }catch{/* Retain earlier preferences when the latest record is unreadable. */}
  }
  return normalizeStatusOptions(null);
}
export function placeStatusItem(items:StatusKey[],key:StatusKey,index=items.length):StatusKey[]{
  const next=normalizeStatus(items),old=next.indexOf(key);let target=Math.max(0,Math.min(next.length,Math.trunc(index)));
  if(old>=0){next.splice(old,1);if(old<target)target--;}
  next.splice(target,0,key);return next;
}
export type TextStatistics = { characters: number; pureCount: number; paragraphs: number };
export type DocumentStatistics = TextStatistics & {
  narrationCount: number;
  dialogueCount: number;
  averageParagraphLength: number | null;
};
export const emptyDocumentStatistics: DocumentStatistics = {
  characters: 0,
  pureCount: 0,
  paragraphs: 0,
  narrationCount: 0,
  dialogueCount: 0,
  averageParagraphLength: null,
};

const whitespace = /\s/u;
const letterOrNumber = /[\p{L}\p{N}]/u;

function contentStatistics({ text, paragraphs }: ReturnType<typeof markdownContent>): TextStatistics {
  let characters=0,pureCount=0;
  for(const character of text){if(!whitespace.test(character))characters++;if(letterOrNumber.test(character))pureCount++;}
  return {characters,pureCount,paragraphs};
}

export function textStatistics(source: string): TextStatistics {
  return contentStatistics(markdownContent(source));
}

export function textDocumentStatistics(source: string): DocumentStatistics {
  let proseCount = 0;
  let proseParagraphs = 0;
  let dialogueCount = 0;
  let straightQuote: number | undefined;
  const curlyQuotes: number[] = [];
  const dialogue: { from: number; to: number }[] = [];

  function closeQuote(from: number | undefined) {
    if (from === undefined || from === proseCount) return;
    // Positions are measured in pure letters and digits. Each later closing
    // quote can only overlap the last ranges, including mixed nested quotes.
    while (dialogue.length && dialogue[dialogue.length - 1].to >= from) {
      const previous = dialogue.pop()!;
      dialogueCount -= previous.to - previous.from;
      from = Math.min(from, previous.from);
    }
    dialogue.push({ from, to: proseCount });
    dialogueCount += proseCount - from;
  }

  const content = markdownContent(source, paragraph => {
    const before = proseCount;
    for (const character of paragraph) {
      if (letterOrNumber.test(character)) proseCount++;
      else if (character === '“') curlyQuotes.push(proseCount);
      else if (character === '”') closeQuote(curlyQuotes.pop());
      else if (character === '"') {
        if (straightQuote === undefined) straightQuote = proseCount;
        else {
          closeQuote(straightQuote);
          straightQuote = undefined;
        }
      }
    }
    if (proseCount > before) proseParagraphs++;
  });

  return {
    ...contentStatistics(content),
    narrationCount: proseCount - dialogueCount,
    dialogueCount,
    averageParagraphLength: proseParagraphs ? proseCount / proseParagraphs : null,
  };
}

const statisticsCache=new WeakMap<Text,DocumentStatistics>();
export const cachedDocumentStatistics=(doc:Text)=>statisticsCache.get(doc);
export function cacheDocumentStatistics(doc:Text,value:DocumentStatistics){statisticsCache.set(doc,value);}
export function documentStatistics(doc:Text){
  let value=statisticsCache.get(doc);if(!value){value=textDocumentStatistics(doc.toString());statisticsCache.set(doc,value);}return value;
}
