import type {EditorSession} from '../editor/editorSessionTypes';

type WorkspaceIdentity={id:string;root:string};
type TreeTicket={epoch:number;treeVersion?:string};
export type WorkspaceTreeWarning = { path: string; message: string };
export type WorkspaceTreeReport = { error: string } | { warnings?: WorkspaceTreeWarning[] };
export type WorkspaceTreeStatus = { ready: boolean; error: string; warnings: WorkspaceTreeWarning[] };
export const initialWorkspaceTreeStatus: WorkspaceTreeStatus = { ready: false, error: '', warnings: [] };

export function applyWorkspaceTreeReport(current: WorkspaceTreeStatus, report: WorkspaceTreeReport): WorkspaceTreeStatus {
    if ('error' in report) return current.error === report.error ? current : { ...current, error: report.error };
    const warnings = report.warnings ?? [];
    if (current.ready && !current.error && current.warnings.length === warnings.length &&
        current.warnings.every((warning, index) => warning.path === warnings[index].path && warning.message === warnings[index].message)) return current;
    return { ready: true, error: '', warnings };
}

/** One cursor per mounted file tree. A repository switch never reuses its predecessor's cursor. */
export class WorkspaceTreeSync {
    private identity='';
    private workspaceEpoch=0;
    private epoch=0;
    private treeVersion:string|undefined;
    private refreshing=false;
    select(workspace?:WorkspaceIdentity) {
        const identity=workspace?JSON.stringify([workspace.id,workspace.root]):'';
        if(identity!==this.identity){this.identity=identity;this.workspaceEpoch++;this.epoch++;this.treeVersion=undefined;this.refreshing=false;}
        return this;
    }
    beginSync():TreeTicket|undefined {
        return this.refreshing?undefined:{epoch:this.epoch,treeVersion:this.treeVersion};
    }
    owner() {return this.workspaceEpoch;}
    owns(workspace:WorkspaceIdentity,owner=this.workspaceEpoch) {
        return owner===this.workspaceEpoch&&(!this.identity||JSON.stringify([workspace.id,workspace.root])===this.identity);
    }
    current(ticket:TreeTicket,workspace?:WorkspaceIdentity) {
        return ticket.epoch===this.epoch&&!this.refreshing&&(!workspace||this.owns(workspace));
    }
    accept(ticket:TreeTicket,treeVersion?:string) {
        if(!this.current(ticket))return false;
        this.treeVersion=treeVersion;
        return true;
    }
    beginRefresh():TreeTicket {
        this.epoch++;this.treeVersion=undefined;this.refreshing=true;
        return {epoch:this.epoch};
    }
    finishRefresh(ticket:TreeTicket,treeVersion?:string) {
        if(ticket.epoch!==this.epoch||!this.refreshing)return false;
        this.refreshing=false;this.treeVersion=treeVersion;
        return true;
    }
}

const trees=new WeakMap<object,WorkspaceTreeSync>();
export function workspaceTreeSync(owner:object,workspace?:WorkspaceIdentity) {
    let tree=trees.get(owner);
    if(!tree){tree=new WorkspaceTreeSync();trees.set(owner,tree);}
    return tree.select(workspace);
}

/** A shared path is only eligible for the unchanged shortcut when all owners agree. */
export function documentSyncBaselines(sessions:Iterable<EditorSession>) {
    const baselines=new Map<string,string>(),disputed=new Set<string>();
    for(const session of sessions){
        const disk=session.disk;if(!disk)continue;
        if(baselines.has(disk.path)&&baselines.get(disk.path)!==disk.hash)disputed.add(disk.path);
        baselines.set(disk.path,disk.hash);
    }
    const knownBaselines:Record<string,string>=Object.fromEntries([...baselines].filter(([path])=>!disputed.has(path)));
    return {paths:[...baselines.keys()],baselines,knownBaselines};
}

/** Schedule after completion, so slow disk scans cannot queue polling work. */
export function pollAfterCompletion(run:()=>Promise<void>,delay:number) {
    let stopped=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{await run();}finally{if(!stopped)timer=setTimeout(()=>void poll(),delay);}};
    timer=setTimeout(()=>void poll(),delay);
    return ()=>{stopped=true;clearTimeout(timer);};
}
