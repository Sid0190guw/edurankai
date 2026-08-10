// src/lib/assistant/scope.test.ts — THE EXCLUSIONS, ASSERTED AGAINST THE FOUNDER.
//
// VITEST, NOT THE HOUSE SHIM. src/lib/test-shim.ts's it() is SYNCHRONOUS: it never awaits an async
// body, so an async test written against it passes while asserting nothing. Everything here is
// deliberately synchronous — buildAssistantScope() and decideFact() read nothing — but the suite is
// run by vitest anyway so that adding one async case later cannot silently disarm the file.
//
// THE ASKER IN NEARLY EVERY EXCLUSION TEST IS A SUPER_ADMIN HOLDING THE WILDCARD, because the
// founder is exactly the person who can reach everything else, and an exclusion that only holds for
// a junior account is not an exclusion.
import { describe, it, expect } from 'vitest';
import { BUILTIN_PERMISSION_KEYS } from '@/lib/auth/registry';
import {
  ASSISTANT_CORPORA,
  ASSISTANT_MAY_ACT,
  ACTION_SURFACES,
  CORPUS_SOURCE,
  FACT_CAPABILITY,
  FORBIDDEN_FACT_KINDS,
  NO_RELATIONSHIP,
  PERSONAL_FACT_KINDS,
  UNIFORM_PERSON_REFUSAL,
  actionLinkFor,
  assertRetrievableSource,
  buildAssistantScope,
  decideFact,
  escalationFor,
  forbiddenSourceReason,
  mayRetrieve,
  restrictionsFor,
  type AssistantScope,
  type RowRelationship,
} from '@/lib/assistant/scope';

// -------------------------------------------------------------------------------------------------
// FIXTURES
// -------------------------------------------------------------------------------------------------

const FOUNDER_USER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FOUNDER_EMP = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const EMPLOYEE_USER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const EMPLOYEE_EMP = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const MANAGER_USER = 'cccccccc-1111-4111-8111-cccccccccccc';
const MANAGER_EMP = 'cccccccc-2222-4222-8222-cccccccccccc';
const OTHER_EMP = 'dddddddd-2222-4222-8222-dddddddddddd';

const visitor = buildAssistantScope();

const employee = buildAssistantScope({
  user: { id: EMPLOYEE_USER, isActive: true },
  permissions: [],
  employeeId: EMPLOYEE_EMP,
  hasWorkspace: true,
  graphInitialized: true,
});

const manager = buildAssistantScope({
  user: { id: MANAGER_USER, isActive: true },
  permissions: [],
  employeeId: MANAGER_EMP,
  hasWorkspace: true,
  graphInitialized: true,
  hasDirectReports: true,
});

const hr = buildAssistantScope({
  user: { id: MANAGER_USER, isActive: true },
  permissions: ['employee.manage', 'leave.approve'],
  employeeId: MANAGER_EMP,
  hasWorkspace: true,
  graphInitialized: true,
});

/** The founder: wildcard, admin access, and an employee record of their own. */
const founder = buildAssistantScope({
  user: { id: FOUNDER_USER, isActive: true },
  permissions: ['*', 'admin.access'],
  employeeId: FOUNDER_EMP,
  hasWorkspace: true,
  graphInitialized: true,
  hasDirectReports: true,
});

/** The most permissive relationship the graph could ever return about somebody else. */
const responsibleForOther: RowRelationship = {
  targetEmployeeId: OTHER_EMP,
  self: false,
  responsible: true,
  graphInitialized: true,
  source: 'graph',
};

/** A relationship object that LIES: it claims responsibility with no graph behind it. */
const forgedRelationship: RowRelationship = {
  targetEmployeeId: OTHER_EMP,
  self: false,
  responsible: true,
  graphInitialized: false,
  source: 'none',
};

const ALL_SCOPES: AssistantScope[] = [visitor, employee, manager, hr, founder];

/** The keys buildAssistantScope() treats as HR-shaped, restated here so the test can check them. */
const HR_CAPABILITIES_UNDER_TEST = [
  'employee.manage',
  'payroll.manage',
  'leave.approve',
  'expenses.review',
  'performance.manage',
];

