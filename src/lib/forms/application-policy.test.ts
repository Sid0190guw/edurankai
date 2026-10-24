import { describe, expect, it } from 'vitest';
import { APPLICATION_COOLING_MS, decidePriorApplication, splitApplicantName } from './application-policy';

describe('Forms recruitment application policy', () => {
  it('allows a candidate without a prior application', () => {
    expect(decidePriorApplication(null)).toEqual({ kind: 'allow' });
  });

  it('returns the existing active application rather than creating a duplicate', () => {
    expect(decidePriorApplication({
      id: 'existing-app',
      status: 'interview',
      created_at: new Date(0),
    })).toEqual({ kind: 'duplicate', applicationId: 'existing-app' });
  });

  it('does not let a newer closed application hide an older active application', () => {
    expect(decidePriorApplication([
      { id: 'closed-app', status: 'rejected', created_at: new Date(2_000) },
      { id: 'active-app', status: 'interview', created_at: new Date(1_000) },
    ])).toEqual({ kind: 'duplicate', applicationId: 'active-app' });
  });

  it('uses the most recent terminal application to determine the cooling period', () => {
    expect(decidePriorApplication([
      { id: 'older-app', status: 'rejected', created_at: new Date(1_000) },
      { id: 'newer-app', status: 'withdrawn', created_at: new Date(2_000) },
    ], 2_000 + APPLICATION_COOLING_MS - 1)).toEqual({ kind: 'cooling' });
  });

  it('enforces the cooling period after a rejected application', () => {
    expect(decidePriorApplication({
      id: 'closed-app',
      status: 'rejected',
      created_at: new Date(0),
      updated_at: new Date(1_000),
    }, 1_000 + APPLICATION_COOLING_MS - 1)).toEqual({ kind: 'cooling' });
  });

  it('allows reapplication after the cooling period has elapsed', () => {
    expect(decidePriorApplication({
      id: 'closed-app',
      status: 'withdrawn',
      created_at: new Date(0),
      updated_at: new Date(1_000),
    }, 1_000 + APPLICATION_COOLING_MS)).toEqual({ kind: 'allow' });
  });

  it('fails closed when the prior application timestamp is invalid', () => {
    expect(decidePriorApplication({
      id: 'closed-app',
      status: 'rejected',
      created_at: 'not-a-date',
    })).toEqual({ kind: 'cooling' });
  });

  it('splits the first name from the full remaining surname without losing words', () => {
    expect(splitApplicantName('  Asha   Devi Rao  ')).toEqual({ firstName: 'Asha', lastName: 'Devi Rao' });
  });
});
