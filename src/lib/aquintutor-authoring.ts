// AquinTutor full-scale authoring system.
// Implements: modules → lessons → blocks (block-based content), authoring
// versions, per-lesson progress, per-lesson discussions, quiz attempts.
// Self-bootstrapping schema — first call to any helper installs the tables.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
// Run one statement, swallow its error so a single failure never aborts the
// rest of the bootstrap. (Previously all statements shared one try-block, so
// one early ALTER failure skipped every later ALTER and left columns missing.)
async function ex(q: any): Promise<void> { try { await db.execute(q); } catch (_) {} }
export function ensureAquintutorAuthoringSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    {
      // Modules — sections inside a course.
      await ex(sql`CREATE TABLE IF NOT EXISTS training_modules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
        title VARCHAR(300) NOT NULL,
        summary TEXT,
        order_in_course INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // Prod may already have an older training_modules using sort_order; add
      // order_in_course so the authoring helpers (which order by it) work.
      await ex(sql`ALTER TABLE training_modules ADD COLUMN IF NOT EXISTS order_in_course INT DEFAULT 0`);
      await ex(sql`ALTER TABLE training_modules ADD COLUMN IF NOT EXISTS summary TEXT`);
      await ex(sql`ALTER TABLE training_modules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
      await ex(sql`CREATE INDEX IF NOT EXISTS tm_course_idx ON training_modules(course_id, order_in_course)`);

      // Per-lesson additions (idempotent ALTER).
      await ex(sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS module_id UUID`);
      await ex(sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'draft'`);
      await ex(sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS lesson_kind VARCHAR(20) DEFAULT 'lesson'`);
      await ex(sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS preview_allowed BOOLEAN DEFAULT false`);
      await ex(sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS order_in_module INT DEFAULT 0`);
      await ex(sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS estimated_minutes INT DEFAULT 10`);
      await ex(sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`);

      // Course additions.
      await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS cover_image_url TEXT`);
      await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS target_audience TEXT`);
      await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS learning_outcomes JSONB`);
      await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS prerequisites TEXT`);
      await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS total_minutes INT DEFAULT 0`);
      await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS school VARCHAR(80)`);
      await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS difficulty VARCHAR(20) DEFAULT 'beginner'`);
      // Per-course attached virtual labs (array of lab slugs) surfaced on the course Labs tab.
      await ex(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS featured_labs JSONB DEFAULT '[]'::jsonb`);

      // Lesson blocks — the editorial primitives. Each block has a kind and a JSONB content payload.
      await ex(sql`CREATE TABLE IF NOT EXISTS training_lesson_blocks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lesson_id UUID NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE,
        kind VARCHAR(30) NOT NULL,
          -- text | heading | image | video_embed | callout | code | mcq | fill_blank | order_steps | file_attachment | divider | quote | latex
        position INT NOT NULL DEFAULT 0,
        content JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await ex(sql`CREATE INDEX IF NOT EXISTS tlb_lesson_idx ON training_lesson_blocks(lesson_id, position)`);

      // Authoring — assign authors / editors / reviewers per course.
      await ex(sql`CREATE TABLE IF NOT EXISTS training_course_authors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'author',
          -- author | editor | reviewer
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(course_id, user_id)
      )`);

      // Lesson versions — auto-snapshot on publish.
      await ex(sql`CREATE TABLE IF NOT EXISTS training_lesson_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lesson_id UUID NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE,
        version INT NOT NULL,
        blocks_snapshot JSONB NOT NULL,
        meta_snapshot JSONB,
        edited_by_user_id UUID,
        edited_by_name VARCHAR(200),
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await ex(sql`CREATE INDEX IF NOT EXISTS tlv_lesson_idx ON training_lesson_versions(lesson_id, version DESC)`);

      // Per-user lesson progress.
      await ex(sql`CREATE TABLE IF NOT EXISTS training_lesson_progress (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        lesson_id UUID NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE,
        course_id UUID,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        time_spent_seconds INT NOT NULL DEFAULT 0,
        last_block_id UUID,
        last_position_seconds INT DEFAULT 0,
        UNIQUE(user_id, lesson_id)
      )`);
      await ex(sql`CREATE INDEX IF NOT EXISTS tlp_user_idx ON training_lesson_progress(user_id, course_id)`);

      // Per-lesson discussions (threaded by parent_id).
      await ex(sql`CREATE TABLE IF NOT EXISTS training_lesson_discussions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lesson_id UUID NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        parent_id UUID,
        body TEXT NOT NULL,
        is_instructor BOOLEAN NOT NULL DEFAULT false,
        upvotes INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await ex(sql`CREATE INDEX IF NOT EXISTS tld_lesson_idx ON training_lesson_discussions(lesson_id, created_at DESC)`);

      // Inline-quiz attempts (a block of kind=mcq is one question; this records attempts).
      await ex(sql`CREATE TABLE IF NOT EXISTS training_quiz_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        lesson_id UUID NOT NULL,
        block_id UUID NOT NULL,
        chosen JSONB,
        is_correct BOOLEAN,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await ex(sql`CREATE INDEX IF NOT EXISTS tqa_user_lesson_idx ON training_quiz_attempts(user_id, lesson_id)`);
    }  })();
  return ready;
}

// ============ Block CRUD ============
export interface BlockInput { kind: string; content: any; position?: number; }

export async function listBlocks(lessonId: string) {
  await ensureAquintutorAuthoringSchema();
  return rows(await db.execute(sql`SELECT id, kind, position, content FROM training_lesson_blocks WHERE lesson_id = ${lessonId} ORDER BY position ASC, created_at ASC`));
}

export async function createBlock(lessonId: string, opts: BlockInput) {
  await ensureAquintutorAuthoringSchema();
  // Auto-position to end if not specified.
  let pos = opts.position;
  if (pos == null) {
    const r = rows(await db.execute(sql`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM training_lesson_blocks WHERE lesson_id = ${lessonId}`));
    pos = r[0]?.p ?? 0;
  }
  const r = rows(await db.execute(sql`
    INSERT INTO training_lesson_blocks (lesson_id, kind, position, content)
    VALUES (${lessonId}, ${opts.kind}, ${pos}, ${JSON.stringify(opts.content || {})}::jsonb)
    RETURNING id, kind, position, content
  `));
  return r[0];
}

export async function updateBlock(blockId: string, patch: { kind?: string; content?: any; position?: number }) {
  await ensureAquintutorAuthoringSchema();
  if (patch.kind != null) await db.execute(sql`UPDATE training_lesson_blocks SET kind = ${patch.kind}, updated_at = NOW() WHERE id = ${blockId}`);
  if (patch.content != null) await db.execute(sql`UPDATE training_lesson_blocks SET content = ${JSON.stringify(patch.content)}::jsonb, updated_at = NOW() WHERE id = ${blockId}`);
  if (patch.position != null) await db.execute(sql`UPDATE training_lesson_blocks SET position = ${patch.position}, updated_at = NOW() WHERE id = ${blockId}`);
}

export async function deleteBlock(blockId: string) {
  await ensureAquintutorAuthoringSchema();
  await db.execute(sql`DELETE FROM training_lesson_blocks WHERE id = ${blockId}`);
}

export async function reorderBlocks(lessonId: string, idsInOrder: string[]) {
  await ensureAquintutorAuthoringSchema();
  for (let i = 0; i < idsInOrder.length; i++) {
    await db.execute(sql`UPDATE training_lesson_blocks SET position = ${i}, updated_at = NOW() WHERE id = ${idsInOrder[i]} AND lesson_id = ${lessonId}`);
  }
}

// ============ Lesson lifecycle ============
export async function publishLesson(opts: { lessonId: string; byUserId: string; byName: string; notes?: string }) {
  await ensureAquintutorAuthoringSchema();
  const blocks = await listBlocks(opts.lessonId);
  const v = rows(await db.execute(sql`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM training_lesson_versions WHERE lesson_id = ${opts.lessonId}`))[0]?.v || 1;
  await db.execute(sql`
    INSERT INTO training_lesson_versions (lesson_id, version, blocks_snapshot, edited_by_user_id, edited_by_name, notes)
    VALUES (${opts.lessonId}, ${v}, ${JSON.stringify(blocks)}::jsonb, ${opts.byUserId}, ${opts.byName}, ${opts.notes || null})
  `);
  await db.execute(sql`UPDATE training_lessons SET status = 'published', published_at = NOW(), updated_at = NOW() WHERE id = ${opts.lessonId}`);
}

export async function requestReview(lessonId: string) {
  await ensureAquintutorAuthoringSchema();
  await db.execute(sql`UPDATE training_lessons SET status = 'in_review', updated_at = NOW() WHERE id = ${lessonId}`);
}

// ============ Version history ============
// Snapshot the current blocks as a new version (without changing publish status).
export async function saveVersion(opts: { lessonId: string; byUserId?: string; byName?: string; notes?: string }) {
  await ensureAquintutorAuthoringSchema();
  const blocks = await listBlocks(opts.lessonId);
  const v = rows(await db.execute(sql`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM training_lesson_versions WHERE lesson_id = ${opts.lessonId}`))[0]?.v || 1;
  const r = rows(await db.execute(sql`
    INSERT INTO training_lesson_versions (lesson_id, version, blocks_snapshot, edited_by_user_id, edited_by_name, notes)
    VALUES (${opts.lessonId}, ${v}, ${JSON.stringify(blocks)}::jsonb, ${opts.byUserId || null}, ${opts.byName || null}, ${opts.notes || 'Manual save'})
    RETURNING id, version, created_at
  `));
  return { version: v, ...(r[0] || {}), blockCount: blocks.length };
}

export async function listVersions(lessonId: string) {
  await ensureAquintutorAuthoringSchema();
  return rows(await db.execute(sql`
    SELECT id, version, edited_by_name, notes, created_at,
      jsonb_array_length(COALESCE(blocks_snapshot, '[]'::jsonb)) AS block_count
    FROM training_lesson_versions WHERE lesson_id = ${lessonId} ORDER BY version DESC LIMIT 50`));
}

// Restore a version: snapshot the current state first (so restore is reversible), then
// replace all current blocks with the snapshot's blocks. Returns the new block set.
export async function restoreVersion(opts: { lessonId: string; versionId: string; byUserId?: string; byName?: string }) {
  await ensureAquintutorAuthoringSchema();
  const snapRow = rows(await db.execute(sql`SELECT version, blocks_snapshot FROM training_lesson_versions WHERE id = ${opts.versionId} AND lesson_id = ${opts.lessonId} LIMIT 1`))[0];
  if (!snapRow) throw new Error('version not found');
  // Snapshot current state before we overwrite it.
  await saveVersion({ lessonId: opts.lessonId, byUserId: opts.byUserId, byName: opts.byName, notes: 'Auto-snapshot before restore of v' + snapRow.version });
  let snap = snapRow.blocks_snapshot;
  if (typeof snap === 'string') { try { snap = JSON.parse(snap); } catch { snap = []; } }
  if (!Array.isArray(snap)) snap = [];
  await db.execute(sql`DELETE FROM training_lesson_blocks WHERE lesson_id = ${opts.lessonId}`);
  for (let i = 0; i < snap.length; i++) {
    const b: any = snap[i];
    await db.execute(sql`
      INSERT INTO training_lesson_blocks (lesson_id, kind, position, content)
      VALUES (${opts.lessonId}, ${b.kind}, ${i}, ${JSON.stringify(b.content || {})}::jsonb)`);
  }
  await db.execute(sql`UPDATE training_lessons SET updated_at = NOW() WHERE id = ${opts.lessonId}`);
  return await listBlocks(opts.lessonId);
}

// ============ Progress ============
export async function markLessonComplete(opts: { userId: string; lessonId: string; courseId?: string; timeSpentSeconds?: number }) {
  await ensureAquintutorAuthoringSchema();
  await db.execute(sql`
    INSERT INTO training_lesson_progress (user_id, lesson_id, course_id, completed_at, time_spent_seconds)
    VALUES (${opts.userId}, ${opts.lessonId}, ${opts.courseId || null}, NOW(), ${opts.timeSpentSeconds || 0})
    ON CONFLICT (user_id, lesson_id) DO UPDATE
      SET completed_at = COALESCE(training_lesson_progress.completed_at, NOW()),
        time_spent_seconds = training_lesson_progress.time_spent_seconds + EXCLUDED.time_spent_seconds
  `);
}

export async function getCourseProgress(userId: string, courseId: string) {
  await ensureAquintutorAuthoringSchema();
  const r = rows(await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM training_lessons WHERE course_id = ${courseId} AND status = 'published') AS total,
      (SELECT COUNT(*)::int FROM training_lesson_progress p
        JOIN training_lessons l ON p.lesson_id = l.id
        WHERE p.user_id = ${userId} AND l.course_id = ${courseId} AND p.completed_at IS NOT NULL) AS completed
  `));
  return { total: r[0]?.total || 0, completed: r[0]?.completed || 0 };
}