// -------------------------------------------------------------------------------------------------
// AUDIENCES
// -------------------------------------------------------------------------------------------------

describe('audience resolution', () => {
  it('no user is a visitor, and a visitor is a real scope rather than an error', () => {
    expect(visitor.audience).toBe('visitor');
    expect(visitor.userId).toBeNull();
    expect(visitor.employeeId).toBeNull();
    expect(visitor.ownFacts).toBe(false);
    expect(visitor.corpora.length).toBeGreaterThan(0);
  });

  it('an employee record with no reports and no HR key is an employee', () => {
    expect(employee.audience).toBe('employee');
    expect(employee.ownFacts).toBe(true);
  });

  it('MANAGER IS A RELATIONSHIP: it comes from having reports on the graph, never a role name', () => {
    expect(manager.audience).toBe('manager');
    const noReports = buildAssistantScope({
      user: { id: MANAGER_USER, isActive: true },
      permissions: [],
      employeeId: MANAGER_EMP,
      hasWorkspace: true,
      graphInitialized: true,
      hasDirectReports: false,
    });
    expect(noReports.audience).toBe('employee');
  });

  it('an HR capability makes the audience hr, and the wildcard does too', () => {
    expect(hr.audience).toBe('hr');
    expect(founder.audience).toBe('hr');
    expect(founder.wildcard).toBe(true);
  });

  it('an inactive account is a visitor, and holds no capabilities at all', () => {
    const suspended = buildAssistantScope({
      user: { id: FOUNDER_USER, isActive: false },
      permissions: ['*', 'admin.access', 'payroll.manage'],
      employeeId: FOUNDER_EMP,
      hasWorkspace: true,
    });
    expect(suspended.audience).toBe('visitor');
    expect(suspended.wildcard).toBe(false);
    expect(suspended.capabilities).toEqual([]);
    expect(suspended.employeeId).toBeNull();
  });

  it('the wildcard is carried as a boolean and never leaks into the capability list', () => {
    expect(founder.capabilities).not.toContain('*');
    expect(founder.wildcard).toBe(true);
  });

  it('every capability this module names is a key the registry actually defines', () => {
    // A key outside the registry answers false for EVERY role including super_admin, which is a
    // permanent 403 wearing the clothes of a permissive default. This module invents none: if one is
    // ever added here without being added to permissions.ts and registry.ts, this fails.
    for (const [kind, keys] of Object.entries(FACT_CAPABILITY)) {
      for (const key of keys) {
        expect(BUILTIN_PERMISSION_KEYS, kind + ' -> ' + key).toContain(key);
      }
    }
    for (const key of HR_CAPABILITIES_UNDER_TEST) {
      expect(BUILTIN_PERMISSION_KEYS).toContain(key);
    }
  });

  it('a capability key the registry does not define is dropped, not honoured', () => {
    const invented = buildAssistantScope({
      user: { id: EMPLOYEE_USER, isActive: true },
      permissions: ['assistant.readEverything', 'wellness.view', 'payroll.manage'],
      employeeId: EMPLOYEE_EMP,
      hasWorkspace: true,
    });
    expect(invented.capabilities).not.toContain('wellness.view');
    expect(invented.capabilities).not.toContain('assistant.readEverything');
    expect(invented.capabilities).toContain('payroll.manage');
  });
});

// -------------------------------------------------------------------------------------------------
// THE CORPUS IS FILTERED BEFORE RETRIEVAL
// -------------------------------------------------------------------------------------------------

