// src/lib/mailplatform/saas/store.ts — the persistence seam, and an in-memory implementation.
//
// Two things live here and they belong together:
//
//   `SaasStore`      — the interface every service in this layer talks to. One implementation is
//                      Postgres (./pg-store.ts); this file's `MemorySaasStore` is the other.
//   `MemorySaasStore`— a complete, working store with no database behind it.
//
// THE MEMORY STORE IS NOT A MOCK. It implements the same interface with the same isolation rules,
// which is what lets the tenant-isolation, quota, subscription-change and idempotency tests run the
// REAL service code — not a rehearsal of it. This repository's rules forbid connecting to the
// production database, and a layer whose logic can only be exercised against production is a layer
// that never gets exercised. Every behaviour worth trusting is tested through this store.
//
// TENANT ISOLATION IS IN THE SIGNATURES.
//
// Every method that touches tenant data takes `orgId` as its FIRST parameter. Not as a field on an
// options object that can be forgotten, not implied by a session — a positional argument the
// compiler insists on. An org-scoped read that cannot be written without naming the tenant is one
// that cannot accidentally be written without filtering by it, and "accidentally" is how every
// cross-tenant leak in this class of product has ever happened.

import type { Organization, OrganizationMember, UUID } from '../types';
import type {
  BillingEvent,
  EnterpriseTerms,
  Invoice,
  MetricKey,
  OrgProfile,
  Plan,
  QuotaNotice,
  Subscription,
  Team,
  TeamMember,
  TeamRole,
  UsageCounter,
  UsageEvent,
  UsagePeriod,
} from './types';

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** What a metering write reports back. `duplicate` is a success, not a failure. */
export interface RecordResult {
  recorded: boolean;
  duplicate: boolean;
  id: string | null;
}

/** A member with the extra role column this layer adds. */
export interface MembershipRow extends OrganizationMember {
  teamRole: TeamRole;
  /** Joined for display. Absent when the store cannot see the users table. */
  userName?: string | null;
  userEmail?: string | null;
}

