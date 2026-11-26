import {EditorView} from '@codemirror/view';
// Each level has a distinct size. Keeping these values shared makes source/live hierarchy agree.
export const headingTypography=[
  {fontSize:'1.7em',fontWeight:'650',color:'var(--hive-document-text, var(--text))'},
  {fontSize:'1.45em',fontWeight:'600',color:'var(--hive-document-text, var(--text))'},
  {fontSize:'1.25em',fontWeight:'600',color:'var(--hive-document-text, var(--text))'},
  {fontSize:'1.15em',fontWeight:'600',color:'var(--hive-document-text, var(--text))'},
  {fontSize:'1.07em',fontWeight:'600',color:'var(--hive-document-text, var(--text))'},
  {fontSize:'1em',fontWeight:'650',color:'var(--hive-document-text, var(--text))'},
] as const;
const headingRules:Record<string,Record<string,string>>={};
const rendered='&[data-display-mode]:not([data-display-mode=source])';
headingTypography.forEach((style,index)=>{
  headingRules[`.cm-markdown-h${index+1}`]={color:style.color,fontWeight:style.fontWeight};
  headingRules[`&[data-display-mode=source] .cm-markdown-h${index+1}`]={fontSize:style.fontSize};
  headingRules[`${rendered} .cm-line.cm-preview-h${index+1}`]={...style,lineHeight:'1.65',paddingTop:index<2?'8px':'4px',paddingBottom:index<2?'8px':'4px'};
});
export const typographyTheme=EditorView.theme({
  '.cm-scroller':{lineHeight:'var(--hive-line-height, 2.05)'},
  // Keep words and CJK punctuation together when possible. Chromium breaks a
  // token anywhere only if it cannot fit on a line by itself.
  '.cm-content':{maxWidth:'var(--hive-max-width, 780px)',width:'100%',boxSizing:'border-box',minWidth:'0',lineBreak:'strict',wordBreak:'normal',overflowWrap:'anywhere',textWrap:'wrap'},
  // Percentage gutters adapt to each split pane, independent of the main window size.
  '.cm-line':{paddingLeft:'clamp(12px, 6.4%, 50px) !important',paddingRight:'clamp(12px, 6.4%, 50px) !important'},
  [`${rendered} .cm-line.cm-typography-paragraph-end`]:{paddingBottom:'calc(2px + var(--hive-paragraph-spacing, 0em))'},
  [`${rendered} .cm-line.cm-typography-indentable`]:{textIndent:'var(--hive-first-indent, 0em)'},
  [`${rendered} .cm-line.cm-preview-list-line`]:{paddingLeft:'calc(clamp(12px, 6.4%, 50px) + .85em + var(--hive-list-depth, 0) * 1.8em + var(--hive-list-offset, 0) * .6em + var(--hive-list-marker-width, 1.4em)) !important'},
  [`${rendered} .cm-line.cm-preview-list-first`]:{textIndent:'calc(-1 * var(--hive-list-marker-width, 1.4em))'},
  [`${rendered} .cm-preview-bullet, ${rendered} .cm-preview-task`]:{display:'inline-block',width:'var(--hive-list-marker-width, 1.4em)',textIndent:'0',fontSize:'inherit',fontVariantNumeric:'tabular-nums'},
  [`${rendered} .cm-preview-list-source-marker`]:{display:'inline-block',width:'var(--hive-list-marker-width, 1.4em)',textIndent:'0',whiteSpace:'pre',fontVariantNumeric:'tabular-nums'},
  [`${rendered} .cm-preview-list-source-padding`]:{display:'inline-block',width:'0',textIndent:'0',whiteSpace:'pre'},
  // A wrapped inline token must not stretch the preceding CJK text.
  [`${rendered} .cm-line.cm-typography-prose:not(.cm-preview-aligned)`]:{textAlign:'left'},
  [`${rendered} .cm-preview-aligned[style*="center"], ${rendered} .cm-preview-aligned[style*="right"]`]:{textIndent:'0'},
  '.cm-preview-code-line':{textIndent:'0',lineBreak:'auto'},
  ...headingRules,
});
