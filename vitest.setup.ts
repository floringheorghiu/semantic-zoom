// Node 22+'s native (experimental) `localStorage` global requires
// `--localstorage-file` and otherwise silently returns `undefined` for every
// read. Under vitest's jsdom environment `window === globalThis`, so this
// native getter shadows jsdom's own per-window Storage implementation.
// Replace it with a plain in-memory polyfill so `localStorage`-backed code
// (state/recent-files.ts) is testable without touching a real file.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  enumerable: false,
  value: new MemoryStorage(),
});

// jsdom doesn't implement HTMLDialogElement.showModal() / close() natively.
// Add minimal polyfills so update-dialog tests can work.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    (this as any).open = true;
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function () {
    (this as any).open = false;
  };
}
