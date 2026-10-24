import { describe, expect, it } from 'vitest';
import { normalizeFormFields, validateFormAnswers, validateFormForPublishing } from '@/lib/forms/form-schema';

describe('normalizeFormFields', () => {
  it('normalizes configured questions and preserves stable question keys', () => {
    const fields = normalizeFormFields([
      { type: 'text', label: 'Full Name', required: true },
      { key: 'preferredName', type: 'text', label: 'Preferred Name', required: false },
      { type: 'selfie', label: 'Optional photo', required: true },
    ]);

    expect(fields.map((field) => field.key)).toEqual(['full_name', 'preferredName', 'optional_photo']);
    expect(fields[0].required).toBe(true);
    expect(fields[2].required).toBe(false);
  });

  it('does not rewrite duplicate legacy keys while reading an existing form', () => {
    const fields = normalizeFormFields([
      { key: 'question_1', type: 'text', label: 'First question' },
      { key: 'question_1', type: 'text', label: 'Second question' },
    ]);

    expect(fields.map((field) => field.key)).toEqual(['question_1', 'question_1']);
  });

  it('safely serializes answers when a saved question key is a prototype property name', () => {
    const fields = normalizeFormFields([
      { key: '__proto__', type: 'text', label: 'Legacy question' },
    ]);
    const answers = JSON.parse('{"__proto__":"answer"}');
    const result = validateFormAnswers(fields, answers);

    expect(result.error).toBeNull();
    expect(Object.hasOwn(result.data, '__proto__')).toBe(true);
    expect(result.data['__proto__']).toBe('answer');
    expect(JSON.stringify(result.data)).toBe('{"__proto__":"answer"}');
  });

  it('rejects invalid question definitions rather than silently dropping them', () => {
    expect(() => normalizeFormFields([{ type: 'made_up', label: 'Question' }])).toThrow('unsupported type');
    expect(() => normalizeFormFields([{ type: 'number', label: 'Age', min: 10, max: 2 }])).toThrow('minimum greater');
    expect(() => normalizeFormFields([{ type: 'radio', label: 'Choice', options: ['A', 'A'] }])).toThrow('duplicate');
  });

  it('validates conditional rules against unique earlier questions', () => {
    expect(() => normalizeFormFields([
      { key: 'detail', type: 'text', label: 'Details', condition: { fieldKey: 'later', operator: 'equals', value: 'yes' } },
      { key: 'later', type: 'yes_no', label: 'Later question' },
    ])).toThrow('earlier question');
    expect(() => normalizeFormFields([
      { key: 'choice', type: 'radio', label: 'Choice', options: ['A', 'B'] },
      { key: 'detail', type: 'text', label: 'Details', condition: { fieldKey: 'choice', operator: 'equals', value: 'C' } },
    ])).toThrow('not offered');
  });

  it('normalizes section labels and supplies rating-scale defaults', () => {
    const fields = normalizeFormFields([
      { key: 'rating', type: 'rating', label: 'Satisfaction', section: 'Feedback' },
      { key: 'scale', type: 'linear_scale', label: 'Confidence' },
    ]);

    expect(fields[0].section).toBe('Feedback');
    expect(fields[0].min).toBe(1);
    expect(fields[0].max).toBe(5);
    expect(fields[1].section).toBe('General');
    expect(fields[1].min).toBe(0);
    expect(fields[1].max).toBe(10);
  });
});

