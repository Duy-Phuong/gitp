// The Code tab's open files: an ordered list, the active one, and per-file
// flags the tab strip shows (unsaved dot, changed on disk, deleted). Pure
// state; the strip renders from `onChange`.

export interface TabInfo {
  path: string;
  dirty: boolean;
  changedOnDisk: boolean;
  deleted: boolean;
  // What the file had when read or last saved; a save presents it back.
  mtime: number;
  crlf: boolean;
}

export class Tabs {
  private tabs: TabInfo[] = [];
  private current: string | null = null;
  private listeners: ((tabs: TabInfo[], active: string | null) => void)[] = [];

  /// Open (or just activate) `path`.
  open(path: string, info: Omit<TabInfo, "path">): void {
    if (!this.tabs.some((t) => t.path === path)) this.tabs.push({ path, ...info });
    this.current = path;
    this.emit();
  }

  /// Close `path`; returns the path that is active afterwards.
  close(path: string): string | null {
    const i = this.tabs.findIndex((t) => t.path === path);
    if (i < 0) return this.current;
    this.tabs.splice(i, 1);
    if (this.current === path) {
      const next = this.tabs[i - 1] ?? this.tabs[i] ?? null;
      this.current = next?.path ?? null;
    }
    this.emit();
    return this.current;
  }

  active(): string | null {
    return this.current;
  }

  list(): TabInfo[] {
    return this.tabs.map((t) => ({ ...t }));
  }

  get(path: string): TabInfo | undefined {
    const t = this.tabs.find((t) => t.path === path);
    return t && { ...t };
  }

  setDirty(path: string, on: boolean): void {
    this.set(path, (t) => (t.dirty = on));
  }

  setChangedOnDisk(path: string, on: boolean): void {
    this.set(path, (t) => (t.changedOnDisk = on));
  }

  setDeleted(path: string, on: boolean): void {
    this.set(path, (t) => (t.deleted = on));
  }

  setMtime(path: string, mtime: number): void {
    this.set(path, (t) => (t.mtime = mtime));
  }

  onChange(cb: (tabs: TabInfo[], active: string | null) => void): void {
    this.listeners.push(cb);
  }

  private set(path: string, mutate: (t: TabInfo) => void): void {
    const t = this.tabs.find((t) => t.path === path);
    if (!t) return;
    mutate(t);
    this.emit();
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this.list(), this.current);
  }
}
