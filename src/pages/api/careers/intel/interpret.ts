// POST /api/careers/intel/interpret — READ WHAT SOMEBODY SAID, SHOW IT BACK, ASK THE NEXT THING.
//
// =================================================================================================
// THE REQUEST CARRIES THE PROFILE. THE SERVER KEEPS NOTHING.
// =================================================================================================
//
// An anonymous visitor's personalisation lives in their browser and is posted here with each turn.
// That is the design, not an optimisation — see the header of src/lib/career-intel/store.ts. It
// means this endpoint writes nothing, holds nothing, and can be called by anybody without creating
// a row about them anywhere.
//
// EVERY REQUEST IS BOUNDED. parseProfile() caps every list in the incoming document and rebuilds it
// field by field with types checked; the free text is capped; the interpreter is a synchronous
// lexicon with no network call in it. So the worst a hostile caller gets out of this endpoint is
// their own CPU time on ours, with no database write and one bounded read.
//
// WHAT COMES BACK IS A CONFIRMATION, NOT A CONCLUSION. `summary` is the "here is what I understood"
// list, and the client shows it with Yes / Adjust / Let me explain before anything is treated as
// settled. Section 7: never silently build a picture of somebody without offering the correction.

import type { APIRoute } from 'astro';
import { json } from '@/lib/career-intel/wire';
import { parseProfile, recordAnswer, skipQuestion, confirmDimension, confirmTag, addTag, removeResponse } from '@/lib/career-intel/profile';
import { dimsForOptions, domainsForOptions, stageForOption, nextQuestion, shouldOfferResume, QUESTION_BY_ID } from '@/lib/career-intel/questions';
import { DOMAIN_BY_KEY } from '@/lib/career-intel/ontology';
import { profileReadiness, uncertainties, heldDimensions, DIMENSION_BY_KEY, explorationDimensions, type CareerProfile } from '@/lib/career-intel/dimensions';
import { buildReflection, reflectionFor, REFLECTION_DISCLAIMER } from '@/lib/career-intel/reflection';

export const prerender = false;

const MAX_TEXT = 2000;

