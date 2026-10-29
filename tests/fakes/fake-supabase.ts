// An in-memory stand-in for the Supabase database in supabase/schema.sql, for tests with no live project.
// It answers the SupabaseLike calls the store makes and enforces what the real database enforces:
//   * primary keys and the unique index: booked.opening_id, booked (line_id, person_phone_digits), imports.id,
//     reading_cache.key -> error code 23505 and nothing saved;
//   * the bump_version triggers: +1 per inserted import, per inserted booking and per deleted booking;
//   * undo_booked(p_opening_id): moves the row to booked_history in one step and returns true / false;
//   * timestamptz columns come back the way PostgREST sends them ("2026-10-21T14:00:00+00:00").
// Every call resolves after a short random wait, so concurrent calls interleave like real requests.
import type { DbError, DbResponse, Row, SelectQuery, SupabaseLike, TableLike } from '@/lib/storage/supabase';

type TableName = 'imports' | 'reading_cache' | 'booked' | 'booked_history' | 'app_state';

interface TableSpec {
  unique: string[][];
  /** Columns filled from a counter, like "generated always as identity". */
  identity?: string;
  times?: string[];
  bumpOn?: Array<'insert' | 'delete'>;
}

const SPECS: Record<TableName, TableSpec> = {
  imports: { unique: [['id'], ['seq']], identity: 'seq', times: ['created_at'], bumpOn: ['insert'] },
  reading_cache: { unique: [['key']] },
  booked: { unique: [['opening_id'], ['line_id', 'person_phone_digits']], identity: 'seq', times: ['at'], bumpOn: ['insert', 'delete'] },
  booked_history: { unique: [['id']], identity: 'id', times: ['undone_at'] },
  app_state: { unique: [['id']] },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** How PostgREST writes a timestamptz. */
function pgTime(v: unknown): string {
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) return String(v);
  return new Date(t).toISOString().replace('.000Z', 'Z').replace('Z', '+00:00');
}

const uniqueViolation = (table: string, cols: string[]): DbError => ({
  code: '23505',
  message: `duplicate key value violates unique constraint "${table}_${cols.join('_')}_key"`,
  details: `Key (${cols.join(', ')}) already exists.`,
  hint: null,
});

export class FakeSupabase implements SupabaseLike {
  readonly tables: Record<TableName, Row[]> = {
    imports: [],
    reading_cache: [],
    booked: [],
    booked_history: [],
    app_state: [{ id: 1, version: 0 }],
  };
  private counters: Record<string, number> = {};
  /** Every call, like "insert booked" or "rpc undo_booked", for tests that check what was asked. */
  readonly calls: string[] = [];
  /** The next call fails with this error (for "a failed save changes nothing" tests). */
  failNext: DbError | null = null;

  constructor(private readonly maxDelayMs = 3) {}

  async wait(): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * (this.maxDelayMs + 1))));
  }

  takeFailure(): DbError | null {
    const f = this.failNext;
    this.failNext = null;
    return f;
  }

  private table(name: string): Row[] {
    if (!(name in this.tables)) throw new Error(`fake: no table ${name}`);
    return this.tables[name as TableName];
  }

  private bump(): void {
    const row = this.tables.app_state[0];
    if (row) row.version = Number(row.version) + 1; // like the trigger's UPDATE: no row, nothing to bump
  }

  /** Adds a row the way Postgres would (all or nothing). Returns an error instead of saving on a clash. */
  insertRow(name: string, input: Row, onConflict?: string): DbError | null {
    const rows = this.table(name);
    const spec = SPECS[name as TableName];
    const row: Row = clone(input);
    if (spec.identity) {
      if (row[spec.identity] !== undefined) return { code: '428C9', message: `cannot insert a non-DEFAULT value into column "${spec.identity}"` };
    }
    for (const col of spec.times ?? []) if (row[col] !== undefined) row[col] = pgTime(row[col]);
    if (name === 'booked_history' && row.undone_at === undefined) row.undone_at = pgTime(new Date().toISOString());
    if (onConflict) {
      const cols = onConflict.split(',').map((c) => c.trim());
      const at = rows.findIndex((r) => cols.every((c) => r[c] === row[c]));
      if (at >= 0) {
        rows[at] = { ...rows[at], ...row };
        return null;
      }
    }
    for (const cols of spec.unique) {
      if (spec.identity && cols.length === 1 && cols[0] === spec.identity) continue;
      if (rows.some((r) => cols.every((c) => r[c] === row[c]))) return uniqueViolation(name, cols);
    }
    if (spec.identity) {
      this.counters[name] = (this.counters[name] ?? 0) + 1;
      row[spec.identity] = this.counters[name];
    }
    rows.push(row);
    if (spec.bumpOn?.includes('insert')) this.bump();
    return null;
  }

  from(table: string): TableLike {
    this.table(table);
    return new FakeTable(this, table);
  }

  async rpc(fn: string, args: Record<string, unknown> = {}): Promise<DbResponse<unknown>> {
    this.calls.push(`rpc ${fn}`);
    await this.wait();
    const failure = this.takeFailure();
    if (failure) return { data: null, error: failure };
    if (fn !== 'undo_booked') return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
    const openingId = String(args.p_opening_id ?? '');
    const booked = this.tables.booked;
    const at = booked.findIndex((r) => r.opening_id === openingId);
    if (at < 0) return { data: false, error: null };
    const [row] = booked.splice(at, 1);
    this.bump(); // the delete trigger
    this.insertRow('booked_history', {
      record: {
        personPhoneDigits: row!.person_phone_digits,
        personName: row!.person_name,
        lineId: row!.line_id,
        openingId: row!.opening_id,
        at: new Date(String(row!.at)).toISOString(),
        by: row!.by,
      },
    });
    return { data: true, error: null };
  }
}