// ============ Modules ============
export async function listModules(courseId: string) {
  await ensureAquintutorAuthoringSchema();
  // Resilient: prod may still carry the legacy training_modules (sort_order)
  // before the order_in_course column lands. Fall back rather than 500.
  try {
    return rows(await db.execute(sql`SELECT * FROM training_modules WHERE course_id = ${courseId} ORDER BY order_in_course ASC, created_at ASC`));
  } catch {
    try { return rows(await db.execute(sql`SELECT * FROM training_modules WHERE course_id = ${courseId} ORDER BY created_at ASC`)); }
    catch { return []; }
  }
}

export async function createModule(opts: { courseId: string; title: string; summary?: string; order?: number }) {
  await ensureAquintutorAuthoringSchema();
  let order = opts.order;
  if (order == null) {
    try { order = rows(await db.execute(sql`SELECT COALESCE(MAX(order_in_course), -1) + 1 AS o FROM training_modules WHERE course_id = ${opts.courseId}`))[0]?.o ?? 0; }
    catch { order = 0; }
  }
  // Try full insert; fall back to the minimal columns if order_in_course/summary are absent.
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO training_modules (course_id, title, summary, order_in_course)
      VALUES (${opts.courseId}, ${opts.title}, ${opts.summary || null}, ${order})
      RETURNING id`));
    return r[0]?.id;
  } catch {
    try {
      const r = rows(await db.execute(sql`INSERT INTO training_modules (course_id, title) VALUES (${opts.courseId}, ${opts.title}) RETURNING id`));
      return r[0]?.id;
    } catch { return null; }
  }
}

// ============ Discussions ============
export async function postDiscussion(opts: { lessonId: string; userId: string; body: string; parentId?: string; isInstructor?: boolean }) {
  await ensureAquintutorAuthoringSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO training_lesson_discussions (lesson_id, user_id, parent_id, body, is_instructor)
    VALUES (${opts.lessonId}, ${opts.userId}, ${opts.parentId || null}, ${opts.body.slice(0, 8000)}, ${!!opts.isInstructor})
    RETURNING id
  `));
  return r[0]?.id;
}

