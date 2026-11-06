/**
 * Snapshot storage. Two backends behind one interface:
 *  - JSONL (default, zero dependencies, works on Node 20+): DATA_PATH=data/snapshots.jsonl
 *  - SQLite via the built-in `node:sqlite` (Node >= 22.13): DATA_PATH=data/snapshots.db
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheckId, CheckStatus, Direction, RouteState } from "./types";

/** Compact per-snapshot record kept for history. */
export interface SnapshotRecord {
  ts: string;
  checks: Partial<Record<CheckId, { s: CheckStatus; r: string | null }>>;
  routes: Record<Direction, RouteState>;
}

export interface SnapshotStore {
  append(rec: SnapshotRecord): Promise<void>;
  /** Records with ts >= since, oldest first. */
  since(since: Date): Promise<SnapshotRecord[]>;
  latest(): Promise<SnapshotRecord | null>;
  close?(): void;
}

export class MemoryStore implements SnapshotStore {
  protected records: SnapshotRecord[] = [];
  async append(rec: SnapshotRecord) {
    this.records.push(rec);
  }
  async since(since: Date) {
    const t = since.getTime();
    return this.records.filter((r) => Date.parse(r.ts) >= t);
  }
  async latest() {
    return this.records.at(-1) ?? null;
  }
}

export class JsonlStore extends MemoryStore {
  private loaded = false;
  constructor(private readonly path: string) {
    super();
  }
  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    let text = "";
    try {
      text = await readFile(this.path, "utf8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.records.push(JSON.parse(line));
      } catch {
        // Skip a torn last line from an unclean shutdown.
      }
    }
    this.records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }
  override async append(rec: SnapshotRecord) {
    await this.load();
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(rec) + "\n", "utf8");
    await super.append(rec);
  }
  override async since(since: Date) {
    await this.load();
    return super.since(since);
  }
  override async latest() {
    await this.load();
    return super.latest();
  }
}

export class SqliteStore implements SnapshotStore {
  private constructor(private readonly db: any) {}

  static async open(path: string): Promise<SqliteStore> {
    const sqlite: any = await import("node:sqlite");
    await mkdir(dirname(path), { recursive: true });
    const db = new sqlite.DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS snapshots (ts TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    return new SqliteStore(db);
  }
  async append(rec: SnapshotRecord) {
    this.db.prepare(`INSERT OR REPLACE INTO snapshots (ts, data) VALUES (?, ?)`).run(rec.ts, JSON.stringify(rec));
  }
  async since(since: Date) {
    const rows = this.db.prepare(`SELECT data FROM snapshots WHERE ts >= ? ORDER BY ts ASC`).all(since.toISOString());
    return rows.map((r: any) => JSON.parse(r.data) as SnapshotRecord);
  }
  async latest() {
    const row = this.db.prepare(`SELECT data FROM snapshots ORDER BY ts DESC LIMIT 1`).get();
    return row ? (JSON.parse(row.data) as SnapshotRecord) : null;
  }
  close() {
    this.db.close();
  }
}

export async function openStore(path: string): Promise<SnapshotStore> {
  if (/\.(db|sqlite3?)$/i.test(path)) {
    try {
      return await SqliteStore.open(path);
    } catch (err) {
      throw new Error(`SQLite storage needs Node >= 22.13 (node:sqlite). Use a .jsonl DATA_PATH instead. (${(err as Error).message})`);
    }
  }
  return new JsonlStore(path);
}