class FakeTable implements TableLike {
  constructor(
    private readonly db: FakeSupabase,
    private readonly name: string,
  ) {}

  select(columns = '*'): SelectQuery {
    this.db.calls.push(`select ${this.name}`);
    return new FakeSelect(this.db, this.name, columns);
  }

  insert(row: Row): PromiseLike<DbResponse<unknown>> {
    this.db.calls.push(`insert ${this.name}`);
    return this.write(row);
  }

  upsert(row: Row, options: { onConflict?: string } = {}): PromiseLike<DbResponse<unknown>> {
    this.db.calls.push(`upsert ${this.name}`);
    return this.write(row, options.onConflict ?? SPECS[this.name as TableName].unique[0]!.join(','));
  }

  private async write(row: Row, onConflict?: string): Promise<DbResponse<unknown>> {
    await this.db.wait();
    const failure = this.db.takeFailure();
    if (failure) return { data: null, error: failure };
    const error = this.db.insertRow(this.name, row, onConflict);
    return { data: null, error };
  }
}

class FakeSelect implements SelectQuery {
  private filters: Array<[string, unknown]> = [];
  private orders: Array<[string, boolean]> = [];
  private from = 0;
  private to = Infinity;

  constructor(
    private readonly db: FakeSupabase,
    private readonly name: string,
    private readonly columns: string,
  ) {}

  eq(column: string, value: string | number): SelectQuery {
    this.filters.push([column, value]);
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): SelectQuery {
    this.orders.push([column, options.ascending !== false]);
    return this;
  }

  range(from: number, to: number): SelectQuery {
    this.from = from;
    this.to = to;
    return this;
  }

  limit(count: number): SelectQuery {
    this.to = this.from + count - 1;
    return this;
  }

  private rows(): Row[] {
    const all = (this.db.tables as Record<string, Row[]>)[this.name]!;
    let rows = all.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    rows = [...rows].sort((a, b) => {
      for (const [c, asc] of this.orders) {
        const x = a[c] as string | number;
        const y = b[c] as string | number;
        const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        if (cmp !== 0) return asc ? cmp : -cmp;
      }
      return 0;
    });
    rows = rows.slice(this.from, this.to === Infinity ? undefined : this.to + 1);
    const cols = this.columns.split(',').map((c) => c.trim());
    return rows.map((r) => (cols.includes('*') ? clone(r) : clone(Object.fromEntries(cols.map((c) => [c, r[c]])))));
  }

  private async run(): Promise<DbResponse<Row[]>> {
    await this.db.wait();
    const failure = this.db.takeFailure();
    if (failure) return { data: null, error: failure };
    return { data: this.rows(), error: null };
  }

  then<A = DbResponse<Row[]>, B = never>(
    onFulfilled?: ((value: DbResponse<Row[]>) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onFulfilled, onRejected);
  }

  maybeSingle(): PromiseLike<DbResponse<Row>> {
    return this.run().then((res) => {
      if (res.error) return { data: null, error: res.error };
      const rows = res.data ?? [];
      if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple rows returned' } };
      return { data: rows[0] ?? null, error: null };
    });
  }
}
