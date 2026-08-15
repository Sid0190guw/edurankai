// src/lib/lms/interop.test.ts — the parsers, tested without a database or a network.
import { describe, it, expect } from 'vitest';
import {
  parseXapiStatement, parseIso8601Duration, parseScormManifest, manifestPlan,
  parseRosterCsv, buildGradeCsv, csvCell,
} from './interop';
import { normaliseLinks, countWords } from './assignments';

describe('parseXapiStatement', () => {
  it('takes the last segment of a verb IRI', () => {
    const out = parseXapiStatement({
      actor: { name: 'A Learner', mbox: 'mailto:a@example.com' },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed' },
      object: { id: 'http://example.com/act/1', definition: { name: { 'en-US': 'Module 1' } } },
    });
    expect(out.ok).toBe(true);
    expect(out.value?.verb).toBe('completed');
    expect(out.value?.objectName).toBe('Module 1');
  });

  it('derives a scaled score from raw and max when scaled is absent', () => {
    const out = parseXapiStatement({
      verb: { id: 'scored' }, object: { id: 'x' },
      result: { score: { raw: 8, max: 10 } },
    });
    expect(out.value?.scoreScaled).toBe(0.8);
  });

  it('rejects a statement with no object id rather than storing a blank', () => {
    expect(parseXapiStatement({ verb: { id: 'x' } }).ok).toBe(false);
  });

  it('rejects a statement with no verb', () => {
    expect(parseXapiStatement({ object: { id: 'x' } }).ok).toBe(false);
  });

  it('falls back to the mbox for an actor with no name', () => {
    const out = parseXapiStatement({ actor: { mbox: 'mailto:b@example.com' }, verb: { id: 'v' }, object: { id: 'o' } });
    expect(out.value?.actorName).toBe('b@example.com');
  });
});

describe('parseIso8601Duration', () => {
  it('reads hours, minutes and seconds', () => {
    expect(parseIso8601Duration('PT1H30M12S')).toBe(5412);
  });
  it('reads days', () => {
    expect(parseIso8601Duration('P1DT1H')).toBe(90000);
  });
  it('returns null on anything it cannot read', () => {
    expect(parseIso8601Duration('90 minutes')).toBeNull();
    expect(parseIso8601Duration('')).toBeNull();
  });
});

describe('parseScormManifest', () => {
  const xml = `<?xml version="1.0"?>
    <manifest identifier="M1">
      <organizations default="ORG">
        <organization identifier="ORG">
          <title>Workplace Safety</title>
          <item identifier="I1">
            <title>Unit 1</title>
            <item identifier="I1a" identifierref="R1"><title>Hazards</title></item>
            <item identifier="I1b" identifierref="R2"><title>Reporting</title></item>
          </item>
          <item identifier="I2" identifierref="R3"><title>Assessment</title></item>
        </organization>
      </organizations>
      <resources>
        <resource identifier="R1" href="content/hazards.html"/>
        <resource identifier="R2" href="content/reporting.html"/>
        <resource identifier="R3" href="content/quiz.html"/>
      </resources>
    </manifest>`;

  it('reads the package title', () => {
    expect(parseScormManifest(xml).title).toBe('Workplace Safety');
  });

  it('keeps nesting rather than flattening every item to the top', () => {
    const m = parseScormManifest(xml);
    expect(m.items.length).toBe(2);
    expect(m.items[0].children.length).toBe(2);
    expect(m.items[0].children[0].title).toBe('Hazards');
  });

  it('resolves identifierref to the resource href', () => {
    const m = parseScormManifest(xml);
    expect(m.items[0].children[1].href).toBe('content/reporting.html');
    expect(m.resourceCount).toBe(3);
  });

  it('survives an empty or malformed document without throwing', () => {
    expect(parseScormManifest('').items).toEqual([]);
    expect(parseScormManifest('<manifest><item>').items.length).toBe(1);
  });
});

