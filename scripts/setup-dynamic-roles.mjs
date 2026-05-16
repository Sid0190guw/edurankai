import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== Dynamic role system DB setup ===\n");

// 1. Custom roles (created by admins, not hardcoded)
await sql`
  CREATE TABLE IF NOT EXISTS team_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(80) NOT NULL UNIQUE,
    description text,
    color varchar(20) NOT NULL DEFAULT 'orange',
    is_system boolean NOT NULL DEFAULT false,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    updated_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS team_roles_name_idx ON team_roles(name)`;
console.log("team_roles table ready");

// 2. Permissions per role per page-key
await sql`
  CREATE TABLE IF NOT EXISTS role_permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id uuid NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
    page_key varchar(80) NOT NULL,
    can_view boolean NOT NULL DEFAULT false,
    can_edit boolean NOT NULL DEFAULT false,
    can_delete boolean NOT NULL DEFAULT false,
    can_export boolean NOT NULL DEFAULT false,
    UNIQUE(role_id, page_key)
  )
`;
await sql`CREATE INDEX IF NOT EXISTS role_perms_role_idx ON role_permissions(role_id)`;
console.log("role_permissions table ready");

// 3. Many-to-many: users ↔ custom roles
await sql`
  CREATE TABLE IF NOT EXISTS user_role_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
    assigned_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    assigned_at timestamp with time zone NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, role_id)
  )
`;
await sql`CREATE INDEX IF NOT EXISTS user_role_user_idx ON user_role_assignments(user_id)`;
await sql`CREATE INDEX IF NOT EXISTS user_role_role_idx ON user_role_assignments(role_id)`;
console.log("user_role_assignments table ready");

console.log("\nDB ready for dynamic role system (additive — existing role enum unaffected).");
await sql.end();