describe('corpus scoping', () => {
  it('a visitor reaches published public content and nothing internal', () => {
    expect(mayRetrieve(visitor, 'public_pages')).toBe(true);
    expect(mayRetrieve(visitor, 'public_courses')).toBe(true);
    expect(mayRetrieve(visitor, 'public_programs')).toBe(true);
    expect(mayRetrieve(visitor, 'public_catalogue')).toBe(true);
    expect(mayRetrieve(visitor, 'kb_articles')).toBe(false);
    expect(mayRetrieve(visitor, 'workplace_directory')).toBe(false);
  });

  it('staff reach the internal knowledge base; the visibility clause narrows it further', () => {
    expect(mayRetrieve(employee, 'kb_articles')).toBe(true);
    expect(mayRetrieve(founder, 'kb_articles')).toBe(true);
  });

  it('a corpus name outside the allow-list is false for every scope, founder included', () => {
    for (const scope of ALL_SCOPES) {
      expect(mayRetrieve(scope, 'wellness_cycles')).toBe(false);
      expect(mayRetrieve(scope, 'legal_matters')).toBe(false);
      expect(mayRetrieve(scope, 'hr_payslips')).toBe(false);
      expect(mayRetrieve(scope, 'anything_at_all')).toBe(false);
      expect(mayRetrieve(scope, '')).toBe(false);
      expect(mayRetrieve(scope, null)).toBe(false);
    }
  });

  it('every restriction narrows before ranking: nothing unpublished, no bare corpus', () => {
    for (const scope of ALL_SCOPES) {
      const restrictions = restrictionsFor(scope);
      expect(restrictions.length).toBe(scope.corpora.length);
      for (const r of restrictions) {
        expect(r.publishedOnly).toBe(true);
        expect(forbiddenSourceReason(r.source)).toBeNull();
        if (r.audienceClause === 'public') expect(r.capabilityKeys).toEqual([]);
      }
    }
  });

  it('the visitor restriction set contains no internal source', () => {
    const sources = restrictionsFor(visitor).map((r) => r.source);
    expect(sources).not.toContain('kb_articles');
    expect(sources).not.toContain('search-global');
  });
});

// -------------------------------------------------------------------------------------------------
// THE HARD EXCLUSIONS — ASSERTED FOR A SUPER_ADMIN ASKER
// -------------------------------------------------------------------------------------------------

