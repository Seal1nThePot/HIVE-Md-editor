import type {WritingOutlineSnapshot} from '../outline/writingNodes';

export type HistoryActor = 'human' | 'ai';
export type HistoryStatus = 'applied' | 'reverted';
export type HistoryLimits = Record<HistoryActor, number>;
export type HistoryOutline = WritingOutlineSnapshot;
export type HistoryTextPatch = {from:number;before:string;after:string;contextBefore:string;contextAfter:string};
export type HistoryChanges = {
  text?:HistoryTextPatch[];
  polish?:{id:string;reason:string;node:string;annotationIds?:readonly string[]};
  outline?:{before:HistoryOutline;after:HistoryOutline};
  file?:{action:string;path:string;id?:string;from?:string};
};
export type HistoryAction = {id:string;actor:HistoryActor;createdAt:string;label:string;file?:string};
export type HistoryRecord = HistoryAction & {
  kind:'text'|'properties'|'outline'|'file'|'snapshot-restore';
  status:HistoryStatus;
  changes:HistoryChanges;
};
export type HistorySnapshot = HistoryAction & {file:string;text:string;outline:HistoryOutline};
export type HistorySection = {title:string;text?:string;before?:string;after?:string};
export type HistorySummary = {
  revision:number;
  limits:HistoryLimits;
  entries:(Omit<HistoryRecord,'changes'> & {sections:HistorySection[];reversible:boolean})[];
  snapshots:(Omit<HistorySnapshot,'outline'|'text'> & {sections:HistorySection[]})[];
};
