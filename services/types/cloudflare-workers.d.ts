/**
 * The subset of `cloudflare:workers` these services use. Committed rather than pulled from
 * `@cloudflare/workers-types` so the services tree has no dependencies and the same types
 * apply on Cloudflare, celld and the native engine.
 */

declare module "cloudflare:workers" {
  export interface SqlStorageCursor<T> extends Iterable<T> {
    toArray(): T[];
    one(): T;
    readonly rowsRead: number;
  }

  export interface SqlStorage {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
  }

  export interface DurableObjectStorage {
    readonly sql: SqlStorage;
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    deleteAll(): Promise<void>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
    transactionSync<T>(callback: () => T): T;
  }

  export interface DurableObjectId {
    toString(): string;
    readonly name?: string;
  }

  export interface DurableObjectState {
    readonly id: DurableObjectId;
    readonly storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
    acceptWebSocket(webSocket: WebSocket): void;
  }

  export interface DurableObjectNamespace<T = unknown> {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): T;
    getByName(name: string): T;
  }

  export class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }

  export class WorkerEntrypoint<Env = unknown> {
    protected readonly ctx: unknown;
    protected readonly env: Env;
    constructor(ctx: unknown, env: Env);
  }

  export const env: unknown;
}