describe('validateFormAnswers', () => {
  it('strips undeclared answers and validates email, url, and configured choices', () => {
    const fields = normalizeFormFields([
      { key: 'email', type: 'email', label: 'Email', required: true },
      { key: 'portfolio', type: 'url', label: 'Portfolio' },
      { key: 'mode', type: 'radio', label: 'Mode', options: ['Remote', 'On site'] },
    ]);
    const valid = validateFormAnswers(fields, {
      email: 'person@example.org',
      portfolio: 'https://example.org/work',
      mode: 'Remote',
      injected: 'discard',
    });

    expect(valid.error).toBeNull();
    expect(valid.data).toEqual({
      email: 'person@example.org',
      portfolio: 'https://example.org/work',
      mode: 'Remote',
    });
    expect(validateFormAnswers(fields, { email: 'not-an-email' }).error).toContain('valid email');
    expect(validateFormAnswers(fields, { email: 'person@example.org', mode: 'Other' }).error).toContain('valid option');
  });

  it('enforces required acknowledgment and optional capture data', () => {
    const fields = normalizeFormFields([
      { key: 'consent', type: 'acknowledgment', label: 'I agree', required: true },
      { key: 'location', type: 'location', label: 'Optional location' },
    ]);

    expect(validateFormAnswers(fields, { consent: false }).error).toContain('acknowledge');
    expect(validateFormAnswers(fields, { consent: true, location: { latitude: 91, longitude: 0 } }).error).toContain('location');
    const valid = validateFormAnswers(fields, { consent: true, location: { latitude: 12.5, longitude: 77.5, accuracy: 20 } });
    expect(valid.error).toBeNull();
    expect(valid.data.location).toEqual({ latitude: 12.5, longitude: 77.5, accuracy: 20 });
  });

  it('validates numeric boundaries, dates, and length limits', () => {
    const fields = normalizeFormFields([
      { key: 'age', type: 'number', label: 'Age', min: 18, max: 65 },
      { key: 'start', type: 'date', label: 'Start date' },
      { key: 'bio', type: 'textarea', label: 'Short bio', maxLength: 5 },
    ]);

    expect(validateFormAnswers(fields, { age: '17', start: '2026-10-24', bio: 'ok' }).error).toContain('valid number');
    expect(validateFormAnswers(fields, { age: '20', start: 'not-date', bio: 'ok' }).error).toContain('valid date');
    expect(validateFormAnswers(fields, { age: '20', start: '2026-02-30', bio: 'ok' }).error).toContain('valid date');
    expect(validateFormAnswers(fields, { age: '20', start: '2026-10-24', bio: 'too long' }).error).toContain('no more than 5');
    expect(validateFormAnswers(fields, { age: '20', start: '2026-10-24', bio: 'short' }).error).toBeNull();
  });

  it('rejects over-limit text instead of silently truncating it', () => {
    const fields = normalizeFormFields([{ key: 'bio', type: 'textarea', label: 'Bio' }]);
    expect(validateFormAnswers(fields, { bio: 'x'.repeat(20_001) }).error).toContain('no more than 20000');
  });

  it('validates required fields only when their condition is met', () => {
    const fields = normalizeFormFields([
      { key: 'contact', type: 'yes_no', label: 'Need follow-up?', required: true },
      {
        key: 'email',
        type: 'email',
        label: 'Email for follow-up',
        required: true,
        condition: { fieldKey: 'contact', operator: 'equals', value: 'yes' },
      },
    ]);

    expect(validateFormAnswers(fields, { contact: 'no', email: 'stale@example.org' })).toEqual({
      error: null,
      data: { contact: 'no' },
    });
    expect(validateFormAnswers(fields, { contact: 'yes' }).error).toContain('Email for follow-up');
    expect(validateFormAnswers(fields, { contact: 'yes', email: 'person@example.org' }).error).toBeNull();
  });

  it('validates rating and linear scale bounds on the server', () => {
    const fields = normalizeFormFields([
      { key: 'rating', type: 'rating', label: 'Satisfaction' },
      { key: 'scale', type: 'linear_scale', label: 'Confidence' },
    ]);
    expect(validateFormAnswers(fields, { rating: '6', scale: '5' }).error).toContain('rating');
    expect(validateFormAnswers(fields, { rating: '4.5', scale: '5' }).error).toContain('whole-number rating');
    expect(validateFormAnswers(fields, { rating: '4', scale: '5' }).error).toBeNull();
  });
});

describe('validateFormForPublishing', () => {
  it('requires a question and configured options before publishing', () => {
    expect(validateFormForPublishing([])).toContain('at least one question');
    expect(validateFormForPublishing(normalizeFormFields([
      { key: 'channel', type: 'select', label: 'Channel', options: [] },
    ]))).toContain('at least one answer option');
    expect(validateFormForPublishing(normalizeFormFields([
      { key: 'channel', type: 'select', label: 'Channel', options: ['Email'] },
    ]))).toBeNull();
  });
});
