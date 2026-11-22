import {describe,expect,it,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {loadTrashDocument,trashPreviewState} from './TrashDocumentPreview';
import {displayModeField,markdownPreview} from '../editor/markdownDisplay';

describe('trash document previews',()=>{
  it('uses the document renderer and rejects edits even through disk sync update events',()=>{
    const text='# 标题\n\n**粗体**和 `$math$`', state=trashPreviewState(text);
    expect(state.readOnly).toBe(true);
    expect(state.facet(EditorView.editable)).toBe(false);
    expect(state.field(displayModeField)).toBe('preview');
    expect(state.field(markdownPreview).size).toBeGreaterThan(0);
    for(const userEvent of ['input.type','input.paste','input.ai.accept','input.disk-sync','input.shared-document']){
      expect(state.update({changes:{from:0,insert:'修改'},userEvent}).state.doc.toString()).toBe(text);
    }
  });

  it('asks the current workspace request to read only the given ID and keeps the server identity',async()=>{
    const snapshot={id:'trash-id',path:'笔记.md',text:'# 旧稿'};
    const request=vi.fn<typeof fetch>().mockResolvedValue(Response.json(snapshot));
    const {signal}=new AbortController();
    await expect(loadTrashDocument(request,snapshot.id,signal)).resolves.toEqual(snapshot);
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/explorer/trash/document?id=trash-id',{signal});
    request.mockResolvedValueOnce(Response.json({...snapshot,id:'other'}));
    await expect(loadTrashDocument(request,snapshot.id)).rejects.toThrow('无效');
  });
});
