import {matchesShortcut,type ShortcutBindings} from '../settings/shortcuts';

export type ComposerKeyAction='ignore'|'newline'|'send';

/** Enter 发送、Shift+Enter 换行、Ctrl/Cmd+Enter 作为发送别名；输入法组合期间一律不发送。 */
export function composerKeyAction(input:{key:string;shiftKey:boolean;ctrlKey:boolean;metaKey:boolean;altKey?:boolean;isComposing:boolean;disabled:boolean;text:string;hasAttachments?:boolean},bindings:ShortcutBindings={}):ComposerKeyAction{
  if(input.isComposing)return 'ignore';
  if(input.key==='Enter'&&input.shiftKey&&!input.ctrlKey&&!input.metaKey&&!input.altKey)return 'newline';
  if(input.disabled||!input.text.trim()&&!input.hasAttachments)return 'ignore';
  return matchesShortcut(bindings,'sendMessage',{...input,altKey:!!input.altKey})?'send':'ignore';
}
