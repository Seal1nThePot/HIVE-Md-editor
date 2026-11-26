import {describe,it,expect} from 'vitest';
import {EditorState} from '@codemirror/state';
import {foldEffect,unfoldEffect,foldedRanges} from '@codemirror/language';
import {headingFolding,headingFolds,foldingEffects} from './headingFolding';
import {sourceTransaction,mirrorTransaction} from './splitView';
const make=(doc:string)=>EditorState.create({doc,extensions:headingFolding});
const ranges=(s:EditorState)=>{const out:{from:number;to:number}[]=[];foldedRanges(s).between(0,s.doc.length,(from,to)=>{out.push({from,to});});return out;};
describe('heading folding',()=>{
 it('ends at the next same or higher heading and ignores fenced code',()=>{
  const doc='# One\ntext\n## Child\n```\n# fake\n```\nbody\n## Peer\ntext\n# Next\nlast';const state=make(doc),h=headingFolds(state);
  expect(h.map(x=>x.level)).toEqual([1,2,2,1]);
  expect(doc.slice(h[0].from,h[0].to)).toBe('\ntext\n## Child\n```\n# fake\n```\nbody\n## Peer\ntext');
  expect(doc.slice(h[1].from,h[1].to)).toBe('\n```\n# fake\n```\nbody');
 });
 it('supports Setext, frontmatter and empty sections',()=>{
  const s=make('---\ntitle: x\n---\nTitle\n=====\nbody\nNext\n----\nend');const h=headingFolds(s);expect(h.map(x=>x.level)).toEqual([1,2]);expect(s.doc.sliceString(h[0].from,h[0].to)).toBe('\nbody\nNext\n----\nend');
  expect(headingFolds(make('# A\n# B')).length).toBe(0);
 });
 it('reuses the heading plan across selection and fold transactions and reindexes edits',()=>{
  const start=make('# One\nbody\n# Next\nend'),plan=headingFolds(start);
  const select=start.update({selection:{anchor:7}}).state;
  expect(headingFolds(select)).toBe(plan);
  const fold=select.update({effects:foldEffect.of(plan[0])}).state;
  expect(headingFolds(fold)).toBe(plan);
  const edited=fold.update({changes:{from:0,insert:'# Before\ntext\n'}}).state;
  expect(headingFolds(edited)).toHaveLength(3);
  expect(headingFolds(edited)[1].lineFrom).toBe(14);
 });
 it('mirrors folding between source and main without changing document or history',()=>{
  let main=make('# A\nbody\n# B\nend'),source=make(main.doc.toString());const h=headingFolds(main)[0];
  const sourceTr=source.update({effects:foldEffect.of(h)});const mainTr=main.update(sourceTransaction(sourceTr));main=mainTr.state;source=mirrorTransaction(source,mainTr).state;
  expect(ranges(source)).toEqual(ranges(main));expect(ranges(main)).toEqual([{from:h.from,to:h.to}]);expect(main.doc.toString()).toBe('# A\nbody\n# B\nend');
  const restored=make(main.doc.toString()).update({effects:foldingEffects(main)}).state;expect(ranges(restored)).toEqual(ranges(main));
  const tr=main.update({effects:unfoldEffect.of(h)});main=tr.state;source=mirrorTransaction(source,tr).state;expect(ranges(source)).toEqual([]);
 });
});
