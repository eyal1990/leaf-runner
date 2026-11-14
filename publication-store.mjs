import { join } from 'node:path';
import { transaction, readRecord, JobPersistenceError } from './job-store.mjs';
import { save, digest, json } from './runner-state.mjs';
import { leanTokens } from './lean-artifacts.mjs';

export function publicationEntries(plan, target) {
  return plan.ordered.map(artifact => {
    const name = artifact.theorem_name ?? artifact.definition_name, kind = artifact.definition ? 'definition' : 'problem';
    return { name, nameKey: digest(json([target.mathlib_rev, name])),
      key: digest(json({ name, kind, env: target.mathlib_rev, code: leanTokens(artifact.definition ?? `${artifact.preamble}\n${artifact.formal_statement}`) })) };
  });
}

// Names are reserved across all theorem journals in this runner account.
// Network actions never run inside the store transaction.
export class PublicationStore {
  constructor(runs) { this.runs = runs; this.path = join(runs, 'publication-reservations.json'); }
  async reserve(entries, owner) {
    return transaction(this.runs, async () => {
      const store = await readRecord(this.path) ?? { schema_version: 1, names: {} };
      if (store.schema_version !== 1 || !store.names) throw new JobPersistenceError('Invalid publication reservation store');
      const requested = new Map();
      for (const entry of entries) {
        if (requested.has(entry.nameKey) && requested.get(entry.nameKey) !== entry.key) throw new Error(`Conflicting cross-job dependency declaration: ${entry.name}`);
        requested.set(entry.nameKey, entry.key);
        const previous = store.names[entry.nameKey];
        if (previous && previous.key !== entry.key && !['ERROR', 'FAILED', 'REJECTED'].includes(previous.journal?.status)) {
          throw new Error(`Conflicting cross-job dependency declaration: ${entry.name}`);
        }
      }
      const result = new Map();
      for (const entry of entries) {
        let reservation = store.names[entry.nameKey];
        if (!reservation || reservation.key !== entry.key) {
          reservation = store.names[entry.nameKey] = { ...entry, owner, status: 'RESERVED' };
        }
        result.set(entry.key, structuredClone(reservation));
      }
      await save(this.path, store); return result;
    });
  }
  async record(entries, owner, publications) {
    return transaction(this.runs, async () => {
      const store = await readRecord(this.path);
      for (const entry of entries) {
        const reservation = store?.names[entry.nameKey], journal = publications[entry.key];
        if (!journal) continue;
        if (!reservation || reservation.key !== entry.key) throw new Error('Publication reservation changed');
        // An observer may save reconciled results, but cannot regress a known ID.
        if (reservation.owner !== owner &&
            (reservation.journal?.theorem_id && !journal.theorem_id || reservation.journal?.job_id && !journal.job_id)) continue;
        reservation.journal = structuredClone(journal); reservation.status = journal.status;
      }
      await save(this.path, store);
    });
  }
  async begin(entry, owner, journal) {
    return transaction(this.runs, async () => {
      const store = await readRecord(this.path), reservation = store?.names[entry.nameKey];
      if (!reservation || reservation.key !== entry.key) throw new Error('Publication reservation changed');
      if (reservation.journal && reservation.journal.status !== 'ERROR' ||
          !reservation.journal && reservation.owner !== owner) return false;
      reservation.owner = owner; reservation.journal = structuredClone(journal); reservation.status = 'PUBLISHING';
      await save(this.path, store); return true;
    });
  }
  async releaseUnused(owner) {
    return transaction(this.runs, async () => {
      const store = await readRecord(this.path);
      if (!store) return;
      for (const [key, reservation] of Object.entries(store.names)) {
        if (reservation.owner === owner && !reservation.journal) delete store.names[key];
      }
      await save(this.path, store);
    });
  }
}