/** What every response looks like, so the client has one shape to render. */
function state(profile: CareerProfile, extra: Record<string, unknown> = {}) {
  const nq = nextQuestion(profile);
  const held = heldDimensions(profile);
  return json({
    ok: true,
    profile,
    readiness: profileReadiness(profile),
    uncertainties: uncertainties(profile),
    // The "what we currently understand" panel, built from what is actually held.
    understanding: {
      interests: (profile.interests || []).filter((t) => t.confirmation !== 'rejected').map((t) => ({ key: t.key, label: t.label, confirmation: t.confirmation })),
      skills: (profile.skills || []).filter((t) => t.confirmation !== 'rejected').map((t) => ({ key: t.key, label: t.label, confirmation: t.confirmation })),
      avoid: (profile.avoid || []).filter((t) => t.confirmation !== 'rejected').map((t) => ({ key: t.key, label: t.label, confirmation: t.confirmation })),
      stage: profile.stage,
      dimensions: held.map((k) => ({
        key: k,
        label: DIMENSION_BY_KEY[k]?.affirm || k,
        group: DIMENSION_BY_KEY[k]?.group || 'workstyle',
        value: profile.dimensions[k].value,
        confidence: profile.dimensions[k].confidence,
        confirmation: profile.dimensions[k].confirmation,
        // Said out loud on every dimension, so nobody has to guess which of their answers is
        // shaping results and which is only for their own picture.
        usedForMatching: (DIMENSION_BY_KEY[k]?.group === 'workstyle' || DIMENSION_BY_KEY[k]?.group === 'cognitive'),
      })),
      explorationOnly: Object.keys(explorationDimensions(profile)),
      contexts: (profile.contextDependencies || []).map((c) => ({ context: c.context, label: c.label, quote: c.quote })),
      reflection: reflectionFor(profile.reflection),
      reflectionDisclaimer: REFLECTION_DISCLAIMER,
      responses: (profile.rawResponses || []).map((r) => ({ id: r.id, at: r.at, questionId: r.questionId, text: r.text })),
    },
    next: nq ? {
      id: nq.question.id,
      prompt: nq.question.prompt,
      whyAsked: nq.question.whyAsked,
      options: nq.question.options,
      multi: nq.question.multi,
      placeholder: nq.question.placeholder,
      optional: nq.optional,
    } : null,
    offerResume: shouldOfferResume(profile),
    ...extra,
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Could not read that request.' }, 400);
  }

  const profile = parseProfile(body?.profile);
  const action = String(body?.action || 'answer');

  // ---------------------------------------------------------------- answering, in any of three ways
  if (action === 'answer') {
    const questionId = typeof body?.questionId === 'string' ? body.questionId.slice(0, 60) : null;
    const text = String(body?.text ?? '').slice(0, MAX_TEXT);
    const selected = Array.isArray(body?.selected) ? body.selected.slice(0, 12).map((s: any) => String(s).slice(0, 60)) : [];

    if (!text.trim() && selected.length === 0) {
      return json({ ok: false, error: 'Nothing to read — write something or pick an option.' }, 400);
    }
    if (questionId && !QUESTION_BY_ID[questionId]) {
      // An unknown question id is treated as free text rather than refused. A stale client is not a
      // reason to lose what somebody just typed.
      const r = recordAnswer(profile, { text, selected: [], questionId: null });
      return state(r.profile, { understood: r.interpretation.summary, confidence: r.interpretation.confidence, responseId: r.responseId });
    }

    const selectedDims = questionId ? dimsForOptions(questionId, selected) : [];
    const r = recordAnswer(profile, { text, selected, questionId, selectedDims });

    // Domains named by the picked options are added as interests directly. They were CHOSEN, not
    // read out of prose, so they enter confirmed rather than waiting to be confirmed.
    let next = r.profile;
    for (const key of questionId ? domainsForOptions(questionId, selected) : []) {
      const d = DOMAIN_BY_KEY[key];
      if (d) next = addTag(next, 'interests', d.key, d.label);
    }
    const stage = questionId ? stageForOption(questionId, selected) : null;
    if (stage) next = { ...next, stage: stage as CareerProfile['stage'], stageConfidence: 0.95 };

    return state(next, {
      understood: r.interpretation.summary,
      confidence: r.interpretation.confidence,
      // True when nothing could be read out of the words. The client says so plainly and offers a
      // plain search instead of pretending to have understood.
      couldNotRead: r.interpretation.empty && selected.length === 0,
      queryTerms: r.interpretation.queryTerms,
      responseId: r.responseId,
    });
  }

  // ------------------------------------------------------------------------------------- skipping
  if (action === 'skip') {
    const questionId = String(body?.questionId || '').slice(0, 60);
    return state(skipQuestion(profile, questionId));
  }

  // --------------------------------------------------------- confirming, adjusting and rejecting
  if (action === 'confirm') {
    const verdict = ['confirm', 'adjust', 'reject'].includes(String(body?.verdict)) ? body.verdict : 'confirm';
    const target = String(body?.target || '');
    const key = String(body?.key || '').slice(0, 80);
    if (target === 'dimension') {
      const value = typeof body?.value === 'number' ? body.value : undefined;
      return state(confirmDimension(profile, key, verdict, value));
    }
    if (target === 'interests' || target === 'skills' || target === 'avoid') {
      return state(confirmTag(profile, target, key, verdict));
    }
    return json({ ok: false, error: 'Unknown thing to confirm.' }, 400);
  }

  // ------------------------------------------------------------------------ adding something new
  if (action === 'add') {
    const list = ['interests', 'skills', 'avoid'].includes(String(body?.list)) ? body.list : 'interests';
    const label = String(body?.label || '').slice(0, 80);
    const key = String(body?.key || label).slice(0, 80);
    if (!label.trim()) return json({ ok: false, error: 'Nothing to add.' }, 400);
    return state(addTag(profile, list, key, label));
  }

  // -------------------------------------------------------------- removing something they said
  if (action === 'remove') {
    const id = String(body?.responseId || '').slice(0, 40);
    if (!id) return json({ ok: false, error: 'Nothing to remove.' }, 400);
    // removeResponse re-reads what is left rather than subtracting, because a signal drawn from
    // three sentences cannot have a third of itself taken away.
    return state(removeResponse(profile, id));
  }

  // -------------------------------------------------------- the optional reflection layer, opt-in
  if (action === 'reflect') {
    const birthDate = String(body?.birthDate || '').slice(0, 10);
    if (!birthDate) return state({ ...profile, reflection: null });
    const block = buildReflection(birthDate);
    if (!block) return json({ ok: false, error: 'That date could not be read. Use YYYY-MM-DD.' }, 400);
    // Stored on the profile document with excludedFromMatching baked in. Nothing in ranking or
    // retrieval imports the module that produced it — see src/lib/career-intel/reflection.ts.
    return state({ ...profile, reflection: block });
  }

  if (action === 'forget-reflection') {
    return state({ ...profile, reflection: null });
  }

  // -------------------------------------------------------------------------------- starting over
  if (action === 'reset') {
    return state(parseProfile(null));
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
