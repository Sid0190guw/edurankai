// src/lib/mailplatform/examples.ts — the two recruitment automations from the specification, as data.
//
// They are GRAPHS in the canvas's own shape, so installing one writes an ordinary `mail_automations`
// row that /mail/automations opens, validates and publishes like any other. Nothing here is
// special-cased anywhere else, which is the test of whether the engine is general.
//
// EVERY PATH ENDS IN AN End STEP, because validateGraph() refuses to publish a step that leads
// nowhere — a non-terminal node with no outgoing edge silently drops the run.
//
// THE SEND STEPS NAME NO TEMPLATE, DELIBERATELY. An example cannot know the id of a template on this
// installation, and inventing one would produce an automation that publishes and then fails every
// candidate at the send. Left empty, the canvas's own validator says "Choose the template this step
// sends" against that exact node, which is the correct next action for whoever installed it.
//
// The copy is chosen elsewhere (the template), so nothing here claims EduRankAI awards a credential
// and no example implies a stipend.
import type { AutomationGraph } from './graph';

export interface AutomationExample {
  key: string;
  name: string;
  description: string;
  graph: AutomationGraph;
}

/**
 * STAGE PROGRESSION
 *
 *   stage changed -> is it 3? -> send the stage-3 message -> wait 24 hours
 *   -> assessment still incomplete? -> yes: remind. no: tag them.
 *
 * The 24-hour wait is the whole reason the condition after it is worth asking: it is answered
 * against the contact AS IT IS THEN, not the copy taken when the stage changed.
 */
const stageProgression: AutomationExample = {
  key: 'stage-3-progression',
  name: 'Application stage 3, then an assessment nudge',
  description: 'When an application reaches stage 3, send the stage-3 message, wait a day, and remind anyone whose assessment is still not finished. Choose a template on each send step before switching it on.',
  graph: {
    nodes: [
      { id: 'trigger_1', kind: 'trigger', x: 0, y: 0, config: { event: 'application_stage_changed' } },
      // The trigger fires for EVERY stage change; this narrows it. Written as a condition rather than
      // a trigger filter so a run is recorded either way and "why did this not fire?" is answerable
      // from the runs list.
      { id: 'condition_1', kind: 'condition', x: 0, y: 120, config: { field: 'stage', operator: 'equals', value: '3' } },
      { id: 'send_1', kind: 'send_email', x: -120, y: 240, config: { templateId: '' } },
      { id: 'delay_1', kind: 'delay', x: -120, y: 360, config: { minutes: 1440 } },
      // TRUE means still incomplete: `not_equals 'true'` is also true of a contact the field was
      // never set on, which is exactly the candidate who has not started.
      { id: 'condition_2', kind: 'condition', x: -120, y: 480, config: { field: 'assessment_completed', operator: 'not_equals', value: 'true' } },
      { id: 'send_2', kind: 'send_email', x: -240, y: 600, config: { templateId: '' } },
      { id: 'add_tag_1', kind: 'add_tag', x: 0, y: 600, config: { tag: 'assessment-complete' } },
      { id: 'end_1', kind: 'end', x: 160, y: 240, config: {} },
      { id: 'end_2', kind: 'end', x: -240, y: 720, config: {} },
      { id: 'end_3', kind: 'end', x: 0, y: 720, config: {} },
    ],
    edges: [
      { from: 'trigger_1', to: 'condition_1' },
      { from: 'condition_1', to: 'send_1', branch: 'yes' },
      { from: 'condition_1', to: 'end_1', branch: 'no' },
      { from: 'send_1', to: 'delay_1' },
      { from: 'delay_1', to: 'condition_2' },
      { from: 'condition_2', to: 'send_2', branch: 'yes' },
      { from: 'condition_2', to: 'add_tag_1', branch: 'no' },
      { from: 'send_2', to: 'end_2' },
      { from: 'add_tag_1', to: 'end_3' },
    ],
  },
};

/**
 * CANDIDATE DEADLINE
 *
 *   assessment assigned -> wait until (deadline - 24h) -> still incomplete? -> remind
 *
 * The delay is `untilField`: the author does not know any candidate's deadline, and the event
 * carries it. A candidate whose event arrives with no deadline ends the run with a sentence saying
 * so — the engine does not invent a date and mail somebody a deadline they do not have.
 */
const candidateDeadline: AutomationExample = {
  key: 'assessment-deadline-reminder',
  name: 'Assessment deadline: remind a day before',
  description: 'When an assessment is assigned, wait until 24 hours before its deadline and remind anyone who has not finished. Choose a template on the send step before switching it on.',
  graph: {
    nodes: [
      { id: 'trigger_1', kind: 'trigger', x: 0, y: 0, config: { event: 'assessment.assigned' } },
      { id: 'delay_1', kind: 'delay', x: 0, y: 120, config: { untilField: 'event.deadline_at', offsetMinutes: -1440 } },
      { id: 'condition_1', kind: 'condition', x: 0, y: 240, config: { field: 'assessment_completed', operator: 'not_equals', value: 'true' } },
      { id: 'send_1', kind: 'send_email', x: -120, y: 360, config: { templateId: '' } },
      { id: 'end_1', kind: 'end', x: 120, y: 360, config: {} },
      { id: 'end_2', kind: 'end', x: -120, y: 480, config: {} },
    ],
    edges: [
      { from: 'trigger_1', to: 'delay_1' },
      { from: 'delay_1', to: 'condition_1' },
      { from: 'condition_1', to: 'send_1', branch: 'yes' },
      { from: 'condition_1', to: 'end_1', branch: 'no' },
      { from: 'send_1', to: 'end_2' },
    ],
  },
};

export const AUTOMATION_EXAMPLES: readonly AutomationExample[] = [stageProgression, candidateDeadline];

export function exampleByKey(key: string): AutomationExample | null {
  return AUTOMATION_EXAMPLES.find((e) => e.key === key) || null;
}

export function listExamples() {
  return AUTOMATION_EXAMPLES.map((e) => ({ key: e.key, name: e.name, description: e.description, steps: e.graph.nodes.length }));
}
