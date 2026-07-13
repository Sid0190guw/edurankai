// src/lib/credential-store.ts — persistence for the Credential Recognition & Transfer
// admin tool. Self-bootstraps its tables so it works on any environment without a
// migration. Postgres-js returns plain arrays — always normalised. Feeds real rows
// into the Ch11 engine (src/lib/credit-transfer.ts).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import type { Institution, Credential, Recognition, GradeSystem, CreditSystem } from '@/lib/credit-transfer';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready = false;
export async function ensure() {
  if (ready) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS cr_institutions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT,
    grade_system TEXT NOT NULL DEFAULT 'gpa4', credit_system TEXT NOT NULL DEFAULT 'us',
    accreditation TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS cr_recognitions (
    by_inst TEXT NOT NULL, of_inst TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (by_inst, of_inst))`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS cr_credentials (
    id BIGSERIAL PRIMARY KEY, issuer TEXT NOT NULL, learner TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'course', credits NUMERIC NOT NULL DEFAULT 0,
    grade NUMERIC, created_at TIMESTAMPTZ DEFAULT NOW())`);
  ready = true;
}

const slug = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'inst-' + Date.now();

export async function addInstitution(name: string, country: string, gradeSystem: GradeSystem, creditSystem: CreditSystem, accreditation: string) {
  await ensure();
  const id = slug(name);
  await db.execute(sql`INSERT INTO cr_institutions (id, name, country, grade_system, credit_system, accreditation)
    VALUES (${id}, ${name.slice(0, 160)}, ${country || null}, ${gradeSystem}, ${creditSystem}, ${accreditation || null})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country,
      grade_system = EXCLUDED.grade_system, credit_system = EXCLUDED.credit_system, accreditation = EXCLUDED.accreditation`);
  return id;
}

export async function listInstitutions(): Promise<Institution[]> {
  await ensure();
  return rows(await db.execute(sql`SELECT id, name, country, grade_system, credit_system, accreditation FROM cr_institutions ORDER BY name ASC`))
    .map((r: any) => ({ id: r.id, name: r.name, country: r.country, gradeSystem: r.grade_system, creditSystem: r.credit_system, accreditation: r.accreditation }));
}

export async function addRecognition(byInst: string, ofInst: string) {
  await ensure();
  if (byInst === ofInst) return;
  await db.execute(sql`INSERT INTO cr_recognitions (by_inst, of_inst) VALUES (${byInst}, ${ofInst}) ON CONFLICT DO NOTHING`);
}
export async function removeRecognition(byInst: string, ofInst: string) {
  await ensure();
  await db.execute(sql`DELETE FROM cr_recognitions WHERE by_inst = ${byInst} AND of_inst = ${ofInst}`);
}
export async function listRecognitions(): Promise<Recognition[]> {
  await ensure();
  return rows(await db.execute(sql`SELECT by_inst, of_inst FROM cr_recognitions`)).map((r: any) => ({ byInst: r.by_inst, ofInst: r.of_inst }));
}

export async function addCredential(issuer: string, learner: string, type: string, credits: number, grade: number | null) {
  await ensure();
  await db.execute(sql`INSERT INTO cr_credentials (issuer, learner, type, credits, grade)
    VALUES (${issuer}, ${learner.slice(0, 120)}, ${type.slice(0, 80) || 'course'}, ${credits}, ${grade})`);
}
export async function listCredentials(): Promise<Credential[]> {
  await ensure();
  return rows(await db.execute(sql`SELECT id, issuer, learner, type, credits, grade FROM cr_credentials ORDER BY id DESC`))
    .map((r: any) => ({ id: String(r.id), issuer: r.issuer, learner: r.learner, type: r.type, credits: Number(r.credits), grade: r.grade == null ? null : Number(r.grade) }));
}
export async function listLearners(): Promise<string[]> {
  await ensure();
  return rows(await db.execute(sql`SELECT DISTINCT learner FROM cr_credentials ORDER BY learner ASC`)).map((r: any) => r.learner);
}

// seed a couple of institutions + a credential so the tool is never an empty page
export async function seedIfEmpty() {
  await ensure();
  const n = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM cr_institutions`))[0]?.c || 0;
  if (n > 0) return;
  await addInstitution('State University (US)', 'US', 'gpa4', 'us', 'AccrX');
  await addInstitution('Technical University (EU)', 'DE', 'ects100', 'ects', 'AccrY');
  await addRecognition('technical-university-eu', 'state-university-us');
  await addCredential('state-university-us', 'learner-1', 'Thermodynamics', 3, 3.6);
  await addCredential('state-university-us', 'learner-1', 'Linear Algebra', 4, 3.2);
}