export async function listDiscussions(lessonId: string) {
  await ensureAquintutorAuthoringSchema();
  return rows(await db.execute(sql`
    SELECT d.*, u.name AS user_name FROM training_lesson_discussions d
    LEFT JOIN users u ON d.user_id = u.id
    WHERE d.lesson_id = ${lessonId} ORDER BY d.created_at ASC LIMIT 500
  `));
}

// ============ Quiz attempts (for inline mcq blocks) ============
export async function recordQuizAttempt(opts: { userId: string; lessonId: string; blockId: string; chosen: any; isCorrect: boolean }) {
  await ensureAquintutorAuthoringSchema();
  await db.execute(sql`
    INSERT INTO training_quiz_attempts (user_id, lesson_id, block_id, chosen, is_correct)
    VALUES (${opts.userId}, ${opts.lessonId}, ${opts.blockId}, ${JSON.stringify(opts.chosen)}::jsonb, ${opts.isCorrect})
  `);
}

// ============ Block kinds — catalogue + default content ============
export const BLOCK_KINDS = {
  text:          { label: 'Paragraph',       defaults: { md: '' } },
  heading:       { label: 'Heading',         defaults: { level: 2, text: '' } },
  image:         { label: 'Image',           defaults: { url: '', alt: '', caption: '' } },
  video_embed:   { label: 'Video',           defaults: { provider: 'youtube', url: '', caption: '' } },
  callout:       { label: 'Callout',         defaults: { tone: 'info', title: '', body: '' } },
  code:          { label: 'Code',            defaults: { language: 'python', code: '' } },
  mcq:           { label: 'Multiple choice', defaults: { question: '', options: ['', ''], correct: 0, explanation: '' } },
  fill_blank:    { label: 'Fill blank',      defaults: { prompt: '', answer: '', tolerance: 0 } },
  order_steps:   { label: 'Order steps',     defaults: { question: '', steps: [''] } },
  file_attachment:{ label: 'File',           defaults: { url: '', name: '' } },
  divider:       { label: 'Divider',         defaults: {} },
  quote:         { label: 'Quote',           defaults: { text: '', attribution: '' } },
  latex:         { label: 'LaTeX',           defaults: { tex: '' } },
  // ---- connectors: embed an interactive surface directly in the lesson -------
  embed_lab:       { label: 'Lab connector',       defaults: { slug: 'pendulum', height: 620, caption: '' } },
  embed_simulator: { label: 'Simulator connector', defaults: { target: 'quantum/composer', height: 700, caption: '' } },
  embed_test:      { label: 'Test connector',      defaults: { slug: '', label: 'Take the test', mode: 'button' } },
  embed_liveclass: { label: 'Live class connector',defaults: { roomId: '', label: 'Join the live class' } },
  embed_animation: { label: 'Animation studio',    defaults: { scene: '', height: 640, caption: '' } },
} as const;

