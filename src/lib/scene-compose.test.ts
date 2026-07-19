// src/lib/scene-compose.test.ts — run: npx tsx src/lib/scene-compose.test.ts
// LLM scene composition (Prompt A3b), PURE. The system prompt constrains the model to the real
// schema; an LLM's JSON is validated + REPAIRED (a hallucinated/oversized spec never crashes);
// with no AI key a keyword fallback picks the closest authored example; composeFrom() prefers a
// usable LLM spec and otherwise falls back — always yielding a valid spec or null.
import { composeSystemPrompt, parseSceneJson, fallbackCompose, composeFrom } from './scene-compose';
import { OBJECT_TYPES, MAX_OBJECTS } from './scene-spec';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== system prompt constrains to the real schema + registries ==');
const sp = composeSystemPrompt();
ok('names the real object types + STRICT JSON', /sphere/.test(sp) && /projectile/.test(sp) && /STRICT JSON/.test(sp));
ok('names the motion types', /orbit/.test(sp) && /oscillate/.test(sp));

console.log('\n== an LLM completion is parsed + validated + repaired ==');
const good = parseSceneJson('here you go: ```json\n{"title":"Atom","objects":[{"id":"n","type":"sphere","size":1},{"id":"e","type":"quark","motion":{"type":"warp"}}]}\n``` enjoy');
ok('extracts JSON from prose/fences', !!good && good!.spec.title === 'Atom');
ok('unknown type/motion repaired (quark->box, warp->none)', good!.spec.objects[1].type === 'box' && good!.spec.objects[1].motion.type === 'none');
ok('every composed object is a real type', good!.spec.objects.every((o) => (OBJECT_TYPES as readonly string[]).includes(o.type)));
ok('non-JSON completion -> null', parseSceneJson('I could not do that') === null);

console.log('\n== an oversized/garbage spec is capped, never crashes ==');
const huge = parseSceneJson(JSON.stringify({ objects: Array.from({ length: MAX_OBJECTS + 80 }, () => ({ type: 'sphere' })) }));
ok('objects capped at MAX_OBJECTS', !!huge && huge!.spec.objects.length === MAX_OBJECTS && huge!.issues.some((i) => /cap/.test(i)));

console.log('\n== deterministic fallback (no AI key) maps text -> closest example ==');
ok('"show the solar system" -> solar-system', fallbackCompose('please show the solar system with planets')!.matched === 'solar-system');
ok('"a swinging pendulum" -> pendulum', fallbackCompose('draw a swinging pendulum')!.matched === 'pendulum');
ok('unrelated text -> null', fallbackCompose('hello everyone welcome') === null);

console.log('\n== composeFrom prefers a usable LLM spec, else falls back ==');
ok('usable LLM spec wins (source=llm)', composeFrom('{"objects":[{"type":"sphere","id":"a"}]}', 'anything')!.source === 'llm');
ok('empty/invalid LLM -> example fallback (source=example)', composeFrom('nonsense', 'the solar system')!.source === 'example');
ok('nothing usable -> null', composeFrom('nonsense', 'good morning') === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
