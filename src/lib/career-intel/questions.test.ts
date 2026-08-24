import { describe, it, expect } from 'vitest';
import { QUESTIONS, nextQuestion, dimsForOptions, domainsForOptions, stageForOption, shouldOfferResume, ENOUGH, openingPathways } from './questions';
import { emptyProfile, profileReadiness, type CareerProfile } from './dimensions';
import { recordAnswer, skipQuestion, addTag } from './profile';

function answer(p: CareerProfile, questionId: string, selected: string[], text = ''): CareerProfile {
  return recordAnswer(p, { questionId, selected, text, selectedDims: dimsForOptions(questionId, selected) }).profile;
}

describe('every question can be answered in a way we did not think of', () => {
  it('offers a free-text escape on every single question', () => {
    for (const q of QUESTIONS) {
      expect(q.options.some((o) => o.freeText === true), q.id).toBe(true);
    }
  });

  it('gives every question a free-text placeholder as well as options', () => {
    for (const q of QUESTIONS) expect(q.placeholder.length, q.id).toBeGreaterThan(5);
  });

  it('allows more than one answer everywhere it could be true', () => {
    // The one single-choice question is where you are in your career, which is genuinely one thing.
    const single = QUESTIONS.filter((q) => !q.multi).map((q) => q.id);
    expect(single).toEqual(['experience.stage']);
  });

  it('can always explain why it is asking', () => {
    for (const q of QUESTIONS) expect(q.whyAsked.length, q.id).toBeGreaterThan(15);
  });
});

describe('it stops asking', () => {
  it('asks something of somebody who has said nothing', () => {
    const q = nextQuestion(emptyProfile());
    expect(q).not.toBeNull();
    expect(q!.optional).toBe(false);
  });

  it('runs out of core questions once enough is known', () => {
    let p = emptyProfile();
    p = answer(p, 'direction.kind', ['research', 'build']);
    p = answer(p, 'direction.problem', ['discover']);
    p = answer(p, 'direction.abstraction', ['abstract']);
    p = answer(p, 'experience.stage', ['experienced']);
    p = { ...p, stage: 'experienced', stageConfidence: 0.95 };
    p = answer(p, 'experience.what', ['code', 'maths'], 'python, pytorch and numpy');
    p = answer(p, 'workstyle.environment', ['quiet']);
    p = addTag(p, 'interests', 'ARTIFICIAL_INTELLIGENCE', 'Artificial intelligence');
    p = addTag(p, 'interests', 'RESEARCH', 'Research and discovery');
    p = addTag(p, 'interests', 'MATHEMATICS', 'Mathematics');

    expect(profileReadiness(p)).toBeGreaterThanOrEqual(ENOUGH);
    const q = nextQuestion(p);
    // Whatever is left is optional and labelled as such.
    expect(q === null || q.optional).toBe(true);
  });

  it('never asks a question that was skipped', () => {
    let p = skipQuestion(emptyProfile(), 'direction.kind');
    for (let i = 0; i < 12; i++) {
      const q = nextQuestion(p);
      if (!q) break;
      expect(q.question.id).not.toBe('direction.kind');
      p = skipQuestion(p, q.question.id);
    }
  });

  it('terminates rather than looping for ever', () => {
    let p = emptyProfile();
    let n = 0;
    while (n < 50) {
      const q = nextQuestion(p);
      if (!q) break;
      p = skipQuestion(p, q.question.id);
      n++;
    }
    expect(n).toBeLessThanOrEqual(QUESTIONS.length);
    expect(nextQuestion(p)).toBeNull();
  });
});

