export const FORM_FIELD_TYPES = [
  'text',
  'email',
  'phone',
  'url',
  'number',
  'currency',
  'percentage',
  'duration',
  'rating',
  'linear_scale',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'date',
  'time',
  'datetime',
  'yes_no',
  'acknowledgment',
  'selfie',
  'location',
  'signature',
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];
export type FormConditionOperator = 'equals' | 'not_equals' | 'answered' | 'not_answered';
export type FormCondition = {
  fieldKey: string;
  operator: FormConditionOperator;
  value: string;
};

export type FormField = {
  key: string;
  type: FormFieldType;
  label: string;
  required: boolean;
  options: string[];
  placeholder: string;
  description: string;
  example: string;
  min: number | null;
  max: number | null;
  minLength: number | null;
  maxLength: number | null;
  section: string;
  condition: FormCondition | null;
};

const CHOICE_TYPES = new Set<FormFieldType>(['select', 'radio', 'checkbox']);
const OPTIONAL_CAPTURE_TYPES = new Set<FormFieldType>(['selfie', 'location', 'signature']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedNumber(value: unknown, label: string, min: number, max: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}.`);
  }
  return parsed;
}

function fieldKey(raw: unknown, label: string, index: number): string {
  const stored = typeof raw === 'string' ? raw.trim() : '';
  if (stored) {
    if (stored.length > 128) throw new Error(`Question ${index + 1} has an invalid saved ID.`);
    return stored;
  }
  const base = label.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base || `field_${index + 1}`;
}

/** Validate and normalize stored JSONB form fields without mutating existing submissions. */
export function normalizeFormFields(input: unknown): FormField[] {
  if (!Array.isArray(input)) throw new Error('Questions must be a list.');
  if (input.length > 120) throw new Error('A form can have at most 120 questions.');

  const fields = input.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Question ${index + 1} is invalid.`);
    const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 200) : '';
    if (!label) throw new Error(`Question ${index + 1} needs a label.`);
    const type = typeof raw.type === 'string' && FORM_FIELD_TYPES.includes(raw.type as FormFieldType)
      ? raw.type as FormFieldType
      : null;
    if (!type) throw new Error(`Question "${label}" has an unsupported type.`);

    // Existing submissions are keyed by the stored question key. Never rename a key while
    // normalizing an old form; the editor creates unique keys for new questions.
    const key = fieldKey(raw.key, label, index);

    const options = Array.isArray(raw.options)
      ? raw.options
          .filter((option): option is string => typeof option === 'string')
          .map((option) => option.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 100)
      : [];
    if (CHOICE_TYPES.has(type) && new Set(options).size !== options.length) {
      throw new Error(`Question "${label}" has duplicate answer options.`);
    }

    const min = boundedNumber(raw.min, 'Minimum', -1_000_000_000, 1_000_000_000) ??
      (type === 'rating' ? 1 : type === 'linear_scale' ? 0 : null);
    const max = boundedNumber(raw.max, 'Maximum', -1_000_000_000, 1_000_000_000) ??
      (type === 'rating' ? 5 : type === 'linear_scale' ? 10 : null);
    if (min !== null && max !== null && min > max) {
      throw new Error(`Question "${label}" has a minimum greater than its maximum.`);
    }
    if (['rating', 'linear_scale'].includes(type) &&
        (min === null || max === null || !Number.isInteger(min) || !Number.isInteger(max) || max - min > 100)) {
      throw new Error(`Question "${label}" needs whole-number scale bounds no more than 100 steps apart.`);
    }
    const minLength = boundedNumber(raw.minLength, 'Minimum length', 0, 100_000);
    const maxLength = boundedNumber(raw.maxLength, 'Maximum length', 1, 20_000);
    if (minLength !== null && maxLength !== null && minLength > maxLength) {
      throw new Error(`Question "${label}" has a minimum length greater than its maximum.`);
    }

    return {
      key,
      type,
      label,
      required: OPTIONAL_CAPTURE_TYPES.has(type) ? false : raw.required === true,
      options,
      placeholder: typeof raw.placeholder === 'string' ? raw.placeholder.trim().slice(0, 200) : '',
      description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 1000) : '',
      example: typeof raw.example === 'string' ? raw.example.trim().slice(0, 300) : '',
      min,
      max,
      minLength,
      maxLength,
      section: typeof raw.section === 'string' ? raw.section.trim().slice(0, 120) || 'General' : 'General',
      condition: normalizeCondition(raw.condition, label),
    };
  });

  const keyCounts = new Map<string, number>();
  for (const field of fields) keyCounts.set(field.key, (keyCounts.get(field.key) || 0) + 1);
  for (const [index, field] of fields.entries()) {
    if (!field.condition) continue;
    if (keyCounts.get(field.condition.fieldKey) !== 1) {
      throw new Error(`Question "${field.label}" refers to a question ID that is missing or ambiguous.`);
    }
    const sourceIndex = fields.findIndex((candidate) => candidate.key === field.condition?.fieldKey);
    if (sourceIndex < 0 || sourceIndex >= index) {
      throw new Error(`Question "${field.label}" must depend on an earlier question.`);
    }
    const source = fields[sourceIndex];
    if (['equals', 'not_equals'].includes(field.condition.operator) && !field.condition.value) {
      throw new Error(`Question "${field.label}" needs an answer for its visibility rule.`);
    }
    if (CHOICE_TYPES.has(source.type) && ['equals', 'not_equals'].includes(field.condition.operator) &&
        !source.options.includes(field.condition.value)) {
      throw new Error(`Question "${field.label}" uses an answer not offered by "${source.label}".`);
    }
  }
  return fields;
}

