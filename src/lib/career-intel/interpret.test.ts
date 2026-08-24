import { describe, it, expect } from 'vitest';
import { interpretText, splitClauses, extractQueryTerms, summarise } from './interpret';

describe('the opening sentence from the brief', () => {
  const TEXT = 'I like coding, mathematics and solving difficult problems, but I don\'t know what role suits me.';
  const r = interpretText(TEXT);

  it('reads something rather than nothing', () => {
    expect(r.empty).toBe(false);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('finds the fields that were named', () => {
    const keys = r.interests.map((i) => i.key);
    expect(keys).toContain('MATHEMATICS');
    expect(keys).toContain('BUILDING');
  });

  it('does not invent a career stage nobody stated', () => {
    expect(r.stage).toBe('unknown');
  });

  it('produces a summary that can be shown back before anything is acted on', () => {
    expect(r.summary.length).toBeGreaterThan(0);
  });
});

describe('negation inverts rather than disappearing', () => {
  it('reads "I do not want to work alone" as wanting company, not as wanting solitude', () => {
    const yes = interpretText('I prefer working alone in silence.');
    const no = interpretText('I do not want to work alone in silence.');
    expect(yes.dimensions.deep_focus.value).toBeGreaterThan(0.6);
    expect(no.dimensions.deep_focus.value).toBeLessThan(0.4);
  });

  it('still records a dimension the person spoke about negatively', () => {
    const r = interpretText('I really dislike rigid structure and process.');
    // The strongest thing in the sentence is about structure. Dropping the match would leave it unread.
    expect(r.dimensions.structure).toBeDefined();
    expect(r.dimensions.structure.value).toBeLessThan(0.4);
  });

  it('files a named field under avoid, and does not also file it as an interest', () => {
    const r = interpretText('I want AI research. I am not interested in finance or sales.');
    expect(r.interests.map((i) => i.key)).toContain('ARTIFICIAL_INTELLIGENCE');
    expect(r.avoid.map((a) => a.key)).toContain('FINANCE');
    expect(r.interests.map((i) => i.key)).not.toContain('FINANCE');
  });

  it('does not sweep an earlier positive into the avoidance window', () => {
    // "AI" appears BEFORE the negation. A sentence-wide negation test would file it under avoid.
    const r = interpretText('I want to do AI work, not sales.');
    expect(r.avoid.map((a) => a.key)).not.toContain('ARTIFICIAL_INTELLIGENCE');
  });
});

describe('context is kept instead of averaged away', () => {
  const TEXT = 'I prefer working alone when solving complex problems, but I need energetic people around me when brainstorming.';
  const r = interpretText(TEXT);

  it('records both situations rather than one blended answer', () => {
    const keys = r.contextDependencies.map((c) => c.context);
    expect(keys).toContain('deep_work');
    expect(keys).toContain('brainstorming');
  });

  it('keeps the person\'s own words against each situation', () => {
    for (const c of r.contextDependencies) expect(c.quote.length).toBeGreaterThan(3);
  });

  it('says out loud that the answer depends on the task', () => {
    expect(r.summary.some((s) => /depends/i.test(s))).toBe(true);
  });

  it('reads the two contexts differently from each other', () => {
    const deep = r.contextDependencies.find((c) => c.context === 'deep_work');
    const brainstorm = r.contextDependencies.find((c) => c.context === 'brainstorming');
    expect(deep?.dimensions.deep_focus).toBeGreaterThan(0.5);
    expect(brainstorm?.dimensions.social_energy ?? brainstorm?.dimensions.collaboration).toBeGreaterThan(0.5);
  });
});

describe('hedging and intensity move confidence, not the value', () => {
  it('is less sure about a hedged statement than a firm one', () => {
    const firm = interpretText('I want to do research.');
    const hedged = interpretText('I think maybe I want to do research.');
    expect(hedged.dimensions.research_orientation.confidence)
      .toBeLessThan(firm.dimensions.research_orientation.confidence);
  });

  it('lowers overall confidence when somebody says it depends', () => {
    const plain = interpretText('I like building systems.');
    const depends = interpretText('I like building systems, but it depends on the day.');
    expect(depends.confidence).toBeLessThan(plain.confidence);
  });
});

describe('what it reads out of plain descriptions', () => {
  it('picks up concrete tools without treating them as proof of competence', () => {
    const r = interpretText('I have used Python, PyTorch and a bit of ROS.');
    const keys = r.skills.map((s) => s.key);
    expect(keys).toContain('python');
    expect(keys).toContain('pytorch');
    expect(keys).toContain('ros');
    // A word is a claim. Nothing here is above the confidence a claim earns.
    for (const s of r.skills) expect(s.confidence).toBeLessThan(0.8);
  });

  it('does not match a tool inside an unrelated longer word', () => {
    const r = interpretText('I am going to a gorgeous rustic cafe.');
    const keys = r.skills.map((s) => s.key);
    expect(keys).not.toContain('go');
    expect(keys).not.toContain('rust');
    expect(keys).not.toContain('r');
  });

  it('reads a career stage when one is stated', () => {
    expect(interpretText('I am a final-year undergraduate.').stage).toBe('student');
    expect(interpretText('I am a fresher looking for my first job.').stage).toBe('early');
    expect(interpretText('I have 6 years of experience in embedded systems.').stage).toBe('experienced');
  });
});

describe('it fails honestly', () => {
  it('reports empty rather than manufacturing a reading', () => {
    const r = interpretText('asdkjh qwe zxcvb');
    expect(r.empty).toBe(true);
    expect(r.summary).toEqual([]);
    expect(r.confidence).toBe(0);
  });

  it('survives an empty string, whitespace and rubbish without throwing', () => {
    for (const t of ['', '   ', '\n\n', '!!!', '😀', 'a']) {
      expect(() => interpretText(t)).not.toThrow();
    }
  });

  it('still offers query terms so a plain search can run', () => {
    const r = interpretText('quantum photonics laboratory instrumentation');
    expect(r.queryTerms.length).toBeGreaterThan(0);
  });
});

describe('clause splitting', () => {
  it('does not split a list of interests into fragments', () => {
    expect(splitClauses('I like coding, mathematics and hard problems')).toEqual([
      'I like coding, mathematics and hard problems',
    ]);
  });

  it('splits on contrast and keeps each condition attached to its own preference', () => {
    const parts = splitClauses('I like quiet when I work but I like noise when I brainstorm');
    expect(parts).toEqual(['I like quiet when I work', 'I like noise when I brainstorm']);
  });

  it('does not cut a condition away from the preference it belongs to', () => {
    // Splitting on "when" was the original bug: it left the preference in one fragment and the
    // situation in another, and the conditional answer collapsed back into a scalar.
    expect(splitClauses('I prefer working alone when solving complex problems'))
      .toEqual(['I prefer working alone when solving complex problems']);
  });
});

describe('query terms', () => {
  it('puts named things first and drops filler', () => {
    const terms = extractQueryTerms('I really want to work on machine learning', [{ label: 'Artificial intelligence' }], [{ label: 'python' }]);
    expect(terms[0]).toBe('python');
    expect(terms).toContain('Artificial intelligence');
    expect(terms).not.toContain('really');
    expect(terms).not.toContain('work');
  });

  it('is capped, because a six-way ILIKE is already a full scan', () => {
    const terms = extractQueryTerms('quantum photonics lithography metrology nanofabrication spectroscopy crystallography microscopy');
    expect(terms.length).toBeLessThanOrEqual(6);
  });
});

describe('the summary never claims more than was read', () => {
  it('says nothing when nothing was read', () => {
    expect(summarise({ dimensions: {}, contextDependencies: [], interests: [], avoid: [], skills: [], stage: 'unknown' })).toEqual([]);
  });

  it('does not state a dimension it is not confident about', () => {
    const lines = summarise({
      dimensions: { autonomy: { value: 0.9, confidence: 0.05 } },
      contextDependencies: [], interests: [], avoid: [], skills: [], stage: 'unknown',
    });
    expect(lines).toEqual([]);
  });
});
