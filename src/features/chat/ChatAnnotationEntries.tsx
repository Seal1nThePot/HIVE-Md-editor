import { Highlighter } from 'lucide-react';
import type { SubmittedAnnotation } from '../annotations/annotations';
import type { ChatAnnotationBatch } from './chatTypes';

function sourceLabel(item: SubmittedAnnotation) {
  return item.source === 'scratch' ? '草稿' : item.file.split('/').at(-1) ?? item.file;
}

function excerpt(text: string) {
  const characters = Array.from(text.replace(/\s+/g, ' ').trim());
  return characters.slice(0, 22).join('') + (characters.length > 22 ? '…' : '');
}

type Props = {
  batch: ChatAnnotationBatch;
  onLocate: (item: SubmittedAnnotation) => void;
  onOpenBatch: () => void;
};

export function ChatAnnotationEntries({ batch, onLocate, onOpenBatch }: Props) {
  return <div className="chat-annotation-entries" aria-label="已提交的标注">
    {batch.items.length >= 6
      ? <button type="button" onClick={onOpenBatch}><Highlighter size={12} aria-hidden/><span>查看 {batch.items.length} 条标注</span></button>
      : batch.items.map((item, index) => <button type="button" key={item.id}
          aria-label={`定位标注 ${index + 1} · ${sourceLabel(item)}`}
          title={item.source === 'document' ? item.file : undefined}
          onClick={() => onLocate(item)}><Highlighter size={12} aria-hidden/><span>{index + 1} · {excerpt(item.original)}</span></button>)}
  </div>;
}

export function ChatAnnotationBatchView({ batch, onLocate, onBack }: Omit<Props, 'onOpenBatch'> & { onBack: () => void }) {
  return <section className="annotation-panel annotation-title-panel chat-annotation-batch" aria-label="对话中的标注批次">
    <header className="chat-annotation-batch-header">
      <strong>{batch.items.length} 条已提交标注</strong>
      <button type="button" className="text-button" onClick={onBack}>返回标注列表</button>
    </header>
    <ol className="annotation-title-list">
      {batch.items.map((item, index) => <li key={item.id}>
        <article>
          <button type="button" className="text-button" onClick={() => onLocate(item)}>
            {index + 1} · {sourceLabel(item)}
          </button>
          <blockquote>{item.original}</blockquote>
          {item.note && <p>{item.note}</p>}
        </article>
      </li>)}
    </ol>
  </section>;
}
