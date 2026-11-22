import {describe,it,expect} from 'vitest';
import {EditorState} from '@codemirror/state';
import {cachedDocumentStatistics,defaultStatus,documentStatistics,emptyDocumentStatistics,normalizeStatus,normalizeStatusOptions,placeStatusItem,readStatusOptions,statusLabel,textDocumentStatistics,textStatistics} from './statusModel';
const storage=(records:Record<string,string>)=>({getItem:(key:string)=>records[key]??null});
describe('editor status preferences',()=>{
  it('defaults to characters only and preserves deliberate empty preferences',()=>{
    expect(readStatusOptions(storage({}))).toEqual({items:['count'],countMode:'characters'});
    expect(normalizeStatusOptions({items:[],countMode:'text'})).toEqual({items:[],countMode:'text'});
    expect(defaultStatus).toEqual(['count']);
  });
  it('retains user order, removes unknown and duplicate keys, and supports paragraphs',()=>{
    expect(normalizeStatus(['paragraphs','count','save','paragraphs','obsolete',12])).toEqual(['paragraphs','count','save']);
  });
  it('reads the new format, migrates both previous formats without resetting user choices',()=>{
    expect(readStatusOptions(storage({'hive.editor-status.v3':JSON.stringify({version:3,items:['paragraphs','count'],countMode:'text'}),'hive.editor-status.v2':'["encoding"]'}))).toEqual({items:['paragraphs','count'],countMode:'text'});
    expect(readStatusOptions(storage({'hive.editor-status.v2':'["encoding","count"]'}))).toEqual({items:['encoding','count'],countMode:'characters'});
    expect(readStatusOptions(storage({'hive.editor-status.v1':'["lines","count"]'}))).toEqual({items:['save','lines','count'],countMode:'characters'});
    expect(readStatusOptions(storage({'hive.editor-status.v3':'{broken','hive.editor-status.v2':'[]'}))).toEqual({items:[],countMode:'characters'});
  });
  it('lets users opt into both writing metrics in their preferred order',()=>{
    expect(statusLabel('narrationDialogue')).toBe('叙述／对话比例');
    expect(statusLabel('averageParagraphLength')).toBe('平均段长');
    const items=placeStatusItem(placeStatusItem(['count'],'averageParagraphLength',0),'narrationDialogue',1);
    expect(readStatusOptions(storage({'hive.editor-status.v3':JSON.stringify({version:3,items,countMode:'text'})})))
      .toEqual({items:['averageParagraphLength','narrationDialogue','count'],countMode:'text'});
    expect(readStatusOptions(storage({'hive.editor-status.v2':'["count"]'})).items).toEqual(['count']);
  });
  it('inserts available items and reorders existing ones without duplication or mutating the original',()=>{
    const items=['save','count','encoding'] as const;
    expect(placeStatusItem([...items],'paragraphs',1)).toEqual(['save','paragraphs','count','encoding']);
    expect(placeStatusItem([...items],'save',3)).toEqual(['count','encoding','save']);
    expect(placeStatusItem([...items],'encoding',0)).toEqual(['encoding','save','count']);
    expect(placeStatusItem([...items],'count',1)).toEqual(items);
    expect(items).toEqual(['save','count','encoding']);
  });
});
describe('writing status statistics',()=>{
  it('distinguishes visible characters from text and numbers while excluding Markdown and whitespace',()=>{
    expect(textStatistics('# 你\n\n**好**，A1🙂 !')).toEqual({characters:7,pureCount:4,paragraphs:2});
    expect(textStatistics('[中文](https://example.test/path) <u>A1</u>')).toMatchObject({characters:4,pureCount:4});
    expect(textStatistics('𠮷\tA\n🙂')).toMatchObject({characters:3,pureCount:2});
  });
  it('counts headings, list items and quoted paragraphs while ignoring code blocks and blank lines',()=>{
    expect(textStatistics('# 标题\n\n第一段\n换行仍是同段\n\n- 列表一\n- [x] 列表二\n\n> 引用\n\n```js\nconst x=1;\n```').paragraphs).toBe(5);
    expect(textStatistics('标题\n====\n\n段落\n\n\n另一段').paragraphs).toBe(3);
    expect(textStatistics('```\n代码\n```').paragraphs).toBe(0);
    expect(textStatistics('#\n\n- [ ] ').paragraphs).toBe(0);
    expect(textStatistics('\n \t\n')).toEqual({characters:0,pureCount:0,paragraphs:0});
  });
});

describe('document writing metrics',()=>{
  it('measures the same prose across headings, soft line breaks, tasks, quoted paragraphs, and inline Markdown',()=>{
    const source=[
      '---\ntitle: "metadata"\n---',
      '# 标题',
      '第一段 “你好，𠮷1”\n普通续行',
      '- [x] 项 "OK2"',
      '> 引用',
      '独立 [链接](https://example.test "hidden") <u>甲</u> `"code123"` ![alt](picture.png) https://example.test <!-- comment123 -->',
      '！！！',
      '| 表格 | 甲 |\n| --- | --- |\n| 乙 | 丙 |',
      '```js\nconst value = "code123";\n```',
    ].join('\n\n');
    expect(textDocumentStatistics(source)).toEqual({
      ...textStatistics(source),
      narrationCount:17,
      dialogueCount:7,
      averageParagraphLength:24/5,
    });
  });

  it('only counts paired quotes, joins multiline dialogue, and counts nested dialogue once',()=>{
    const source='甲 ”乙 “丙 “丁 "A2" 戊” 己 “庚\n\n辛” 壬 "未闭';
    expect(textDocumentStatistics(source)).toMatchObject({
      narrationCount:7,dialogueCount:6,averageParagraphLength:6.5,
    });
  });

  it('leaves the average unavailable for documents without countable prose and supports one-sided ratios',()=>{
    expect(textDocumentStatistics('')).toEqual(emptyDocumentStatistics);
    expect(textDocumentStatistics('！！\n\n`code123`\n\n![alt](path)')).toMatchObject({
      narrationCount:0,dialogueCount:0,averageParagraphLength:null,
    });
    expect(textDocumentStatistics('“甲”')).toMatchObject({narrationCount:0,dialogueCount:1,averageParagraphLength:1});
    expect(textDocumentStatistics('甲')).toMatchObject({narrationCount:1,dialogueCount:0,averageParagraphLength:1});
  });

  it('reuses the current CodeMirror document across panes and recalculates when its identity changes',()=>{
    const initial=EditorState.create({doc:'甲 “乙”'});
    const value=documentStatistics(initial.doc);
    expect(documentStatistics(initial.update({selection:{anchor:1}}).state.doc)).toBe(value);
    const changed=initial.update({changes:{from:0,to:1,insert:'甲丙'}}).state.doc;
    expect(cachedDocumentStatistics(changed)).toBeUndefined();
    expect(documentStatistics(changed)).toMatchObject({narrationCount:2,dialogueCount:1,averageParagraphLength:3});
    expect(cachedDocumentStatistics(initial.doc)).toBe(value);
  });
});
