// AquinTutor spaced-repetition (SRS) — the Tutor tier signature. A genuine SM-2
// scheduler decides WHAT to revise and WHEN: each card carries an ease factor,
// interval and due date, updated on every self-graded recall. Server-persisted
// so the schedule follows the learner across devices. Authored decks, no LLM.
// Self-bootstrapping schema (CREATE IF NOT EXISTS at runtime), consistent with
// the rest of aquintutor-learn.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

// ---- authored decks (front = prompt, back = answer). No company names. ----
export interface Card { id: string; front: string; back: string; }
export interface Deck { id: string; name: string; blurb: string; cards: Card[]; }

export const DECKS: Deck[] = [
  {
    id: 'cs-core', name: 'CS Core (placement + Boards)', blurb: 'Data structures, OS, DBMS, networks and OOP — the facts you must recall cold.',
    cards: [
      { id: 'cs-core-1', front: 'Average and worst-case time to search a balanced binary search tree?', back: 'Both O(log n) — height stays logarithmic when balanced.' },
      { id: 'cs-core-2', front: 'Worst-case time of quicksort, and when does it happen?', back: 'O(n^2), when the pivot is always the smallest/largest (e.g. already-sorted input with a naive pivot).' },
      { id: 'cs-core-3', front: 'Which data structure gives O(1) average insert, delete and lookup?', back: 'A hash table (with a good hash function and low load factor).' },
      { id: 'cs-core-4', front: 'Stack vs queue — one line each.', back: 'Stack = LIFO (last in, first out). Queue = FIFO (first in, first out).' },
      { id: 'cs-core-5', front: 'What does a process control block (PCB) store?', back: 'Process state, program counter, registers, memory limits, open files — the kernel record of a process.' },
      { id: 'cs-core-6', front: 'Define a deadlock and its four necessary (Coffman) conditions.', back: 'A cycle of processes each waiting on another. Conditions: mutual exclusion, hold-and-wait, no preemption, circular wait.' },
      { id: 'cs-core-7', front: 'Difference between a process and a thread.', back: 'A process has its own address space; threads share the process address space and are cheaper to create/switch.' },
      { id: 'cs-core-8', front: 'What is thrashing in virtual memory?', back: 'When the system spends more time paging than executing because working sets exceed physical memory.' },
      { id: 'cs-core-9', front: 'State the ACID properties of a transaction.', back: 'Atomicity, Consistency, Isolation, Durability.' },
      { id: 'cs-core-10', front: 'Difference between a primary key and a foreign key.', back: 'Primary key uniquely identifies a row in its table; a foreign key references a primary key in another table (referential link).' },
      { id: 'cs-core-11', front: 'What does third normal form (3NF) eliminate?', back: 'Transitive dependencies — non-key attributes must depend only on the key, not on other non-key attributes.' },
      { id: 'cs-core-12', front: 'Clustered vs non-clustered index — one line.', back: 'Clustered index defines the physical row order (one per table); non-clustered is a separate structure pointing to rows.' },
      { id: 'cs-core-13', front: 'TCP vs UDP — the core trade-off.', back: 'TCP is reliable, ordered, connection-oriented (handshake, retransmit). UDP is connectionless, unreliable, lower latency.' },
      { id: 'cs-core-14', front: 'What does the three-way handshake establish, and with which flags?', back: 'A TCP connection: SYN -> SYN-ACK -> ACK, synchronising sequence numbers.' },
      { id: 'cs-core-15', front: 'Name the four pillars of object-oriented programming.', back: 'Encapsulation, Abstraction, Inheritance, Polymorphism.' },
      { id: 'cs-core-16', front: 'Overloading vs overriding.', back: 'Overloading = same method name, different parameters (compile-time). Overriding = subclass redefines a parent method (run-time).' },
      { id: 'cs-core-17', front: 'Time complexity of binary search, and its precondition.', back: 'O(log n); the array must be sorted.' },
      { id: 'cs-core-18', front: 'What problem do semaphores solve, and name the two operations.', back: 'They coordinate access to shared resources; operations wait/P (decrement) and signal/V (increment).' },
    ],
  },
];
export const DECK_BY_ID: Record<string, Deck> = Object.fromEntries(DECKS.map((d) => [d.id, d]));