function normalizeCondition(raw: unknown, label: string): FormCondition | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!isRecord(raw)) throw new Error(`Question "${label}" has an invalid visibility rule.`);
  const fieldKey = typeof raw.fieldKey === 'string' ? raw.fieldKey.trim() : '';
  const operators: FormConditionOperator[] = ['equals', 'not_equals', 'answered', 'not_answered'];
  const operator = typeof raw.operator === 'string' && operators.includes(raw.operator as FormConditionOperator)
    ? raw.operator as FormConditionOperator
    : null;
  if (!fieldKey || fieldKey.length > 128 || !operator) {
    throw new Error(`Question "${label}" has an invalid visibility rule.`);
  }
  return {
    fieldKey,
    operator,
    value: typeof raw.value === 'string' ? raw.value.trim().slice(0, 200) : '',
  };
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function answerMatches(value: unknown, condition: FormCondition): boolean {
  const answered = !isEmpty(value);
  if (condition.operator === 'answered') return answered;
  if (condition.operator === 'not_answered') return !answered;
  const matches = Array.isArray(value)
    ? value.includes(condition.value)
    : String(value ?? '') === condition.value;
  return condition.operator === 'equals' ? matches : !matches;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isValidDateTime(value: string, type: FormFieldType): boolean {
  if (type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  if (type === 'time') return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
  const datePart = value.slice(0, 10);
  const date = new Date(`${datePart}T00:00:00.000Z`);
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === datePart &&
    hour <= 23 && minute <= 59;
}

/** Validate public answers and remove keys not defined by the published form. */
export function validateFormAnswers(
  fields: FormField[],
  input: unknown,
): { data: Record<string, unknown>; error: string | null } {
  if (!isRecord(input)) return { data: {}, error: 'Please submit valid form responses.' };
  const clean = Object.create(null) as Record<string, unknown>;

  for (const field of fields) {
    if (field.condition && !answerMatches(clean[field.condition.fieldKey], field.condition)) continue;
    const value = input[field.key];
    if (field.required && isEmpty(value)) return { data: {}, error: `Please fill: ${field.label}` };
    if (isEmpty(value)) continue;

    if (field.type === 'acknowledgment') {
      if (typeof value !== 'boolean') return { data: {}, error: `Please confirm: ${field.label}` };
      if (field.required && value !== true) return { data: {}, error: `Please acknowledge: ${field.label}` };
      clean[field.key] = value;
      continue;
    }

    if (field.type === 'selfie') {
      if (typeof value !== 'string' || value.length > 50_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value)) {
        return { data: {}, error: `The selfie for "${field.label}" is invalid. Please retake it or leave it blank.` };
      }
      clean[field.key] = value;
      continue;
    }

    if (field.type === 'signature') {
      if (typeof value !== 'string' || value.length > 40_000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) {
        return { data: {}, error: `The signature for "${field.label}" is invalid. Please sign again or leave it blank.` };
      }
      clean[field.key] = value;
      continue;
    }

    if (field.type === 'location') {
      if (!isRecord(value)) return { data: {}, error: `The location for "${field.label}" is invalid.` };
      const latitude = Number(value.latitude);
      const longitude = Number(value.longitude);
      const accuracy = value.accuracy === undefined ? null : Number(value.accuracy);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
          !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
          (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0))) {
        return { data: {}, error: `The location for "${field.label}" is invalid.` };
      }
      clean[field.key] = {
        latitude,
        longitude,
        ...(accuracy !== null ? { accuracy } : {}),
        ...(typeof value.capturedAt === 'string' ? { capturedAt: value.capturedAt.slice(0, 40) } : {}),
      };
      continue;
    }

    if (field.type === 'checkbox') {
      if (!Array.isArray(value) || value.some((answer) => typeof answer !== 'string' || (field.options.length > 0 && !field.options.includes(answer)))) {
        return { data: {}, error: `Choose valid options for "${field.label}".` };
      }
      clean[field.key] = value.slice(0, 100);
      continue;
    }

    if (field.type === 'yes_no') {
      if (value !== 'yes' && value !== 'no') return { data: {}, error: `Choose yes or no for "${field.label}".` };
      clean[field.key] = value;
      continue;
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      return { data: {}, error: `The answer for "${field.label}" is invalid.` };
    }
    const answer = String(value).trim();

    if (field.type === 'email' && !isEmail(answer)) return { data: {}, error: `Enter a valid email address for "${field.label}".` };
    if (field.type === 'url' && !isHttpUrl(answer)) return { data: {}, error: `Enter a valid web link for "${field.label}".` };
    if (['select', 'radio'].includes(field.type) && field.options.length > 0 && !field.options.includes(answer)) {
      return { data: {}, error: `Choose a valid option for "${field.label}".` };
    }
    if (['date', 'time', 'datetime'].includes(field.type) && !isValidDateTime(answer, field.type)) {
      return { data: {}, error: `Enter a valid ${field.type} for "${field.label}".` };
    }
    if (['number', 'currency', 'percentage', 'duration', 'rating', 'linear_scale'].includes(field.type)) {
      const number = Number(answer);
      if (!Number.isFinite(number) ||
          (field.min !== null && number < field.min) ||
          (field.max !== null && number > field.max)) {
        return { data: {}, error: `Enter a valid ${field.type === 'number' ? 'number' : field.type} for "${field.label}".` };
      }
      if (['rating', 'linear_scale'].includes(field.type) && !Number.isInteger(number)) {
        return { data: {}, error: `Choose a whole-number ${field.type === 'rating' ? 'rating' : 'scale value'} for "${field.label}".` };
      }
      clean[field.key] = number;
      continue;
    }
    if (field.minLength !== null && answer.length < field.minLength) {
      return { data: {}, error: `"${field.label}" must be at least ${field.minLength} characters.` };
    }
    if (field.maxLength !== null && answer.length > field.maxLength) {
      return { data: {}, error: `"${field.label}" must be no more than ${field.maxLength} characters.` };
    }
    if (answer.length > 20_000) {
      return { data: {}, error: `"${field.label}" must be no more than 20000 characters.` };
    }
    clean[field.key] = answer;
  }

  return { data: clean, error: null };
}

/** Return a user-facing issue when a form definition is not ready for public submissions. */
export function validateFormForPublishing(fields: FormField[]): string | null {
  if (fields.length === 0) return 'Add at least one question before publishing this form.';
  const emptyChoice = fields.find((field) => CHOICE_TYPES.has(field.type) && field.options.length === 0);
  if (emptyChoice) return `Add at least one answer option to "${emptyChoice.label}" before publishing.`;
  return null;
}