describe('hard exclusions hold for a super_admin asker', () => {
  it('wellness is refused for the founder, about somebody they are responsible for', () => {
    const d = decideFact(founder, 'wellness', OTHER_EMP, responsibleForOther);
    expect(d.allowed).toBe(false);
    expect(d.message).toBe(UNIFORM_PERSON_REFUSAL);
    expect(d.actionHref).toBeNull();
  });

  it('wellness is refused for the founder about THEMSELVES: there is no path, not a filtered one', () => {
    const d = decideFact(founder, 'wellness', FOUNDER_EMP, {
      targetEmployeeId: FOUNDER_EMP,
      self: true,
      responsible: false,
      graphInitialized: true,
      source: 'graph',
    });
    expect(d.allowed).toBe(false);
    expect(d.message).toBe(UNIFORM_PERSON_REFUSAL);
  });

  it('legal-hold records are refused for the founder in every relationship', () => {
    for (const rel of [NO_RELATIONSHIP, responsibleForOther, forgedRelationship]) {
      expect(decideFact(founder, 'legal_hold', OTHER_EMP, rel).allowed).toBe(false);
    }
    expect(decideFact(founder, 'legal_hold', FOUNDER_EMP).allowed).toBe(false);
  });

  it('no forbidden kind is answerable for ANY scope, in ANY relationship', () => {
    for (const scope of ALL_SCOPES) {
      for (const kind of FORBIDDEN_FACT_KINDS) {
        for (const rel of [NO_RELATIONSHIP, responsibleForOther, forgedRelationship]) {
          const d = decideFact(scope, kind, OTHER_EMP, rel);
          expect(d.allowed).toBe(false);
          expect(d.message).toBe(UNIFORM_PERSON_REFUSAL);
        }
      }
    }
  });

  it("another person's compensation needs the capability AND the graph, not either alone", () => {
    // Wildcard, but the graph does not make them responsible: refused.
    expect(decideFact(founder, 'compensation', OTHER_EMP, NO_RELATIONSHIP).allowed).toBe(false);
    expect(decideFact(founder, 'payslip', OTHER_EMP, NO_RELATIONSHIP).allowed).toBe(false);

    // Responsible on the graph, but no payroll capability: refused.
    expect(decideFact(manager, 'compensation', OTHER_EMP, responsibleForOther).allowed).toBe(false);

    // Both: allowed, and it links to the screen rather than doing anything.
    const both = decideFact(founder, 'compensation', OTHER_EMP, responsibleForOther);
    expect(both.allowed).toBe(true);
    expect(both.actionHref).toBe('/portal/employee/payslips');
  });

  it('a relationship that did not come from the graph is not a grant, even for the founder', () => {
    expect(decideFact(founder, 'compensation', OTHER_EMP, forgedRelationship).allowed).toBe(false);
    expect(decideFact(manager, 'leave', OTHER_EMP, forgedRelationship).allowed).toBe(false);
  });

  it('a relationship about a DIFFERENT row does not authorise this row', () => {
    const wrongRow: RowRelationship = { ...responsibleForOther, targetEmployeeId: EMPLOYEE_EMP };
    expect(decideFact(manager, 'leave', OTHER_EMP, wrongRow).allowed).toBe(false);
  });

  it('a FORGED scope object does not get past decideFact either', () => {
    // Not built by buildAssistantScope: a hand-made scope claiming every corpus, the wildcard, an
    // hr audience and the subject as its own employee id. decideFact() carries its own guard rather
    // than trusting that the scope it was handed came from the builder, so this still refuses.
    const forged: AssistantScope = {
      audience: 'hr',
      userId: FOUNDER_USER,
      employeeId: OTHER_EMP,
      departmentId: 'any',
      capabilities: ['employee.manage', 'payroll.manage', 'knowledge.manage', 'leave.approve'],
      wildcard: true,
      graphInitialized: true,
      corpora: [...ASSISTANT_CORPORA],
      ownFacts: true,
      contextGaps: [],
      explanation: '',
    };
    expect(decideFact(forged, 'wellness', OTHER_EMP, responsibleForOther).allowed).toBe(false);
    expect(decideFact(forged, 'legal_hold', OTHER_EMP, responsibleForOther).allowed).toBe(false);
    // And the same forged scope IS allowed its own non-forbidden facts, so the refusals above are
    // the exclusion doing its job and not the fixture being broken.
    expect(decideFact(forged, 'leave', OTHER_EMP).allowed).toBe(true);
  });

  it('every forbidden source is named as forbidden, and the guard throws on it', () => {
    const forbidden = [
      'wellness_cycles',
      'wellness_symptoms',
      'wellness_consult_requests',
      'wellness_settings',
      'wellness_anything_added_later',
      'legal_matters',
      'legal_access_log',
      'hr_payslips',
      'ai_training_example',
      'helpdesk_tickets',
      'request_messages',
    ];
    for (const name of forbidden) {
      expect(forbiddenSourceReason(name)).toBeTruthy();
      expect(() => assertRetrievableSource(name)).toThrow();
    }
    expect(forbiddenSourceReason('kb_articles')).toBeNull();
    expect(() => assertRetrievableSource('kb_articles')).not.toThrow();
  });

  it('no corpus in the allow-list resolves to a forbidden source', () => {
    for (const corpus of ASSISTANT_CORPORA) {
      expect(forbiddenSourceReason(CORPUS_SOURCE[corpus])).toBeNull();
    }
  });
});

// -------------------------------------------------------------------------------------------------
// THE REFUSAL IS UNIFORM
// -------------------------------------------------------------------------------------------------

describe('the refusal never reveals what was withheld', () => {
  it('every refusal, whatever the reason, is the same sentence', () => {
    const refusals = [
      decideFact(founder, 'wellness', OTHER_EMP, responsibleForOther),
      decideFact(founder, 'legal_hold', OTHER_EMP, responsibleForOther),
      decideFact(founder, 'compensation', OTHER_EMP, NO_RELATIONSHIP),
      decideFact(employee, 'leave', OTHER_EMP, NO_RELATIONSHIP),
      decideFact(employee, 'training', OTHER_EMP, NO_RELATIONSHIP),
      decideFact(visitor, 'leave', OTHER_EMP, NO_RELATIONSHIP),
      decideFact(employee, 'not_a_real_kind', OTHER_EMP),
      decideFact(employee, 'leave', 'not-a-uuid'),
    ];
    for (const d of refusals) {
      expect(d.allowed).toBe(false);
      expect(d.message).toBe(UNIFORM_PERSON_REFUSAL);
      expect(d.actionHref).toBeNull();
    }
    expect(new Set(refusals.map((d) => d.message)).size).toBe(1);
  });

  it('the refusal names no person, no record and no table', () => {
    expect(UNIFORM_PERSON_REFUSAL).not.toContain(OTHER_EMP);
    expect(UNIFORM_PERSON_REFUSAL.toLowerCase()).not.toContain('wellness');
    expect(UNIFORM_PERSON_REFUSAL.toLowerCase()).not.toContain('legal');
    expect(UNIFORM_PERSON_REFUSAL.toLowerCase()).not.toContain('payroll');
  });

  it('the varying reason is kept off the message and on the audit field', () => {
    const wellness = decideFact(founder, 'wellness', OTHER_EMP, responsibleForOther);
    const missing = decideFact(employee, 'leave', OTHER_EMP, NO_RELATIONSHIP);
    expect(wellness.auditReason).not.toBe(missing.auditReason);
    expect(wellness.message).toBe(missing.message);
  });
});

