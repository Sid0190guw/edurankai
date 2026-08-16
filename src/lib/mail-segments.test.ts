import { describe, it, expect } from 'vitest';
import {
  compileSegment, evaluateSegment, validateSegment, segmentErrors, matchesEveryone,
  describeSegment, stageKeysFor, fieldDef, escapeLike, EMPTY_SEGMENT,
  type SegmentNode, type EvalContact,
} from '@/lib/mail-segments';

const NOW = Date.parse('2026-08-16T00:00:00Z');

const base: EvalContact = {
  email: 'ananya@iitg.ac.in',
  first_name: 'Ananya',
  last_name: 'Rao',
  organization: 'IIT Guwahati',
  status: 'subscribed',
  custom: { university: 'IIT Guwahati', cohort: '3' },
  tags: ['intern', 'iitg'],
  lists: ['11111111-1111-1111-1111-111111111111'],
  created_at: '2026-06-01T00:00:00Z',
  last_activity_at: '2026-08-10T00:00:00Z',
  activity: [{ kind: 'opened', campaignId: '22222222-2222-2222-2222-222222222222', at: '2026-08-12T00:00:00Z' }],
  application_stage: 'assessment',
  account: { last_login_at: '2026-08-14T00:00:00Z' },
};

const cond = (field: string, op: any, value?: unknown): SegmentNode => ({ type: 'cond', field, op, value });
const and = (...children: SegmentNode[]): SegmentNode => ({ type: 'group', op: 'and', children });
const or = (...children: SegmentNode[]): SegmentNode => ({ type: 'group', op: 'or', children });

describe('field catalog', () => {
  it('resolves plain, custom and activity keys', () => {
    expect(fieldDef('email')!.kind).toBe('text');
    expect(fieldDef('custom:university')!.kind).toBe('custom');
    expect(fieldDef('activity:opened')!.kind).toBe('activity');
    expect(fieldDef('nope')).toBeNull();
  });
});

describe('text operators (in memory)', () => {
  const t = (op: any, value?: unknown, field = 'organization') => evaluateSegment(cond(field, op, value), base, NOW);

  it('compares case-insensitively', () => {
    expect(t('eq', 'iit guwahati')).toBe(true);
    expect(t('neq', 'iit guwahati')).toBe(false);
  });

  it('handles contains / starts / ends and their negations', () => {
    expect(t('contains', 'Guwahati')).toBe(true);
    expect(t('not_contains', 'Guwahati')).toBe(false);
    expect(t('starts_with', 'IIT')).toBe(true);
    expect(t('ends_with', 'hati')).toBe(true);
  });

  it('handles set/empty', () => {
    expect(t('is_set')).toBe(true);
    expect(t('is_empty')).toBe(false);
    expect(evaluateSegment(cond('phone', 'is_empty'), base, NOW)).toBe(true);
  });

  it('handles in / not_in', () => {
    expect(t('in', ['IIT Guwahati', 'IIT Delhi'])).toBe(true);
    expect(t('not_in', ['IIT Delhi'])).toBe(true);
  });

  it('matches the combined name field', () => {
    expect(evaluateSegment(cond('name', 'eq', 'Ananya Rao'), base, NOW)).toBe(true);
  });
});

describe('tags, lists and custom fields', () => {
  it('matches a tag case-insensitively', () => {
    expect(evaluateSegment(cond('tag', 'has', 'INTERN'), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('tag', 'not_has', 'alumni'), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('tag', 'has', 'alumni'), base, NOW)).toBe(false);
  });

  it('matches list membership by id', () => {
    expect(evaluateSegment(cond('list', 'has', '11111111-1111-1111-1111-111111111111'), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('list', 'has', '33333333-3333-3333-3333-333333333333'), base, NOW)).toBe(false);
  });

  it('matches a custom field', () => {
    expect(evaluateSegment(cond('custom:university', 'contains', 'guwahati'), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('custom:missing', 'is_empty'), base, NOW)).toBe(true);
  });
});

