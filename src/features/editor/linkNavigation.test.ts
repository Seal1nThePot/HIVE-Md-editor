import {describe,it,expect} from 'vitest';
import {EditorState} from '@codemirror/state';
import {linkAt,resolveLinkTarget} from './linkNavigation';
import {editorColors,normalizeEditorProfiles} from '../theme/editorAppearance';
import {normalizeTheme} from '../theme/themePreferences';
import {pastedDocumentPath} from '../files/localDocumentPath';
describe('document links',()=>{
  it('finds inline and reference targets at the visible label',()=>{
    const text='[中文](../目标%20文档.md#标题) and [引用][ref] and [折叠][]\n\n[ref]: 子/目标.md\n[折叠]: ./next.md';
    const state=EditorState.create({doc:text});
    expect(linkAt(state,text.indexOf('中文'))).toBe('../目标%20文档.md#标题');
    expect(linkAt(state,text.indexOf('引用'))).toBe('子/目标.md');
    expect(linkAt(state,text.indexOf('折叠'))).toBe('./next.md');
  });
  it('resolves encoded relative paths and blocks escapes and protocols',()=>{
    expect(resolveLinkTarget('子/当前.md','../中文%20空格.md#标题')).toBe('中文 空格.md');
    expect(resolveLinkTarget('子/当前.md','目录/目标.md')).toBe('子/目录/目标.md');
    expect(resolveLinkTarget('子/当前.md','#标题')).toBe('子/当前.md');
    for(const path of ['../../外.md','https://example.com/a.md','javascript:alert(1)','%2fsecret.md','C:%5csecret.md'])expect(()=>resolveLinkTarget('子/当前.md',path)).toThrow();
  });
  it('supplies old themes a link color and keeps overrides',()=>{
    expect(editorColors(normalizeTheme(null)).linkText).toBe('#8ab4ff');
    expect(normalizeEditorProfiles({black:{linkText:'#123ABC'}}).black?.linkText).toBe('#123abc');
  });
  it('decodes Markdown destinations while preserving literal pasted Windows paths',()=>{
    expect(resolveLinkTarget('来源.md','<D:/测试%20目录/A%23B.md#标题>')).toBe('D:/测试 目录/A#B.md');
    expect(resolveLinkTarget('','D:\\测试目录\\目标.md')).toBe('D:/测试目录/目标.md');
    expect(resolveLinkTarget('D:/测试目录/目标.md','../本地.md')).toBe('D:/测试目录/../本地.md');
    expect(pastedDocumentPath(' "D:\\测试 目录\\A%20#B.md" ')).toBe('D:\\测试 目录\\A%20#B.md');
    expect(pastedDocumentPath('目标.md')).toBeUndefined();
  });
});
