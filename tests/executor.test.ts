import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { createMutationExecutor } from '../src/data.js';

function connection() {
  return { transaction: vi.fn(async (fn: () => Promise<unknown>) => fn()) } as unknown as Pick<Connection, 'transaction'>;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('exécuteurs de mutations', () => {
  it('garde le chemin transactionnel par défaut, sans modifier les autres exécuteurs', async () => {
    const db = connection();
    const transactional = createMutationExecutor(undefined, db);
    const standalone = createMutationExecutor(false, db);
    expect(await standalone(async () => 1)).toBe(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(await transactional(async () => 2)).toBe(2);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('sérialise FIFO plusieurs exécuteurs de la même connexion', async () => {
    const db = connection();
    const first = createMutationExecutor(false, db);
    const second = createMutationExecutor(false, db);
    const blocked = gate();
    const events: string[] = [];
    const a = first(async () => { events.push('a:start'); await blocked.promise; events.push('a:end'); return 1; });
    const b = second(async () => { events.push('b'); return 2; });
    await Promise.resolve();
    expect(events).toEqual(['a:start']);
    blocked.release();
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(events).toEqual(['a:start', 'a:end', 'b']);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('libère après erreur, ne réessaie jamais et ne simule aucun rollback', async () => {
    const execute = createMutationExecutor(false, connection());
    const writes: string[] = [];
    const failure = new Error('failure');
    const action = vi.fn(async () => { writes.push('partial'); throw failure; });
    const rejected = execute(action);
    const next = execute(async () => { writes.push('next'); return 'ok'; });
    await expect(rejected).rejects.toBe(failure);
    expect(await next).toBe('ok');
    expect(action).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(['partial', 'next']);
  });

  it('ne bloque pas une autre connexion', async () => {
    const blocked = gate();
    const a = createMutationExecutor(false, connection())(async () => blocked.promise);
    try {
      expect(await createMutationExecutor(false, connection())(async () => 42)).toBe(42);
    } finally { blocked.release(); await a; }
  });

  it('ne dégrade jamais une erreur transactionnelle en exécution standalone', async () => {
    const db = connection();
    const error = { code: 20, errorLabels: ['IllegalOperation'] };
    const action = vi.fn(async () => { throw error; });
    await expect(createMutationExecutor(true, db)(action)).rejects.toBe(error);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });
});