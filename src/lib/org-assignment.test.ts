import { describe, it, expect } from 'vitest';
import {
  reportingLineRefusal, departmentHeadRefusal, coverageSentence,
  type ReportingLineFacts, type DepartmentHeadFacts,
} from './org-assignment';

// vitest, not src/lib/test-shim.ts. The shim's it() is SYNCHRONOUS and never awaits an async body,
// so an async test written against it passes while asserting nothing. Everything below is sync, but
// the file sits next to writers that are not, and one runner for the module is the smaller mistake.

// Real-shaped uuids. The refusal rules compare ids for equality and validate the subject's shape, so
// a fixture using 'emp-1' would pass the equality tests and fail the shape one for the wrong reason.
const SUBJECT = '11111111-1111-4111-8111-111111111111';
const MANAGER = '22222222-2222-4222-8222-222222222222';
const SUBJECT_LOGIN = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const MANAGER_LOGIN = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
/** The SAME human reached through a second employee record: different row id, same sign-in. */
const SUBJECT_SECOND_ROW = '33333333-3333-4333-8333-333333333333';

const line = (over: Partial<ReportingLineFacts> = {}): ReportingLineFacts => ({
  subjectEmployeeId: SUBJECT,
  subjectUserId: SUBJECT_LOGIN,
  subjectName: 'Asha Rao',
  askedForAManager: true,
  managerEmployeeId: MANAGER,
  managerUserId: MANAGER_LOGIN,
  managerName: 'Vikram Nair',
  managerIsActive: true,
  ...over,
});

const head = (over: Partial<DepartmentHeadFacts> = {}): DepartmentHeadFacts => ({
  departmentId: 'engineering',
  departmentName: 'Engineering',
  departmentKnown: true,
  askedForAHead: true,
  headEmployeeId: MANAGER,
  headFound: true,
  headIsActive: true,
  headUserId: MANAGER_LOGIN,
  headName: 'Vikram Nair',
  ...over,
});

describe('a reporting line that is allowed through', () => {
  it('an active manager with a linked sign-in is recorded', () => {
    expect(reportingLineRefusal(line())).toBe('');
  });

  it('clearing the line is always allowed — that is how a departure is recorded', () => {
    // Every fact about the manager is absent, which for any OTHER call would be several refusals.
    expect(reportingLineRefusal(line({
      askedForAManager: false,
      managerEmployeeId: null,
      managerUserId: null,
      managerName: '',
      managerIsActive: false,
    }))).toBe('');
  });

  it('a subject with no sign-in of their own can still be given a manager', () => {
    // The COLUMN holds the MANAGER's users id, not the subject's, so the subject having no login is
    // irrelevant to whether the pair can be recorded.
    expect(reportingLineRefusal(line({ subjectUserId: null }))).toBe('');
  });
});

