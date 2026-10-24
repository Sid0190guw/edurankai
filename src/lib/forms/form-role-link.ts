import { sql, type SQL } from 'drizzle-orm';

export type FormRoleLinkExecutor = {
  execute(query: SQL): Promise<unknown>;
};

export type FormRoleLinkSave = {
  available: boolean;
  formId: string;
  existingRoleId: string | null;
  existingNameFieldKey: string | null;
  existingEmailFieldKey: string | null;
  existingPhoneFieldKey: string | null;
  existingReviewerUserId: string | null;
  roleId: string;
  nameFieldKey: string;
  emailFieldKey: string;
  phoneFieldKey: string | null;
  reviewerUserId: string | null;
  createdBy: string;
};

export async function saveFormRoleLink(
  tx: FormRoleLinkExecutor,
  link: FormRoleLinkSave,
): Promise<'upserted' | 'removed' | 'unchanged'> {
  if (!link.available) return 'unchanged';

  if (link.roleId) {
    if (
      link.roleId === link.existingRoleId &&
      link.nameFieldKey === link.existingNameFieldKey &&
      link.emailFieldKey === link.existingEmailFieldKey &&
      link.phoneFieldKey === link.existingPhoneFieldKey &&
      link.reviewerUserId === link.existingReviewerUserId
    ) {
      return 'unchanged';
    }

    await tx.execute(sql`
      INSERT INTO form_role_links (form_id, role_id, name_field_key, email_field_key, phone_field_key, reviewer_user_id, created_by, updated_at)
      VALUES (${link.formId}, ${link.roleId}, ${link.nameFieldKey}, ${link.emailFieldKey}, ${link.phoneFieldKey}, ${link.reviewerUserId}, ${link.createdBy}, NOW())
      ON CONFLICT (form_id) DO UPDATE SET
        role_id = EXCLUDED.role_id,
        name_field_key = EXCLUDED.name_field_key,
        email_field_key = EXCLUDED.email_field_key,
        phone_field_key = EXCLUDED.phone_field_key,
        reviewer_user_id = EXCLUDED.reviewer_user_id,
        updated_at = NOW()
    `);
    return 'upserted';
  }

  if (!link.existingRoleId) return 'unchanged';

  await tx.execute(sql`
    DELETE FROM form_role_links
    WHERE form_id = ${link.formId} AND role_id = ${link.existingRoleId}
  `);
  return 'removed';
}
