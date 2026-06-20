// Central feature flags — hide in-development / non-functional surfaces from
// production so nothing reads as a dead end. Override any flag at runtime with
// an env var: FEATURE_<NAME>=on | off  (e.g. FEATURE_AI_TUTOR=on).
function flag(name: string, def: boolean): boolean {
  const raw = (typeof process !== 'undefined' && process.env && process.env['FEATURE_' + name]) || '';
  const v = raw.toLowerCase();
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
  return def;
}

const hasLlm = !!(typeof process !== 'undefined' && process.env && process.env.ANTHROPIC_API_KEY);

export const FEATURES = {
  // Conversational AI tutor needs the LLM key — off until it's set.
  aiTutor: flag('AI_TUTOR', hasLlm),
  // Other learner surfaces — flip on when verified functional.
  dailyChallenge: flag('DAILY_CHALLENGE', true),
  storyReading: flag('STORY_READING', false),
};

export function isEnabled(name: keyof typeof FEATURES): boolean {
  return !!FEATURES[name];
}
