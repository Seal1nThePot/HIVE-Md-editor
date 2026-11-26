import {describe,it,expect} from 'vitest';
import {csharpLanguage,fencedCodeLanguage,codeLanguageLabel,fencedCodeBody,codeHighlightRanges} from './codeHighlight';
import {javascriptLanguage,jsxLanguage,typescriptLanguage,tsxLanguage} from '@codemirror/lang-javascript';
import {htmlLanguage} from '@codemirror/lang-html';
import {cssLanguage} from '@codemirror/lang-css';
import {jsonLanguage} from '@codemirror/lang-json';

describe('fenced code language selection',()=>{
  it('recognizes explicitly named languages and common aliases',()=>{
    expect(['js','javascript','jsx','ts','typescript','tsx','html','css'].map(fencedCodeLanguage)).toEqual([javascriptLanguage,javascriptLanguage,jsxLanguage,typescriptLanguage,typescriptLanguage,tsxLanguage,htmlLanguage,cssLanguage]);
    expect(fencedCodeLanguage(' TypeScript linenos')).toBe(typescriptLanguage);
    expect(['cs','c#','csharp','Csharp'].map(fencedCodeLanguage)).toEqual([csharpLanguage,csharpLanguage,csharpLanguage,csharpLanguage]);
    expect(fencedCodeLanguage('json')).toBe(jsonLanguage);
  });
  it('keeps unspecified and unsupported languages plain',()=>{
    for(const name of ['', 'python','__proto__'])expect(fencedCodeLanguage(name)).toBeNull();
  });
});

import {parser} from '@lezer/markdown';
describe('code block presentation',()=>{
  it('preserves blank lines, indentation and unclosed code bodies',()=>{
    for(const source of ['```ts\n\n\tconst x=1;\n\n```','```ts\n\n\tconst x=1;\n']){
      const node=parser.parse(source).topNode.firstChild!;
      expect(fencedCodeBody(source,node)).toBe('\n\tconst x=1;\n');
    }
  });
  it('uses safe text labels and only available language parsers',()=>{
    expect(codeLanguageLabel('ts')).toBe('TypeScript');
    expect(codeLanguageLabel('<unsafe>')).toBe('<unsafe>');
    expect(codeHighlightRanges('const value="a";','ts').length).toBeGreaterThan(1);
    expect(codeHighlightRanges('<literal>','<unsafe>')).toEqual([]);
  });
});
