/** Bounded in-memory LRU; successful structures only, never API keys or errors. */
export class StructureCache<T> {
  private entries = new Map<string, { value: T; expires: number; bytes: number }>();
  private bytes = 0;
  constructor(private now = Date.now, private ttlMs = 30 * 60_000, private maxEntries = 64, private maxBytes = 20 * 1024 * 1024) {}
  private remove(id: string) {
    const item = this.entries.get(id);
    if (item) { this.bytes -= item.bytes; this.entries.delete(id); }
  }
  get(id: string): T | undefined {
    const item = this.entries.get(id);
    if (!item) return;
    if (item.expires <= this.now()) { this.remove(id); return; }
    this.entries.delete(id); this.entries.set(id, item);
    return item.value;
  }
  set(id: string, value: T) {
    this.remove(id);
    const now = this.now();
    for (const [key, item] of this.entries) if (item.expires <= now) this.remove(key);
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > this.maxBytes) return;
    this.entries.set(id, { value, bytes, expires: now + this.ttlMs }); this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
  }
}
