export type PanelCategory = 'files' | 'documents' | 'writing' | 'ai' | 'tools';
export type PanelItem = { id:string; label:string; open:boolean; fixed?:boolean; locked?:boolean; category?:PanelCategory; description?:string; keywords?:string[] };
export const panelCategories: { id:PanelCategory; label:string }[] = [
  {id:'files',label:'文件管理'}, {id:'documents',label:'正文编辑区'}, {id:'writing',label:'写作辅助'}, {id:'ai',label:'AI'}, {id:'tools',label:'工具'},
];
export function panelCategory(item:PanelItem):PanelCategory {
  if (item.category) return item.category;
  const id=item.id.toLowerCase();
  if (['files','file','quick-open','trash'].includes(id)) return 'files';
  if (id === 'editor' || id.startsWith('editor-') || id.startsWith('editor:') || item.fixed) return 'documents';
  if (['outline','toc','draft','scratch','annotations','annotation'].includes(id)) return 'writing';
  if (['chat','conversation','basis'].includes(id)) return 'ai';
  return 'tools';
}
export function filterPanels(items:PanelItem[], category:PanelCategory|'all', query:string):PanelItem[] {
  const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => {
    if (!words.length && category !== 'all' && panelCategory(item) !== category) return false;
    const text=[item.label,item.description ?? '',...(item.keywords ?? [])].join(' ').toLocaleLowerCase();
    return words.every(word=>text.includes(word));
  });
}
export function groupPanels(items:PanelItem[]):Record<PanelCategory,PanelItem[]> {
  const groups:Record<PanelCategory,PanelItem[]>={files:[],documents:[],writing:[],ai:[],tools:[]};
  for (const item of items) groups[panelCategory(item)].push(item);
  return groups;
}