describe('date operators', () => {
  it('within_days and older_than_days', () => {
    expect(evaluateSegment(cond('last_activity_at', 'within_days', 30), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('last_activity_at', 'within_days', 2), base, NOW)).toBe(false);
    expect(evaluateSegment(cond('created_at', 'older_than_days', 60), base, NOW)).toBe(true);
  });

  it('before and after', () => {
    expect(evaluateSegment(cond('created_at', 'before', '2026-07-01'), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('created_at', 'after', '2026-07-01'), base, NOW)).toBe(false);
  });

  it('a null date is neither within nor older', () => {
    const c = { ...base, last_activity_at: null };
    expect(evaluateSegment(cond('last_activity_at', 'within_days', 999), c, NOW)).toBe(false);
    expect(evaluateSegment(cond('last_activity_at', 'older_than_days', 0), c, NOW)).toBe(false);
    expect(evaluateSegment(cond('last_activity_at', 'is_empty'), c, NOW)).toBe(true);
  });
});

describe('campaign activity', () => {
  it('matches a kind', () => {
    expect(evaluateSegment(cond('activity:opened', 'has', {}), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('activity:clicked', 'has', {}), base, NOW)).toBe(false);
    expect(evaluateSegment(cond('activity:clicked', 'not_has', {}), base, NOW)).toBe(true);
  });

  it('narrows by campaign', () => {
    expect(evaluateSegment(cond('activity:opened', 'has', { campaignId: '22222222-2222-2222-2222-222222222222' }), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('activity:opened', 'has', { campaignId: '44444444-4444-4444-4444-444444444444' }), base, NOW)).toBe(false);
  });

  it('narrows by recency', () => {
    expect(evaluateSegment(cond('activity:opened', 'has', { days: 30 }), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('activity:opened', 'has', { days: 1 }), base, NOW)).toBe(false);
  });
});

describe('application stage arithmetic', () => {
  it('resolves a stage by key or by the 1-based number the UI shows', () => {
    expect(stageKeysFor('eq', 'assessment')).toEqual(['assessment']);
    expect(stageKeysFor('eq', '3')).toEqual(['assessment']);
  });

  it('gte includes the stage and everything after it', () => {
    expect(stageKeysFor('gte', 3)).toEqual(['assessment', 'interview', 'decision', 'onboarded']);
    expect(stageKeysFor('gt', 3)).toEqual(['interview', 'decision', 'onboarded']);
    expect(stageKeysFor('lte', 2)).toEqual(['submitted', 'review']);
    expect(stageKeysFor('lt', 1)).toEqual([]);
  });

  it('EXCLUDES closed stages from an ordering comparison', () => {
    const keys = stageKeysFor('gte', 1)!;
    expect(keys).not.toContain('decision_no');
    expect(keys).not.toContain('withdrawn');
  });

  it('still matches a closed stage with eq', () => {
    expect(stageKeysFor('eq', 'withdrawn')).toEqual(['withdrawn']);
    expect(stageKeysFor('gte', 'withdrawn')).toEqual([]);
  });

  it('returns null for a stage that is not ours', () => {
    expect(stageKeysFor('eq', 'nonsense')).toBeNull();
    expect(stageKeysFor('eq', '99')).toBeNull();
  });

  it('evaluates against a contact', () => {
    expect(evaluateSegment(cond('application_stage', 'gte', 3), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('application_stage', 'gte', 4), base, NOW)).toBe(false);
    expect(evaluateSegment(cond('application_stage', 'eq', 'assessment'), base, NOW)).toBe(true);
  });
});

describe('product usage', () => {
  it('matches an account, optionally by recency', () => {
    expect(evaluateSegment(cond('product_usage', 'has', {}), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('product_usage', 'has', { days: 7 }), base, NOW)).toBe(true);
    expect(evaluateSegment(cond('product_usage', 'has', { days: 1 }), base, NOW)).toBe(false);
    expect(evaluateSegment(cond('product_usage', 'not_has', {}), { ...base, account: null }, NOW)).toBe(true);
  });
});

