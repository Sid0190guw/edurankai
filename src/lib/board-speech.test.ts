// src/lib/board-speech.test.ts — run: npx tsx src/lib/board-speech.test.ts
// Speech -> board trigger (Prompt A2a), PURE. A spoken phrase becomes a suggestion constrained to
// the real registry + schema; the deterministic fallback works with no AI key; the LLM path is
// sanitised so a model can never fire an unknown template or push an out-of-range param.
import { detectTemplate, extractParams, clampToSpec, buildSuggestion, parseLlmJson, validateLlmSuggestion, llmSystemPrompt } from './board-speech';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== concept detection (which template does the phrase name?) ==');
ok('"launch a projectile at 30 degrees" -> projectile', detectTemplate('launch a projectile at 30 degrees')?.templateId === 'projectile');
ok('"draw a sine wave" -> sine', detectTemplate('lets draw a sine wave')?.templateId === 'sine');
ok('"lets do a bubble sort" -> sortbars', detectTemplate('lets do a bubble sort now')?.templateId === 'sortbars');
ok('a phrase with no concept -> null', detectTemplate('good morning everyone') === null);

console.log('\n== parameter extraction from speech ==');
ok('angle spoken -> angle param', extractParams('projectile', 'throw it at an angle of 30 degrees').angle === 30);
ok('velocity spoken -> v0 param', extractParams('projectile', 'with a velocity of 25').v0 === 25);
ok('amplitude spoken -> amplitude param', extractParams('sine', 'amplitude of 4 please').amplitude === 4);
const list = extractParams('sortbars', 'sort the numbers 5 2 8 1').values;
ok('a spoken number list -> values', Array.isArray(list) && list.length === 4 && list[0] === 5, list);

console.log('\n== clamp to the SAME schema as the browser engine ==');
ok('angle 999 clamps to 90', clampToSpec('projectile', { angle: 999 }).angle === 90);
ok('missing params get defaults', clampToSpec('sine', {}).amplitude === 3 && clampToSpec('sine', {}).frequency === 1);
ok('unknown keys are dropped', !('bogus' in clampToSpec('projectile', { bogus: 5, angle: 20 })));

console.log('\n== deterministic fallback suggestion (works with NO AI key) ==');
const s = buildSuggestion('launch a projectile at 30 degrees with velocity 40');
ok('produces a constrained suggestion', s!.templateId === 'projectile' && s!.params.angle === 30 && s!.params.v0 === 40 && s!.source === 'rule');
ok('confidence is in [0,1]', s!.confidence >= 0 && s!.confidence <= 1, s!.confidence);
ok('a no-concept phrase yields no suggestion', buildSuggestion('any questions so far') === null);

console.log('\n== LLM path is sanitised against the registry ==');
ok('parses JSON out of a fenced/prose completion', parseLlmJson('sure! ```json\n{"templateId":"sine","params":{"amplitude":2}}\n``` done').templateId === 'sine');
const good = validateLlmSuggestion({ templateId: 'sine', params: { amplitude: 99 }, confidence: 0.9 }, 'x');
ok('valid template accepted + params clamped', good!.templateId === 'sine' && good!.params.amplitude === 10 && good!.source === 'llm');
ok('unknown template rejected (model cannot invent one)', validateLlmSuggestion({ templateId: 'blackhole', params: {} }, 'x') === null);
ok('system prompt lists the real registry ids', /projectile/.test(llmSystemPrompt()) && /sortbars/.test(llmSystemPrompt()) && /STRICT JSON/.test(llmSystemPrompt()));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
