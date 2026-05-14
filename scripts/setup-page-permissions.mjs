import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// 1. Create table
console.log("Creating role_page_permissions table...");
await sql`
  CREATE TABLE IF NOT EXISTS role_page_permissions (
    role varchar(50) NOT NULL,
    page_id varchar(50) NOT NULL,
    can_view boolean NOT NULL DEFAULT false,
    can_edit boolean NOT NULL DEFAULT false,
    updated_at timestamp with time zone NOT NULL DEFAULT NOW(),
    updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (role, page_id)
  )
`;
console.log("  table ready");

// 2. Define default permissions matrix
// pages: dashboard, applications, offers, roles, departments, events, products, content, users, audit, settings, contact
const PAGES = ["dashboard", "applications", "offers", "roles", "departments", "events", "products", "content", "users", "audit", "settings", "contact"];

const MATRIX = {
  super_admin:    { dashboard:[1,1], applications:[1,1], offers:[1,1], roles:[1,1], departments:[1,1], events:[1,1], products:[1,1], content:[1,1], users:[1,1], audit:[1,1], settings:[1,1], contact:[1,1] },
  hr:             { dashboard:[1,0], applications:[1,1], offers:[1,1], roles:[1,1], departments:[1,0], events:[1,1], products:[0,0], content:[1,0], users:[0,0], audit:[0,0], settings:[0,0], contact:[1,1] },
  recruiter:      { dashboard:[1,0], applications:[1,1], offers:[1,0], roles:[1,0], departments:[1,0], events:[0,0], products:[0,0], content:[0,0], users:[0,0], audit:[0,0], settings:[0,0], contact:[0,0] },
  reviewer:       { dashboard:[1,0], applications:[1,1], offers:[1,0], roles:[1,0], departments:[1,0], events:[0,0], products:[0,0], content:[0,0], users:[0,0], audit:[0,0], settings:[0,0], contact:[0,0] },
  department_head:{ dashboard:[1,0], applications:[1,1], offers:[1,1], roles:[1,1], departments:[1,0], events:[1,1], products:[0,0], content:[0,0], users:[0,0], audit:[0,0], settings:[0,0], contact:[0,0] },
  marketing:      { dashboard:[1,0], applications:[0,0], offers:[0,0], roles:[0,0], departments:[0,0], events:[1,1], products:[1,1], content:[1,1], users:[0,0], audit:[0,0], settings:[0,0], contact:[1,0] },
  editor:         { dashboard:[1,0], applications:[0,0], offers:[0,0], roles:[1,0], departments:[1,0], events:[1,1], products:[1,1], content:[1,1], users:[0,0], audit:[0,0], settings:[0,0], contact:[0,0] }
};

// 3. Seed - only if row missing
console.log("\nSeeding role-page permissions...");
let added = 0, skipped = 0;
for (const [role, perms] of Object.entries(MATRIX)) {
  for (const page of PAGES) {
    const [view, edit] = perms[page] || [0,0];
    const existing = await sql`SELECT 1 FROM role_page_permissions WHERE role = ${role} AND page_id = ${page}`;
    if (existing.length === 0) {
      await sql`
        INSERT INTO role_page_permissions (role, page_id, can_view, can_edit)
        VALUES (${role}, ${page}, ${view === 1}, ${edit === 1})
      `;
      added++;
    } else {
      skipped++;
    }
  }
}
console.log("  added: " + added + " | already existed: " + skipped);

// 4. Verify
console.log("\nFinal matrix (can_view summary):");
const rows = await sql`SELECT role, page_id, can_view FROM role_page_permissions ORDER BY role, page_id`;
const byRole = {};
rows.forEach(r => {
  if (!byRole[r.role]) byRole[r.role] = [];
  if (r.can_view) byRole[r.role].push(r.page_id);
});
for (const [role, pages] of Object.entries(byRole)) {
  console.log("  " + role + ": " + pages.join(", "));
}

await sql.end();
