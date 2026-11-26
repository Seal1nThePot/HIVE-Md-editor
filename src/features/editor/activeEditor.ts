import type { RefObject } from 'react';
import type { EditorSession } from './editorSessionTypes';

/** Imperative editor consumers always read the current session, including after a tab switch. */
export function activeEditor(
  sessions: RefObject<Map<string, EditorSession>>,
  activeId: RefObject<string>,
) {
  const current = () => sessions.current.get(activeId.current);
  return {
    get session() { return current(); },
    view: { get current() { const session=current();return session?.external?null:session?.view??null; } },
    disk: { get current() { return current()?.disk ?? null; } },
    editorState: {
      get current() {
        const session = current();
        return session?.external?null:session?.view?.state ?? session?.state ?? null;
      },
    },
  };
}