describe('manifestPlan', () => {
  const manifest = parseScormManifest(`<manifest><organizations><organization><title>Pack</title>
    <item identifier="A"><title>Unit</title><item identifier="B" identifierref="R"><title>Page</title></item></item>
    </organization></organizations><resources><resource identifier="R" href="a/b.html"/></resources></manifest>`);

  it('makes a module of a parent item and lessons of its children', () => {
    const plan = manifestPlan(manifest);
    expect(plan[0].module).toBe('Unit');
    expect(plan[0].lessons[0].title).toBe('Page');
  });

  it('absolutises relative hrefs against the base url', () => {
    const plan = manifestPlan(manifest, 'https://files.example.com/pack/');
    expect(plan[0].lessons[0].href).toBe('https://files.example.com/pack/a/b.html');
  });

  it('leaves an absolute href alone', () => {
    const m = parseScormManifest(`<manifest><organizations><organization><title>P</title>
      <item identifier="A" identifierref="R"><title>Page</title></item></organization></organizations>
      <resources><resource identifier="R" href="https://cdn.example.com/x.html"/></resources></manifest>`);
    expect(manifestPlan(m, 'https://files.example.com')[0].lessons[0].href).toBe('https://cdn.example.com/x.html');
  });
});

describe('parseRosterCsv', () => {
  it('accepts bare emails, skips a header, and defaults the role', () => {
    const out = parseRosterCsv('email\na@example.com\nb@example.com,Bee');
    expect(out.rows.length).toBe(2);
    expect(out.rows[1].name).toBe('Bee');
    expect(out.rows[0].role).toBe('student');
  });

  it('reports bad lines instead of dropping them silently', () => {
    const out = parseRosterCsv('a@example.com\nnot-an-email\n');
    expect(out.rows.length).toBe(1);
    expect(out.errors[0].reason).toBe('not an email address');
    expect(out.errors[0].line).toBe(2);
  });

  it('reports duplicates', () => {
    const out = parseRosterCsv('a@example.com\nA@Example.com');
    expect(out.rows.length).toBe(1);
    expect(out.errors[0].reason).toBe('duplicate of an earlier line');
  });

  it('accepts tabs as well as commas and normalises an unknown role', () => {
    const out = parseRosterCsv('a@example.com\tAnn\tprofessor');
    expect(out.rows[0].name).toBe('Ann');
    expect(out.rows[0].role).toBe('student');
  });

  it('keeps a recognised staff role', () => {
    expect(parseRosterCsv('a@example.com,Ann,instructor').rows[0].role).toBe('instructor');
  });
});

describe('buildGradeCsv', () => {
  const matrix = {
    assignments: [{ id: 'a1', title: 'Essay, first', points: 50 }],
    students: [
      { name: 'Ann', email: 'a@example.com', cells: [{ assignmentId: 'a1', points: 45, excused: false }], total: { pct: 90, letter: 'A-' } },
      { name: 'Bo', email: 'b@example.com', cells: [{ assignmentId: 'a1', points: null, excused: true }], total: { pct: null, letter: 'not graded yet' } },
    ],
  };

  it('quotes a title containing a comma', () => {
    expect(buildGradeCsv(matrix).split('\r\n')[0]).toContain('"Essay, first (50)"');
  });

  it('writes the score, the course percentage and the letter', () => {
    expect(buildGradeCsv(matrix).split('\r\n')[1]).toBe('Ann,a@example.com,45,90,A-');
  });

  it('writes an excused cell as excused, not as zero', () => {
    expect(buildGradeCsv(matrix).split('\r\n')[2]).toContain('excused');
  });

  it('escapes an embedded quote by doubling it', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('normaliseLinks', () => {
  it('keeps http and https and drops duplicates', () => {
    const out = normaliseLinks(['https://drive.example.com/a', 'https://drive.example.com/a']);
    expect(out.links.length).toBe(1);
  });

  it('rejects a javascript url rather than rendering it into a grading screen', () => {
    const out = normaliseLinks(['javascript:alert(1)']);
    expect(out.links.length).toBe(0);
    expect(out.rejected.length).toBe(1);
  });

  it('rejects a local file path a grader could never open', () => {
    expect(normaliseLinks(['C:/Users/me/essay.docx']).links.length).toBe(0);
  });

  it('splits a pasted string on whitespace and commas', () => {
    expect(normaliseLinks('https://a.example.com, https://b.example.com').links.length).toBe(2);
  });

  it('caps the list so one paste cannot fill a row', () => {
    const many = Array.from({ length: 30 }, (_, i) => 'https://example.com/' + i);
    expect(normaliseLinks(many).links.length).toBe(10);
  });
});

describe('countWords', () => {
  it('counts words, not characters, and treats blank as zero', () => {
    expect(countWords('  one   two three ')).toBe(3);
    expect(countWords('   ')).toBe(0);
  });
});
