type Transfer = { receivedBytes: number; totalBytes: number | null };

export type UpdateProgress = { phase: 'idle' | 'checking' }
  | ({ phase: 'downloading' | 'downloaded' } & Transfer)
  | ({ phase: 'restarting' } & Partial<Transfer>)
  | { phase: 'error'; message: string };