// Catalogue the connectors can pick from (kept here so the editor + player agree).
export const LAB_CATALOGUE = [
  // hands-on benches + engineering workbenches (lead the list)
  'logic-bench','eee-bench','cro-bench','optics-bench','titration-bench',
  'vlsi','eee','cybersecurity','ai-ml','robotics','mechanical',
  'fluid-bench','reaction-bench','biotech-bench','dsa-bench',
  'signals-systems','control-systems','dsp','os','networks','machines','structural','numerical',
  'fluid-bench','reaction-bench','biotech-bench','dsa-bench',
  // foundational simulators
  'pendulum','projectile','optics','circuit','logic-gates','titration','periodic',
  'molecular','genetics','ecosystem','plot','linear-algebra','sorting','pathfinding',
  'neural-net','fourier','animator',
];
export const SIMULATOR_CATALOGUE = [
  { target: 'quantum/composer', label: 'Quantum circuit composer' },
  { target: 'hpc/simulator',    label: 'HPC job simulator' },
  { target: 'teach',            label: 'Live teaching canvas (real-time animation)' },
  { target: 'labs/animator',    label: 'Animation studio' },
  { target: 'labs/neural-net',  label: 'Neural network playground' },
  { target: 'labs/circuit',     label: 'Circuit builder' },
];

