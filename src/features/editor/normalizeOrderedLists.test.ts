import {EditorState} from '@codemirror/state';
import {describe,expect,it} from 'vitest';
import {normalizeOrderedLists} from './normalizeOrderedLists';
import {markdownTree} from './markdownParse';

function normalize(doc:string){
  const state=EditorState.create({doc});
  const {changes,skipped}=normalizeOrderedLists(state);
  const normalized=changes.apply(state.doc);
  return {text:normalized.toString(),skipped,structure:markdownTree(EditorState.create({doc:normalized})).toString(),oldStructure:markdownTree(state).toString()};
}

describe('normalize saved ordered lists',()=>{
  it('writes consecutive direct siblings with each list starting value and delimiter',()=>{
    const doc='1. First\n3. Third\n4. Fourth\n\nSeparate.\n\n5) Five\n7) Next\n2) Last\n';
    const expected='1. First\n2. Third\n3. Fourth\n\nSeparate.\n\n5) Five\n6) Next\n7) Last\n';
    expect(normalize(doc)).toMatchObject({text:expected,skipped:false});
    expect(normalize(expected)).toMatchObject({text:expected,skipped:false});
  });

  it('retains nested, quoted, and fenced blocks across growing and shrinking markers',()=>{
    const doc=[
      '> 9) First','> 2) Larger marker','>    multi-line continuation','>',
      '>    3) Nested','>    6) Still nested','>',
      '>    ```md','>    3) literal fence line','>    ```','',
      '1. Another list','10. Smaller marker','    continuation','',
      '    - nested bullet','    - another bullet','',
    ].join('\n');
    const expected=[
      '> 9) First','> 10) Larger marker','>     multi-line continuation','>',
      '>     3) Nested','>     4) Still nested','>',
      '>     ```md','>     3) literal fence line','>     ```','',
      '1. Another list','2. Smaller marker','   continuation','',
      '   - nested bullet','   - another bullet','',
    ].join('\n');
    const result=normalize(doc);
    expect(result).toMatchObject({text:expected,skipped:false});
    expect(result.structure).toBe(result.oldStructure);
  });

  it('protects metadata, plain snippets, and Markdown beyond its nine-digit limit',()=>{
    const protectedText='---\nsample: |\n  1. alpha\n  3. beta\n---\n\n```md\n1. alpha\n3. beta\n```\n\n999999999. Max\n1. Greater\n';
    expect(normalize(protectedText)).toMatchObject({text:protectedText,skipped:true});
    const task='1. [x] Done\n7. [ ] Next\n';
    expect(normalize(task)).toMatchObject({text:'1. [x] Done\n2. [ ] Next\n',skipped:false});
  });
});