describe('a follow-up is only asked about something the person said', () => {
  it('does not ask what flexibility means to somebody who never used the word', () => {
    let p = emptyProfile();
    for (let i = 0; i < 12; i++) {
      const q = nextQuestion(p);
      if (!q) break;
      expect(q.question.id).not.toBe('workstyle.autonomy');
      p = skipQuestion(p, q.question.id);
    }
  });

  it('does ask once they have', () => {
    const p = recordAnswer(emptyProfile(), { text: 'I want flexibility in my work.' }).profile;
    const ids: string[] = [];
    let cur = p;
    for (let i = 0; i < 12; i++) {
      const q = nextQuestion(cur);
      if (!q) break;
      ids.push(q.question.id);
      cur = skipQuestion(cur, q.question.id);
    }
    expect(ids).toContain('workstyle.autonomy');
  });
});

describe('the optional layers are optional', () => {
  it('marks rhythm and behavioural questions optional', () => {
    for (const q of QUESTIONS.filter((x) => x.layer === 'rhythm' || x.layer === 'behavioural')) {
      expect(q.optional, q.id).toBe(true);
    }
  });

  it('says in the question itself that it does not affect matching', () => {
    for (const q of QUESTIONS.filter((x) => x.optional)) {
      expect(q.whyAsked.toLowerCase(), q.id).toMatch(/not (an input|used)|never affects/);
    }
  });

  it('never offers an optional question before a useful one', () => {
    const q = nextQuestion(emptyProfile());
    expect(q!.question.optional).toBe(false);
  });
});

describe('a CV is offered, never demanded', () => {
  it('is not offered to somebody who has just arrived', () => {
    expect(shouldOfferResume(emptyProfile())).toBe(false);
  });

  it('is not offered once the profile is already sharp', () => {
    let p = emptyProfile();
    p = addTag(p, 'interests', 'ARTIFICIAL_INTELLIGENCE', 'Artificial intelligence');
    p = addTag(p, 'interests', 'RESEARCH', 'Research');
    p = addTag(p, 'interests', 'MATHEMATICS', 'Mathematics');
    p = addTag(p, 'skills', 'python', 'python');
    p = addTag(p, 'skills', 'pytorch', 'pytorch');
    p = addTag(p, 'skills', 'numpy', 'numpy');
    p = addTag(p, 'skills', 'cuda', 'cuda');
    p = answer(p, 'direction.problem', ['discover']);
    p = answer(p, 'direction.abstraction', ['abstract']);
    p = answer(p, 'workstyle.environment', ['quiet']);
    p = { ...p, stage: 'experienced', stageConfidence: 0.9 };
    expect(profileReadiness(p)).toBeGreaterThanOrEqual(ENOUGH);
    expect(shouldOfferResume(p)).toBe(false);
  });
});

describe('option payloads', () => {
  it('turns picked options into dimension contributions', () => {
    const dims = dimsForOptions('workstyle.environment', ['quiet', 'clear']);
    expect(dims.length).toBe(2);
    expect(dims[0].deep_focus).toBeGreaterThan(0.5);
  });

  it('ignores an option id it does not recognise instead of throwing', () => {
    expect(dimsForOptions('workstyle.environment', ['nonsense'])).toEqual([]);
    expect(dimsForOptions('no.such.question', ['quiet'])).toEqual([]);
    expect(domainsForOptions('no.such.question', ['research'])).toEqual([]);
  });

  it('reads the domains a picked option names', () => {
    expect(domainsForOptions('direction.kind', ['research'])).toEqual(['RESEARCH']);
    expect(domainsForOptions('direction.kind', ['people'])).toEqual(['HELPING', 'EDUCATION']);
  });

  it('reads a stage only from the stage question', () => {
    expect(stageForOption('experience.stage', ['student'])).toBe('student');
    expect(stageForOption('experience.stage', ['nonsense'])).toBeNull();
    expect(stageForOption('direction.kind', ['student'])).toBeNull();
  });
});

describe('the opening pathways are a shortlist of real domains', () => {
  it('resolves every one of them', () => {
    const p = openingPathways();
    expect(p.length).toBe(7);
    for (const x of p) expect(x.label.length).toBeGreaterThan(2);
  });
});