// Display names for every embeddable lab — shared by the course editor's lab
// picker and the student course "Labs" tab so they always agree.
export const LAB_LABELS: { [slug: string]: string } = {
  'logic-bench': 'Digital Logic Workbench', 'eee-bench': 'Analog Electronics Workbench',
  'cro-bench': 'Oscilloscope + Function Gen', 'optics-bench': 'Optical Bench', 'titration-bench': 'Titration Bench',
  'vlsi': 'VLSI & Digital Design', 'eee': 'Electrical & Electronics', 'cybersecurity': 'Cybersecurity',
  'ai-ml': 'AI & Machine Learning', 'robotics': 'Robotics & AI', 'mechanical': 'Mechanical Engineering',
  'fluid-bench': 'Fluid Mechanics & Hydraulics', 'reaction-bench': 'Chemical Reaction Engineering',
  'biotech-bench': 'Molecular Biology', 'dsa-bench': 'Data Structures & Algorithms',
  'pendulum': 'Pendulum & SHM', 'projectile': 'Projectile Motion', 'optics': 'Ray Optics',
  'circuit': 'Circuit Builder', 'logic-gates': 'Logic Gate Builder', 'titration': 'Acid-Base Titration',
  'periodic': 'Periodic Table', 'molecular': 'Molecular Viewer', 'genetics': 'Punnett Square',
  'ecosystem': 'Predator-Prey', 'plot': 'Function Plotter', 'linear-algebra': 'Matrix Transforms',
  'sorting': 'Sorting Visualiser', 'pathfinding': 'Path-finding', 'neural-net': 'Neural Network Playground',
  'fourier': 'Fourier Series', 'animator': 'Animation Studio',
};
export function labLabel(slug: string): string { return LAB_LABELS[slug] || slug; }

// Per-course featured virtual labs (slug array). Bootstrapped column on training_courses.
export async function getCourseLabs(courseId: string): Promise<string[]> {
  await ensureAquintutorAuthoringSchema();
  try {
    const r = rows(await db.execute(sql`SELECT featured_labs FROM training_courses WHERE id = ${courseId} LIMIT 1`));
    let v: any = r[0]?.featured_labs;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
  } catch { return []; }
}
export async function setCourseLabs(courseId: string, slugs: string[]): Promise<void> {
  await ensureAquintutorAuthoringSchema();
  const clean = Array.from(new Set((slugs || []).filter((s) => typeof s === 'string' && LAB_LABELS[s]))).slice(0, 40);
  await db.execute(sql`UPDATE training_courses SET featured_labs = ${JSON.stringify(clean)}::jsonb, updated_at = NOW() WHERE id = ${courseId}`);
}