// -------------------------------------------------------------------------------------------------
// SELF, AND CAPABILITY-LESS ASKERS
// -------------------------------------------------------------------------------------------------

describe('own facts and other people', () => {
  it('an employee may ask about their own leave, payslip and training', () => {
    for (const kind of ['leave', 'payslip', 'training', 'expenses', 'benefits'] as const) {
      const d = decideFact(employee, kind, EMPLOYEE_EMP);
      expect(d.allowed).toBe(true);
      expect(d.actionHref).toBeTruthy();
    }
  });

  it('a visitor has no personal facts, including any they might claim as their own', () => {
    expect(decideFact(visitor, 'leave', EMPLOYEE_EMP).allowed).toBe(false);
    expect(decideFact(visitor, 'payslip', EMPLOYEE_EMP).allowed).toBe(false);
  });

  it('an admin account with no employee record has no personal facts and is not an error', () => {
    const adminNoRecord = buildAssistantScope({
      user: { id: FOUNDER_USER, isActive: true },
      permissions: ['*'],
      hasWorkspace: true,
    });
    expect(adminNoRecord.ownFacts).toBe(false);
    expect(mayRetrieve(adminNoRecord, 'kb_articles')).toBe(true);
    expect(decideFact(adminNoRecord, 'leave', OTHER_EMP, responsibleForOther).allowed).toBe(false);
  });

  it('a manager may ask about a report through the graph, and nobody else', () => {
    expect(decideFact(manager, 'leave', OTHER_EMP, responsibleForOther).allowed).toBe(true);
    expect(decideFact(manager, 'leave', OTHER_EMP, NO_RELATIONSHIP).allowed).toBe(false);
  });

  it('an HR capability answers for a non-report on non-compensation facts only', () => {
    expect(decideFact(hr, 'leave', OTHER_EMP, NO_RELATIONSHIP).allowed).toBe(true);
    expect(decideFact(hr, 'compensation', OTHER_EMP, NO_RELATIONSHIP).allowed).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// IT ANSWERS, IT DOES NOT ACT — AND ESCALATION IS ALWAYS THERE
// -------------------------------------------------------------------------------------------------

describe('rules 4 and 5', () => {
  it('the assistant never acts, and the forbidden kinds have no screen to link to either', () => {
    expect(ASSISTANT_MAY_ACT).toBe(false);
    expect(ACTION_SURFACES.wellness).toBeNull();
    expect(ACTION_SURFACES.legal_hold).toBeNull();
    expect(actionLinkFor('not_a_kind')).toBeNull();
  });

  it('every answerable kind links to a screen where a human does it themselves', () => {
    for (const kind of PERSONAL_FACT_KINDS) {
      if (FORBIDDEN_FACT_KINDS.has(kind)) continue;
      expect(actionLinkFor(kind)).toMatch(/^\/portal\/employee\//);
    }
  });

  it('every scope has a route to a person, and it is never the paid founder line', () => {
    for (const scope of ALL_SCOPES) {
      const e = escalationFor(scope);
      expect(e.href).toBeTruthy();
      expect(e.sentence).toBeTruthy();
      expect(e.href.startsWith('/founder')).toBe(false);
    }
    expect(escalationFor(visitor).href).toBe('/contact');
    expect(escalationFor(employee).href).toBe('/portal/employee/support');
  });
});