describe('AND / OR / NOT', () => {
  it('AND requires every child', () => {
    expect(evaluateSegment(and(cond('organization', 'contains', 'IIT'), cond('status', 'eq', 'subscribed')), base, NOW)).toBe(true);
    expect(evaluateSegment(and(cond('organization', 'contains', 'IIT'), cond('status', 'eq', 'unsubscribed')), base, NOW)).toBe(false);
  });

  it('OR needs only one', () => {
    expect(evaluateSegment(or(cond('organization', 'eq', 'nope'), cond('tag', 'has', 'intern')), base, NOW)).toBe(true);
    expect(evaluateSegment(or(cond('organization', 'eq', 'nope'), cond('tag', 'has', 'nope')), base, NOW)).toBe(false);
  });

  it('NOT inverts a group', () => {
    expect(evaluateSegment({ type: 'group', op: 'and', not: true, children: [cond('status', 'eq', 'subscribed')] }, base, NOW)).toBe(false);
  });

  it('NOT inverts a single condition', () => {
    expect(evaluateSegment({ type: 'cond', field: 'status', op: 'eq', value: 'subscribed', not: true }, base, NOW)).toBe(false);
  });

  it('nests', () => {
    const tree = and(
      cond('organization', 'contains', 'IIT'),
      or(cond('application_stage', 'gte', 3), cond('tag', 'has', 'vip')),
      { type: 'group', op: 'or', not: true, children: [cond('status', 'eq', 'unsubscribed')] },
    );
    expect(evaluateSegment(tree, base, NOW)).toBe(true);
  });

  it('AND of nothing matches everyone; OR of nothing matches nobody', () => {
    expect(evaluateSegment(and(), base, NOW)).toBe(true);
    expect(evaluateSegment(or(), base, NOW)).toBe(false);
  });

  it('answers the worked example from the brief', () => {
    const tree = and(
      cond('organization', 'eq', 'IIT Guwahati'),
      cond('application_stage', 'gte', 3),
      cond('status', 'eq', 'subscribed'),
    );
    expect(evaluateSegment(tree, base, NOW)).toBe(true);
    expect(evaluateSegment(tree, { ...base, status: 'unsubscribed' }, NOW)).toBe(false);
    expect(evaluateSegment(tree, { ...base, application_stage: 'review' }, NOW)).toBe(false);
    expect(evaluateSegment(tree, { ...base, organization: 'IIT Delhi' }, NOW)).toBe(false);
  });
});

describe('the SQL compiler', () => {
  it('emits a parameter for every value — no value is ever spliced into the text', () => {
    const c = compileSegment(cond('organization', 'eq', "O'Brien & Co"));
    expect(c.text).not.toContain("O'Brien");
    expect(c.params).toEqual(["O'Brien & Co"]);
  });

  it('numbers placeholders in order', () => {
    const c = compileSegment(and(cond('first_name', 'eq', 'A'), cond('last_name', 'eq', 'B')));
    expect(c.text).toContain('$1');
    expect(c.text).toContain('$2');
    expect(c.params).toEqual(['A', 'B']);
  });

  it('NEVER emits `= ANY(array)` — postgres-js cannot serialise a JS array', () => {
    const c = compileSegment(cond('status', 'in', ['subscribed', 'pending']));
    expect(c.text).not.toContain('ANY(');
    expect(c.text).toContain('jsonb_array_elements_text');
    expect(c.params).toEqual([JSON.stringify(['subscribed', 'pending'])]);
  });

  it('passes a custom field KEY as a parameter, not as spliced SQL', () => {
    const c = compileSegment(cond("custom:university", 'eq', 'IITG'));
    expect(c.text).toContain('c.fields ->> $1');
    expect(c.params).toEqual(['university', 'IITG']);
  });

  it('refuses a custom key that is not a plain slug', () => {
    const c = compileSegment({ type: 'cond', field: "custom:x'; DROP TABLE users; --", op: 'eq', value: 'y' } as any);
    expect(c.text).toBe('FALSE');
    expect(c.params).toEqual([]);
  });

  it('refuses a list id that is not a uuid', () => {
    expect(compileSegment(cond('list', 'has', "1 OR 1=1")).text).toBe('FALSE');
  });

  it('escapes LIKE metacharacters and declares the escape', () => {
    const c = compileSegment(cond('organization', 'contains', '50%_off'));
    expect(c.params[0]).toBe('50\\%\\_off');
    expect(c.text).toContain("ESCAPE '\\'");
    expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });

  it('expands a stage comparison into a key list at compile time', () => {
    const c = compileSegment(cond('application_stage', 'gte', 3));
    expect(c.text).toContain('FROM applications a');
    expect(JSON.parse(String(c.params[0]))).toEqual(['assessment', 'interview', 'decision', 'onboarded']);
  });

  it('reads tags from the contact row array, never with `= ANY`', () => {
    const c = compileSegment(cond('tag', 'has', 'intern'));
    expect(c.text).toContain('unnest(c.tags)');
    expect(c.text).not.toContain('ANY(');
    expect(c.params).toEqual(['intern']);
  });

  it('uses EXISTS for tag, list, activity, stage and usage — no joins to manage', () => {
    for (const n of [
      cond('tag', 'has', 'intern'),
      cond('list', 'has', '11111111-1111-1111-1111-111111111111'),
      cond('activity:opened', 'has', {}),
      cond('application_stage', 'eq', 'review'),
      cond('product_usage', 'has', {}),
    ]) {
      expect(compileSegment(n).text).toContain('EXISTS');
    }
  });

  it('renders AND / OR / NOT structurally', () => {
    const c = compileSegment(and(cond('first_name', 'eq', 'A'), or(cond('last_name', 'eq', 'B'), cond('last_name', 'eq', 'C'))));
    expect(c.text).toContain(' AND ');
    expect(c.text).toContain(' OR ');
    expect(compileSegment({ type: 'group', op: 'and', not: true, children: [cond('first_name', 'eq', 'A')] }).text.startsWith('NOT ')).toBe(true);
  });

  it('empty groups compile to their operator identity', () => {
    expect(compileSegment(and()).text).toBe('TRUE');
    expect(compileSegment(or()).text).toBe('FALSE');
  });

  it('an unknown field compiles to FALSE rather than to nothing', () => {
    expect(compileSegment(cond('pwned', 'eq', 'x')).text).toBe('FALSE');
  });

  it('stops at the depth limit instead of recursing for ever', () => {
    let node: SegmentNode = cond('first_name', 'eq', 'A');
    for (let i = 0; i < 20; i++) node = and(node);
    expect(() => compileSegment(node)).not.toThrow();
    expect(compileSegment(node).text).toContain('FALSE');
  });
});