let ready: Promise<void> | null = null;
export function ensureSrsSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_srs_card (
        user_id UUID NOT NULL,
        card_id TEXT NOT NULL,
        deck TEXT NOT NULL,
        ease REAL NOT NULL DEFAULT 2.5,
        interval_days INT NOT NULL DEFAULT 0,
        reps INT NOT NULL DEFAULT 0,
        lapses INT NOT NULL DEFAULT 0,
        due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, card_id))`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

// Seed a deck for a user: insert any cards they don't yet have, all due now.
export async function seedDeck(userId: string, deckId: string): Promise<void> {
  await ensureSrsSchema();
  const deck = DECK_BY_ID[deckId];
  if (!deck) return;
  for (const c of deck.cards) {
    await db.execute(sql`INSERT INTO aq_srs_card (user_id, card_id, deck)
      VALUES (${userId}, ${c.id}, ${deckId}) ON CONFLICT (user_id, card_id) DO NOTHING`).catch(() => {});
  }
}

export interface DueCard extends Card { ease: number; intervalDays: number; reps: number; dueAt: string; }

export async function getDue(userId: string, deckId: string, limit = 60): Promise<DueCard[]> {
  await ensureSrsSchema();
  const deck = DECK_BY_ID[deckId];
  if (!deck) return [];
  const byId: Record<string, Card> = Object.fromEntries(deck.cards.map((c) => [c.id, c]));
  const r = rows(await db.execute(sql`
    SELECT card_id, ease, interval_days, reps, due_at FROM aq_srs_card
    WHERE user_id = ${userId} AND deck = ${deckId} AND due_at <= NOW()
    ORDER BY due_at ASC LIMIT ${limit}`));
  return r.map((row: any) => {
    const c = byId[row.card_id];
    if (!c) return null;
    return { id: c.id, front: c.front, back: c.back, ease: Number(row.ease), intervalDays: Number(row.interval_days), reps: Number(row.reps), dueAt: row.due_at };
  }).filter(Boolean) as DueCard[];
}

export async function getStats(userId: string, deckId: string): Promise<{ total: number; due: number; learning: number; nextDueAt: string | null }> {
  await ensureSrsSchema();
  const r = rows(await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE due_at <= NOW())::int AS due,
      COUNT(*) FILTER (WHERE reps = 0)::int AS learning,
      MIN(due_at) FILTER (WHERE due_at > NOW()) AS next_due
    FROM aq_srs_card WHERE user_id = ${userId} AND deck = ${deckId}`))[0] || {};
  return { total: Number(r.total || 0), due: Number(r.due || 0), learning: Number(r.learning || 0), nextDueAt: r.next_due || null };
}

// SM-2 (Anki-style). grade: 0 (Again) | 3 (Hard) | 4 (Good) | 5 (Easy).
// Pure scheduler shared by the API (persistence) and the client (button
// predictions), so what the learner is shown is exactly what is stored.
export const EASE_DELTA: Record<number, number> = { 0: -0.20, 3: -0.15, 4: 0, 5: 0.15 };
export function schedule(ease: number, reps: number, interval: number, grade: number): { ease: number; reps: number; interval: number; lapse: boolean } {
  const q = [0, 3, 4, 5].includes(grade) ? grade : 4;
  let e = ease + (EASE_DELTA[q] || 0);
  if (e < 1.3) e = 1.3; if (e > 3.0) e = 3.0;
  if (q < 3) return { ease: e, reps: 0, interval: 1, lapse: true }; // relearn tomorrow
  const base = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(interval * ease);
  let iv = base;
  if (q === 3) iv = Math.max(1, Math.round(base * 0.6));
  else if (q === 5) iv = Math.round(base * 1.4);
  return { ease: e, reps: reps + 1, interval: Math.max(1, iv), lapse: false };
}

export async function gradeCard(userId: string, cardId: string, grade: number): Promise<{ intervalDays: number; dueAt: string } | null> {
  await ensureSrsSchema();
  const cur = rows(await db.execute(sql`SELECT ease, interval_days, reps, lapses FROM aq_srs_card WHERE user_id = ${userId} AND card_id = ${cardId} LIMIT 1`))[0];
  if (!cur) return null;
  const n = schedule(Number(cur.ease) || 2.5, Number(cur.reps) || 0, Number(cur.interval_days) || 0, Math.round(grade));
  const lapses = (Number(cur.lapses) || 0) + (n.lapse ? 1 : 0);
  await db.execute(sql`UPDATE aq_srs_card
    SET ease = ${n.ease}, interval_days = ${n.interval}, reps = ${n.reps}, lapses = ${lapses},
        due_at = NOW() + (${n.interval} || ' days')::interval, updated_at = NOW()
    WHERE user_id = ${userId} AND card_id = ${cardId}`);
  return { intervalDays: n.interval, dueAt: new Date(Date.now() + n.interval * 86400000).toISOString() };
}