describe('a reporting line that is refused, and why', () => {
  it('an unidentified employee record is refused before anything else is considered', () => {
    expect(reportingLineRefusal(line({ subjectEmployeeId: 'not-a-uuid' }))).toMatch(/not identified/);
  });

  it('a manager with a sign-in but no employee record cannot be an edge at all', () => {
    // THE CASE THAT USED TO WRITE THE COLUMN ALONE. The graph is keyed on hr_employees.id, so this
    // person has no representation in it; writing only the column is the drift being ended.
    const why = reportingLineRefusal(line({ managerEmployeeId: null }));
    expect(why).toMatch(/no record on the employee register/);
    expect(why).toMatch(/Nothing was changed/);
  });

  it('nobody is their own manager', () => {
    expect(reportingLineRefusal(line({ managerEmployeeId: SUBJECT }))).toMatch(/their own reporting manager/);
  });

  it('nor through a SECOND employee record belonging to the same sign-in', () => {
    // A rehire or a duplicate row: the employee ids differ, the login does not, and approval is
    // checked against the signed-in account — so this would let somebody approve their own leave.
    const why = reportingLineRefusal(line({
      managerEmployeeId: SUBJECT_SECOND_ROW,
      managerUserId: SUBJECT_LOGIN,
    }));
    expect(why).toMatch(/same sign-in/);
  });

  it('a manager with no linked sign-in is refused, because the column could not name them', () => {
    // hr_employees.reporting_manager_id holds a USERS id. Recording this pair would set the graph
    // and leave the column NULL — the two records disagreeing, silently, which is the whole defect.
    const why = reportingLineRefusal(line({ managerUserId: null }));
    expect(why).toMatch(/no linked sign-in/);
    expect(why).toMatch(/disagreeing/);
  });

  it('a manager who has left is refused', () => {
    expect(reportingLineRefusal(line({ managerIsActive: false }))).toMatch(/no longer an active employee/);
  });

  it('every refusal names the person rather than saying "invalid input"', () => {
    expect(reportingLineRefusal(line({ managerEmployeeId: SUBJECT }))).toContain('Asha Rao');
    expect(reportingLineRefusal(line({ managerIsActive: false }))).toContain('Vikram Nair');
    expect(reportingLineRefusal(line({ managerUserId: null }))).toContain('Vikram Nair');
  });
});

describe('department heads', () => {
  it('an active employee with a sign-in may head a department', () => {
    expect(departmentHeadRefusal(head())).toBe('');
  });

  it('a department may be left with no head, and that is not a refusal', () => {
    expect(departmentHeadRefusal(head({
      askedForAHead: false, headEmployeeId: null, headFound: false, headIsActive: false, headUserId: null,
    }))).toBe('');
  });

  it('a department id that is not on the register is refused', () => {
    expect(departmentHeadRefusal(head({ departmentKnown: false }))).toMatch(/not on the department register/);
  });

  it('an empty department id is refused before the register is consulted', () => {
    expect(departmentHeadRefusal(head({ departmentId: '   ' }))).toMatch(/No department was identified/);
  });

  it('a head with no employee record is refused', () => {
    expect(departmentHeadRefusal(head({ headFound: false, headEmployeeId: null }))).toMatch(/no record on the employee register/);
  });

  it('a head who has left is refused, naming what would stop working', () => {
    expect(departmentHeadRefusal(head({ headIsActive: false }))).toMatch(/would reach anybody/);
  });

  it('a head with no linked sign-in is refused: the screen would say headed, every check would say no', () => {
    const why = departmentHeadRefusal(head({ headUserId: null }));
    expect(why).toMatch(/no linked sign-in/);
    expect(why).toMatch(/every permission check answered no/);
  });

  it('a department id is treated as TEXT, so a slug is as valid as a uuid', () => {
    // departments.id is varchar(50) in src/lib/db/schema.ts and UUID in db/hr-schema.sql. A rule
    // that demanded a uuid here would refuse half the departments in the product.
    expect(departmentHeadRefusal(head({ departmentId: 'engineering' }))).toBe('');
    expect(departmentHeadRefusal(head({ departmentId: '44444444-4444-4444-8444-444444444444' }))).toBe('');
  });
});

describe('how far behind the compatibility column is', () => {
  it('says nothing when every column value already has an edge', () => {
    expect(coverageSentence({ columnOnly: 0, withEdge: 12 })).toBe('');
  });

  it('counts the people whose approvals still resolve through the old field', () => {
    const s = coverageSentence({ columnOnly: 7, withEdge: 1 });
    expect(s).toMatch(/7 other active employees have/);
    expect(s).toMatch(/compatibility layer/);
  });

  it('one person reads as one person', () => {
    expect(coverageSentence({ columnOnly: 1, withEdge: 0 })).toMatch(/^1 other active employee has/);
  });

  it('a negative or nonsense count is not printed as a scare number', () => {
    expect(coverageSentence({ columnOnly: -3, withEdge: 0 })).toBe('');
    expect(coverageSentence({ columnOnly: NaN, withEdge: 0 })).toBe('');
  });
});
