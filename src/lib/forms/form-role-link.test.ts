import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { saveFormRoleLink, type FormRoleLinkSave } from './form-role-link';

const dialect = new PgDialect();
const baseLink: FormRoleLinkSave = {
  available: true,
  formId: 'form-1',
  existingRoleId: null,
  existingNameFieldKey: null,
  existingEmailFieldKey: null,
  existingPhoneFieldKey: null,
  existingReviewerUserId: null,
  roleId: '',
  nameFieldKey: '',
  emailFieldKey: '',
  phoneFieldKey: null,
  reviewerUserId: null,
  createdBy: 'user-1',
};

describe('saveFormRoleLink', () => {
  it('does not issue a DELETE when the form has no existing role link', async () => {
    const execute = vi.fn(async (_query: SQL) => []);

    await expect(saveFormRoleLink({ execute }, baseLink)).resolves.toBe('unchanged');
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the association when the role-link settings could not be loaded', async () => {
    const execute = vi.fn(async (_query: SQL) => []);

    await expect(saveFormRoleLink({ execute }, {
      ...baseLink,
      available: false,
      existingRoleId: 'role-1',
    })).resolves.toBe('unchanged');
    expect(execute).not.toHaveBeenCalled();
  });

  it('leaves an unchanged role association untouched during unrelated form edits', async () => {
    const execute = vi.fn(async (_query: SQL) => []);

    await expect(saveFormRoleLink({ execute }, {
      ...baseLink,
      existingRoleId: 'role-1',
      existingNameFieldKey: 'full_name',
      existingEmailFieldKey: 'email',
      existingPhoneFieldKey: 'phone',
      existingReviewerUserId: 'reviewer-1',
      roleId: 'role-1',
      nameFieldKey: 'full_name',
      emailFieldKey: 'email',
      phoneFieldKey: 'phone',
      reviewerUserId: 'reviewer-1',
    })).resolves.toBe('unchanged');

    expect(execute).not.toHaveBeenCalled();
  });

  it('upserts a selected role link', async () => {
    const execute = vi.fn(async (_query: SQL) => []);

    await expect(saveFormRoleLink({ execute }, {
      ...baseLink,
      roleId: 'role-1',
      nameFieldKey: 'full_name',
      emailFieldKey: 'email',
    })).resolves.toBe('upserted');

    expect(execute).toHaveBeenCalledOnce();
    const query = dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain('INSERT INTO form_role_links');
    expect(query.sql).toContain('ON CONFLICT (form_id) DO UPDATE');
    expect(query.params).toContain('role-1');
  });

  it('upserts intentionally changed mappings on an existing association', async () => {
    const execute = vi.fn(async (_query: SQL) => []);

    await expect(saveFormRoleLink({ execute }, {
      ...baseLink,
      existingRoleId: 'role-1',
      existingNameFieldKey: 'name',
      existingEmailFieldKey: 'email',
      existingPhoneFieldKey: null,
      existingReviewerUserId: null,
      roleId: 'role-1',
      nameFieldKey: 'full_name',
      emailFieldKey: 'email',
    })).resolves.toBe('upserted');

    expect(execute).toHaveBeenCalledOnce();
    expect(dialect.sqlToQuery(execute.mock.calls[0][0]).sql).toContain('ON CONFLICT (form_id) DO UPDATE');
  });

  it('removes only the previously loaded role association when explicitly cleared', async () => {
    const execute = vi.fn(async (_query: SQL) => []);

    await expect(saveFormRoleLink({ execute }, {
      ...baseLink,
      existingRoleId: 'role-1',
    })).resolves.toBe('removed');

    expect(execute).toHaveBeenCalledOnce();
    const query = dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain('DELETE FROM form_role_links');
    expect(query.sql).toContain('WHERE form_id = $1 AND role_id = $2');
    expect(query.params).toEqual(['form-1', 'role-1']);
  });

  it('propagates database errors so the enclosing form transaction cannot report success', async () => {
    const databaseError = Object.assign(new Error('permission denied'), { code: '42501' });
    const execute = vi.fn(async (_query: SQL) => {
      throw databaseError;
    });

    await expect(saveFormRoleLink({ execute }, {
      ...baseLink,
      existingRoleId: 'role-1',
    })).rejects.toBe(databaseError);
  });
});