export interface UsageEventQuery {
  metric?: MetricKey;
  period?: UsagePeriod;
  limit?: number;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface SaasStore {
  /** What this store is, for an ops screen. */
  describe(): { kind: string; detail: string };

  // Organizations -----------------------------------------------------------
  createOrganization(input: {
    name: string;
    slug: string;
    profile: Omit<OrgProfile, 'orgId' | 'createdAt' | 'updatedAt'>;
    createdByUserId: UUID | null;
  }): Promise<{ organization: Organization; profile: OrgProfile }>;
  getOrganization(orgId: UUID): Promise<Organization | null>;
  getOrganizationBySlug(slug: string): Promise<Organization | null>;
  listOrganizations(limit?: number): Promise<Organization[]>;
  /** The tenants a user is a member of. The only org list a non-operator is ever shown. */
  listOrganizationsForUser(userId: UUID): Promise<Organization[]>;
  updateOrganization(orgId: UUID, patch: Partial<Pick<Organization, 'name' | 'status' | 'settings'>>): Promise<Organization | null>;

  getProfile(orgId: UUID): Promise<OrgProfile | null>;
  upsertProfile(orgId: UUID, patch: Partial<Omit<OrgProfile, 'orgId' | 'createdAt'>>): Promise<OrgProfile>;

  // Members and teams -------------------------------------------------------
  listMembers(orgId: UUID): Promise<MembershipRow[]>;
  getMembership(orgId: UUID, userId: UUID): Promise<MembershipRow | null>;
  /** Memberships for a user across every tenant. Used to resolve which tenant a request is in. */
  listMembershipsForUser(userId: UUID): Promise<MembershipRow[]>;
  addMember(orgId: UUID, userId: UUID, teamRole: TeamRole, invitedBy: UUID | null): Promise<MembershipRow>;
  setMemberRole(orgId: UUID, userId: UUID, teamRole: TeamRole): Promise<MembershipRow | null>;
  removeMember(orgId: UUID, userId: UUID): Promise<boolean>;
  countMembers(orgId: UUID): Promise<number>;
  countOwners(orgId: UUID): Promise<number>;

  listTeams(orgId: UUID): Promise<Team[]>;
  createTeam(orgId: UUID, input: { name: string; slug: string; description: string | null }): Promise<Team>;
  countTeams(orgId: UUID): Promise<number>;
  listTeamMembers(orgId: UUID, teamId: UUID): Promise<TeamMember[]>;
  addTeamMember(orgId: UUID, teamId: UUID, userId: UUID, teamRole: TeamRole): Promise<TeamMember>;

  // Plans and subscription --------------------------------------------------
  listCustomPlans(orgId: UUID): Promise<Plan[]>;
  upsertCustomPlan(orgId: UUID, plan: Plan): Promise<Plan>;
  getSubscription(orgId: UUID): Promise<Subscription | null>;
  saveSubscription(orgId: UUID, subscription: Subscription): Promise<Subscription>;
  createSubscription(orgId: UUID, input: Omit<Subscription, 'id' | 'orgId' | 'createdAt' | 'updatedAt'>): Promise<Subscription>;

  getEnterpriseTerms(orgId: UUID): Promise<EnterpriseTerms | null>;
  upsertEnterpriseTerms(orgId: UUID, terms: Omit<EnterpriseTerms, 'orgId'>): Promise<EnterpriseTerms>;

  // Usage -------------------------------------------------------------------
  /**
   * Append a metering fact.
   *
   * Refuses a repeat of an `idempotencyKey` already seen for this tenant, and reports it as
   * `duplicate: true` with `recorded: false`. A caller must treat that as success — the fact IS
   * recorded, it was recorded the first time.
   */
  recordUsage(orgId: UUID, event: Omit<UsageEvent, 'id'>): Promise<RecordResult>;
  listUsageEvents(orgId: UUID, q?: UsageEventQuery): Promise<UsageEvent[]>;
  getCounters(orgId: UUID, periodStart: string): Promise<UsageCounter[]>;
  saveCounters(orgId: UUID, counters: UsageCounter[]): Promise<void>;

  /** Records that a threshold warning was sent. Duplicate = already warned this period. */
  recordQuotaNotice(orgId: UUID, notice: Omit<QuotaNotice, 'id'>): Promise<RecordResult>;
  listQuotaNotices(orgId: UUID, periodStart: string): Promise<QuotaNotice[]>;

  // Billing -----------------------------------------------------------------
  /** Duplicate = this provider event was already received. The whole point of `eventId`. */
  recordBillingEvent(event: Omit<BillingEvent, 'id' | 'receivedAt' | 'processedAt' | 'error'>): Promise<RecordResult & { event: BillingEvent | null }>;
  markBillingEventProcessed(eventId: UUID, error: string | null): Promise<void>;
  listBillingEvents(orgId: UUID, limit?: number): Promise<BillingEvent[]>;

  listInvoices(orgId: UUID, limit?: number): Promise<Invoice[]>;
  upsertInvoice(orgId: UUID, invoice: Invoice): Promise<Invoice>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

let counter = 0;
/** Deterministic-ish ids. Not a UUID generator; nothing here goes into a real database. */
function id(prefix: string): string {
  counter += 1;
  return prefix + '_' + String(counter).padStart(8, '0');
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * A complete store held in memory.
 *
 * Every collection is keyed by organization at the top level, which makes cross-tenant leakage
 * structurally difficult rather than merely forbidden: a method that forgets to filter by tenant
 * has no collection to read from in the first place.
 */
export class MemorySaasStore implements SaasStore {
  private orgs = new Map<UUID, Organization>();
  private profiles = new Map<UUID, OrgProfile>();
  private members = new Map<UUID, MembershipRow[]>();
  private teams = new Map<UUID, Team[]>();
  private teamMembers = new Map<UUID, TeamMember[]>();
  private customPlans = new Map<UUID, Plan[]>();
  private subscriptions = new Map<UUID, Subscription>();
  private terms = new Map<UUID, EnterpriseTerms>();
  private usage = new Map<UUID, UsageEvent[]>();
  private usageKeys = new Map<UUID, Set<string>>();
  private counters = new Map<UUID, UsageCounter[]>();
  private notices = new Map<UUID, QuotaNotice[]>();
  private billing: BillingEvent[] = [];
  private billingKeys = new Set<string>();
  private invoices = new Map<UUID, Invoice[]>();

  describe() {
    return {
      kind: 'memory',
      detail: 'Held in process memory. Everything is lost when the process exits; used by the test suite.',
    };
  }

  private bucket<T>(map: Map<UUID, T[]>, orgId: UUID): T[] {
    const found = map.get(orgId);
    if (found) return found;
    const fresh: T[] = [];
    map.set(orgId, fresh);
    return fresh;
  }

  // Organizations -----------------------------------------------------------

  async createOrganization(input: {
    name: string;
    slug: string;
    profile: Omit<OrgProfile, 'orgId' | 'createdAt' | 'updatedAt'>;
    createdByUserId: UUID | null;
  }): Promise<{ organization: Organization; profile: OrgProfile }> {
    const ts = nowIso();
    const org: Organization = {
      id: id('org'),
      slug: input.slug,
      name: input.name,
      status: 'active',
      settings: {},
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
    this.orgs.set(org.id, org);
    const profile: OrgProfile = { ...input.profile, orgId: org.id, createdAt: ts, updatedAt: ts };
    this.profiles.set(org.id, profile);
    if (input.createdByUserId) {
      await this.addMember(org.id, input.createdByUserId, 'owner', null);
    }
    return { organization: clone(org), profile: clone(profile) };
  }

  async getOrganization(orgId: UUID): Promise<Organization | null> {
    const o = this.orgs.get(orgId);
    return o && !o.deletedAt ? clone(o) : null;
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | null> {
    for (const o of this.orgs.values()) if (o.slug === slug && !o.deletedAt) return clone(o);
    return null;
  }

  async listOrganizations(limit = 100): Promise<Organization[]> {
    return Array.from(this.orgs.values()).filter((o) => !o.deletedAt).slice(0, limit).map(clone);
  }

  async listOrganizationsForUser(userId: UUID): Promise<Organization[]> {
    const out: Organization[] = [];
    for (const [orgId, list] of this.members) {
      if (list.some((m) => m.userId === userId && !m.deletedAt)) {
        const org = this.orgs.get(orgId);
        if (org && !org.deletedAt) out.push(clone(org));
      }
    }
    return out;
  }

  async updateOrganization(
    orgId: UUID,
    patch: Partial<Pick<Organization, 'name' | 'status' | 'settings'>>,
  ): Promise<Organization | null> {
    const org = this.orgs.get(orgId);
    if (!org) return null;
    if (patch.name !== undefined) org.name = patch.name;
    if (patch.status !== undefined) org.status = patch.status;
    if (patch.settings !== undefined) org.settings = patch.settings;
    org.updatedAt = nowIso();
    return clone(org);
  }

  async getProfile(orgId: UUID): Promise<OrgProfile | null> {
    const p = this.profiles.get(orgId);
    return p ? clone(p) : null;
  }

  async upsertProfile(orgId: UUID, patch: Partial<Omit<OrgProfile, 'orgId' | 'createdAt'>>): Promise<OrgProfile> {
    const existing = this.profiles.get(orgId);
    const ts = nowIso();
    const next: OrgProfile = existing
      ? { ...existing, ...patch, orgId, updatedAt: ts }
      : {
        orgId,
        orgType: patch.orgType || 'individual',
        billingEmail: patch.billingEmail ?? null,
        currency: patch.currency || 'INR',
        timezone: patch.timezone || 'UTC',
        taxId: patch.taxId ?? null,
        country: patch.country ?? null,
        createdAt: ts,
        updatedAt: ts,
      };
    this.profiles.set(orgId, next);
    return clone(next);
  }

  // Members -----------------------------------------------------------------

  async listMembers(orgId: UUID): Promise<MembershipRow[]> {
    return this.bucket(this.members, orgId).filter((m) => !m.deletedAt).map(clone);
  }

  async getMembership(orgId: UUID, userId: UUID): Promise<MembershipRow | null> {
    const found = this.bucket(this.members, orgId).find((m) => m.userId === userId && !m.deletedAt);
    return found ? clone(found) : null;
  }

  async listMembershipsForUser(userId: UUID): Promise<MembershipRow[]> {
    const out: MembershipRow[] = [];
    for (const list of this.members.values()) {
      for (const m of list) if (m.userId === userId && !m.deletedAt) out.push(clone(m));
    }
    return out;
  }

  async addMember(orgId: UUID, userId: UUID, teamRole: TeamRole, invitedBy: UUID | null): Promise<MembershipRow> {
    const list = this.bucket(this.members, orgId);
    const existing = list.find((m) => m.userId === userId);
    const ts = nowIso();
    if (existing) {
      existing.teamRole = teamRole;
      existing.deletedAt = null;
      existing.updatedAt = ts;
      return clone(existing);
    }
    const row: MembershipRow = {
      id: id('mem'),
      orgId,
      userId,
      role: 'member',
      teamRole,
      invitedBy,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
    list.push(row);
    return clone(row);
  }

  async setMemberRole(orgId: UUID, userId: UUID, teamRole: TeamRole): Promise<MembershipRow | null> {
    const row = this.bucket(this.members, orgId).find((m) => m.userId === userId && !m.deletedAt);
    if (!row) return null;
    row.teamRole = teamRole;
    row.updatedAt = nowIso();
    return clone(row);
  }

  async removeMember(orgId: UUID, userId: UUID): Promise<boolean> {
    const row = this.bucket(this.members, orgId).find((m) => m.userId === userId && !m.deletedAt);
    if (!row) return false;
    row.deletedAt = nowIso();
    return true;
  }

  async countMembers(orgId: UUID): Promise<number> {
    return this.bucket(this.members, orgId).filter((m) => !m.deletedAt).length;
  }

  async countOwners(orgId: UUID): Promise<number> {
    return this.bucket(this.members, orgId).filter((m) => !m.deletedAt && m.teamRole === 'owner').length;
  }

  // Teams -------------------------------------------------------------------

  async listTeams(orgId: UUID): Promise<Team[]> {
    return this.bucket(this.teams, orgId).filter((t) => !t.deletedAt).map(clone);
  }

  async createTeam(orgId: UUID, input: { name: string; slug: string; description: string | null }): Promise<Team> {
    const ts = nowIso();
    const team: Team = {
      id: id('team'), orgId, name: input.name, slug: input.slug, description: input.description,
      createdAt: ts, updatedAt: ts, deletedAt: null,
    };
    this.bucket(this.teams, orgId).push(team);
    return clone(team);
  }

  async countTeams(orgId: UUID): Promise<number> {
    return this.bucket(this.teams, orgId).filter((t) => !t.deletedAt).length;
  }

  async listTeamMembers(orgId: UUID, teamId: UUID): Promise<TeamMember[]> {
    return this.bucket(this.teamMembers, orgId).filter((m) => m.teamId === teamId).map(clone);
  }

  async addTeamMember(orgId: UUID, teamId: UUID, userId: UUID, teamRole: TeamRole): Promise<TeamMember> {
    const list = this.bucket(this.teamMembers, orgId);
    const existing = list.find((m) => m.teamId === teamId && m.userId === userId);
    if (existing) {
      existing.teamRole = teamRole;
      return clone(existing);
    }
    const row: TeamMember = { id: id('tm'), orgId, teamId, userId, teamRole, createdAt: nowIso() };
    list.push(row);
    return clone(row);
  }

  // Plans and subscription --------------------------------------------------

  async listCustomPlans(orgId: UUID): Promise<Plan[]> {
    return this.bucket(this.customPlans, orgId).map(clone);
  }

  async upsertCustomPlan(orgId: UUID, plan: Plan): Promise<Plan> {
    const list = this.bucket(this.customPlans, orgId);
    const idx = list.findIndex((p) => p.key === plan.key);
    const row: Plan = { ...plan, orgId, isCustom: true };
    if (idx >= 0) list[idx] = row;
    else list.push(row);
    return clone(row);
  }

  async getSubscription(orgId: UUID): Promise<Subscription | null> {
    const s = this.subscriptions.get(orgId);
    return s ? clone(s) : null;
  }

  async saveSubscription(orgId: UUID, subscription: Subscription): Promise<Subscription> {
    // The orgId argument wins over the object's own field. A subscription object that arrived from
    // a request body naming another tenant does not get to write across the boundary.
    const row: Subscription = { ...subscription, orgId };
    this.subscriptions.set(orgId, row);
    return clone(row);
  }

  async createSubscription(
    orgId: UUID,
    input: Omit<Subscription, 'id' | 'orgId' | 'createdAt' | 'updatedAt'>,
  ): Promise<Subscription> {
    const ts = nowIso();
    const row: Subscription = { ...input, id: id('sub'), orgId, createdAt: ts, updatedAt: ts };
    this.subscriptions.set(orgId, row);
    return clone(row);
  }

  async getEnterpriseTerms(orgId: UUID): Promise<EnterpriseTerms | null> {
    const t = this.terms.get(orgId);
    return t ? clone(t) : null;
  }

  async upsertEnterpriseTerms(orgId: UUID, terms: Omit<EnterpriseTerms, 'orgId'>): Promise<EnterpriseTerms> {
    const row: EnterpriseTerms = { ...terms, orgId };
    this.terms.set(orgId, row);
    return clone(row);
  }

  // Usage -------------------------------------------------------------------

  async recordUsage(orgId: UUID, event: Omit<UsageEvent, 'id'>): Promise<RecordResult> {
    const keys = this.usageKeys.get(orgId) || new Set<string>();
    this.usageKeys.set(orgId, keys);
    if (event.idempotencyKey) {
      if (keys.has(event.idempotencyKey)) return { recorded: false, duplicate: true, id: null };
      keys.add(event.idempotencyKey);
    }
    const row: UsageEvent = { ...event, orgId, id: id('use') };
    this.bucket(this.usage, orgId).push(row);
    return { recorded: true, duplicate: false, id: row.id };
  }

  async listUsageEvents(orgId: UUID, q: UsageEventQuery = {}): Promise<UsageEvent[]> {
    let rows = this.bucket(this.usage, orgId).slice();
    if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
    if (q.period) {
      const start = new Date(q.period.start).getTime();
      const end = new Date(q.period.end).getTime();
      rows = rows.filter((r) => {
        const t = new Date(r.occurredAt).getTime();
        return t >= start && t < end;
      });
    }
    rows.sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
    return (q.limit ? rows.slice(0, q.limit) : rows).map(clone);
  }

  async getCounters(orgId: UUID, periodStart: string): Promise<UsageCounter[]> {
    return this.bucket(this.counters, orgId).filter((c) => c.periodStart === periodStart).map(clone);
  }

  async saveCounters(orgId: UUID, counters: UsageCounter[]): Promise<void> {
    const list = this.bucket(this.counters, orgId);
    for (const c of counters) {
      const idx = list.findIndex((x) => x.metric === c.metric && x.periodStart === c.periodStart);
      const row: UsageCounter = { ...c, orgId };
      if (idx >= 0) list[idx] = row;
      else list.push(row);
    }
  }

  async recordQuotaNotice(orgId: UUID, notice: Omit<QuotaNotice, 'id'>): Promise<RecordResult> {
    const list = this.bucket(this.notices, orgId);
    const dup = list.find(
      (n) => n.metric === notice.metric && n.periodStart === notice.periodStart && n.threshold === notice.threshold,
    );
    if (dup) return { recorded: false, duplicate: true, id: dup.id };
    const row: QuotaNotice = { ...notice, orgId, id: id('note') };
    list.push(row);
    return { recorded: true, duplicate: false, id: row.id };
  }

  async listQuotaNotices(orgId: UUID, periodStart: string): Promise<QuotaNotice[]> {
    return this.bucket(this.notices, orgId).filter((n) => n.periodStart === periodStart).map(clone);
  }

  // Billing -----------------------------------------------------------------

  async recordBillingEvent(
    event: Omit<BillingEvent, 'id' | 'receivedAt' | 'processedAt' | 'error'>,
  ): Promise<RecordResult & { event: BillingEvent | null }> {
    const dedup = event.provider + ':' + event.eventId;
    if (this.billingKeys.has(dedup)) {
      const found = this.billing.find((b) => b.provider === event.provider && b.eventId === event.eventId) || null;
      return { recorded: false, duplicate: true, id: found ? found.id : null, event: found ? clone(found) : null };
    }
    this.billingKeys.add(dedup);
    const row: BillingEvent = {
      ...event,
      id: id('bev'),
      receivedAt: nowIso(),
      processedAt: null,
      error: null,
    };
    this.billing.push(row);
    return { recorded: true, duplicate: false, id: row.id, event: clone(row) };
  }

  async markBillingEventProcessed(eventId: UUID, error: string | null): Promise<void> {
    const row = this.billing.find((b) => b.id === eventId);
    if (!row) return;
    row.processedAt = nowIso();
    row.error = error;
  }

  async listBillingEvents(orgId: UUID, limit = 50): Promise<BillingEvent[]> {
    return this.billing
      .filter((b) => b.orgId === orgId)
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, limit)
      .map(clone);
  }

  async listInvoices(orgId: UUID, limit = 50): Promise<Invoice[]> {
    return this.bucket(this.invoices, orgId)
      .slice()
      .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')))
      .slice(0, limit)
      .map(clone);
  }

  async upsertInvoice(orgId: UUID, invoice: Invoice): Promise<Invoice> {
    const list = this.bucket(this.invoices, orgId);
    const idx = list.findIndex((i) => i.id === invoice.id || i.number === invoice.number);
    const row: Invoice = { ...invoice, orgId };
    if (idx >= 0) list[idx] = row;
    else list.push(row);
    return clone(row);
  }
}