describe('validation', () => {
  it('accepts a well-formed tree', () => {
    expect(segmentErrors(and(cond('organization', 'eq', 'IITG')))).toEqual([]);
  });

  it('rejects an unknown field and an unsupported operator', () => {
    expect(segmentErrors(cond('nope', 'eq', 'x'))[0]).toContain('Unknown field');
    expect(segmentErrors(cond('tag', 'contains', 'x'))[0]).toContain('does not support');
  });

  it('rejects a missing value, an empty in-list, a bad date and negative days', () => {
    expect(segmentErrors(cond('organization', 'eq', ''))[0]).toContain('no value');
    expect(segmentErrors(cond('status', 'in', []))[0]).toContain('at least one value');
    expect(segmentErrors(cond('created_at', 'before', 'whenever'))[0]).toContain('not a date');
    expect(segmentErrors(cond('created_at', 'within_days', -1))[0]).toContain('zero or more');
  });

  it('rejects a list condition with no list chosen', () => {
    expect(segmentErrors(cond('list', 'has', 'not-a-uuid'))[0]).toContain('Choose a list');
  });

  it('WARNS rather than errors when a group matches everyone or nobody', () => {
    const empty = validateSegment(EMPTY_SEGMENT);
    expect(empty.every((i) => i.level === 'warning')).toBe(true);
    expect(empty[0].message).toContain('every contact');
    expect(validateSegment(or())[0].message).toContain('nobody');
  });

  it('flags a match-everyone root so the send gate can act on it', () => {
    expect(matchesEveryone(EMPTY_SEGMENT)).toBe(true);
    expect(matchesEveryone(and(cond('status', 'eq', 'subscribed')))).toBe(false);
    expect(matchesEveryone(or(and(), cond('status', 'eq', 'subscribed')))).toBe(true);
  });

  it('refuses a tree with too many nodes', () => {
    const kids: SegmentNode[] = [];
    for (let i = 0; i < 250; i++) kids.push(cond('first_name', 'eq', 'x'));
    expect(segmentErrors({ type: 'group', op: 'and', children: kids })[0]).toContain('more than');
  });
});

describe('description', () => {
  it('reads back as sentences an operator can check', () => {
    const lines = describeSegment(and(
      cond('organization', 'eq', 'IIT Guwahati'),
      cond('application_stage', 'gte', 3),
    ));
    expect(lines[0]).toBe('AND');
    expect(lines[1]).toContain('Organisation is IIT Guwahati');
    expect(lines[2]).toContain('Application stage is at or after stage Assessment');
  });

  it('says so plainly when a group restricts nothing', () => {
    expect(describeSegment(EMPTY_SEGMENT)[0]).toBe('EVERY CONTACT');
    expect(describeSegment(or())[0]).toBe('NOBODY');
  });
});
