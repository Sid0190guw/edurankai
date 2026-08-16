// src/lib/mailplatform/examples.ts — the two recruitment workflows from the specification, as data.
//
// They are DEFINITIONS, not code paths: installing one writes a row that the same engine, the same
// validator and the same builder handle as any workflow an operator draws by hand. Nothing here is
// special-cased anywhere else in this module, which is the test of whether the engine is general.
//
// The copy follows this platform's language rules — no emojis, no competitor or company names, and
// nothing that claims EduRankAI awards a credential. An internship is unpaid unless a stipend has
// actually been recorded, so no example says otherwise.
import type { WorkflowDefinition } from './graph';

export interface WorkflowExample {
  key: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
}

/**
 * STAGE PROGRESSION
 *
 *   application.stage.changed -> stage is 3? -> send the stage-3 letter -> wait 24 hours
 *   -> assessment still incomplete? -> yes: remind. no: tag them and finish.
 *
 * The 24-hour wait is the whole reason the condition after it is worth asking: it is answered
 * against the contact AS IT IS THEN, not the copy taken when the stage changed.
 */
const stageProgression: WorkflowExample = {
  key: 'stage-3-progression',
  name: 'Application stage 3, then an assessment nudge',
  description: 'When an application reaches stage 3, send the stage-3 message, wait a day, and remind anyone whose assessment is still not finished.',
  definition: {
    version: 1,
    nodes: [
      { id: 'trigger_1', kind: 'trigger', label: 'Application stage changed', trigger: { event: 'application.stage.changed' } },
      {
        id: 'condition_1', kind: 'condition', label: 'Is it stage 3?',
        // The trigger fires for EVERY stage change; this is what narrows it. Written as a condition
        // rather than a trigger filter so the run is recorded either way and "why did this not
        // fire?" is answerable from the run list.
        condition: { field: 'event.stage', operator: 'equals', value: '3' },
      },
      {
        id: 'action_1', kind: 'action', label: 'Send the stage 3 message',
        action: {
          type: 'send_email',
          params: {
            subject: 'Your application has moved to stage 3, {{first_name}}',
            html: '<p>Hello {{first_name|default:there}},</p>'
              + '<p>Your application {{application_id}} has moved to stage 3. The next step is the online assessment, which you can start from your portal.</p>'
              + '<p>If you have already finished it, nothing further is needed from you right now.</p>'
              + '<p>The EduRankAI admissions team</p>',
            text: 'Hello {{first_name|default:there}}, your application {{application_id}} has moved to stage 3. The next step is the online assessment, which you can start from your portal.',
          },
        },
      },
      { id: 'delay_1', kind: 'delay', label: 'Wait 24 hours', delay: { kind: 'hours', amount: 24 } },
      {
        id: 'condition_2', kind: 'condition', label: 'Assessment still incomplete?',
        // TRUE means incomplete. `does_not_exist` covers the contact who never started; the OR arm
        // covers the one whose record says so explicitly. Either way the answer is "not done yet".
        condition: {
          or: [
            { field: 'contact.custom.assessment_completed', operator: 'does_not_exist' },
            { field: 'contact.custom.assessment_completed', operator: 'not_equals', value: 'true' },
          ],
        },
      },
      {
        id: 'action_2', kind: 'action', label: 'Send the reminder',
        action: {
          type: 'send_email',
          params: {
            subject: 'A reminder about your assessment, {{first_name}}',
            html: '<p>Hello {{first_name|default:there}},</p>'
              + '<p>Your assessment for application {{application_id}} is still open. It takes about forty minutes and can be started from your portal whenever suits you.</p>'
              + '<p>If you have finished it in the last few minutes, please ignore this.</p>'
              + '<p>The EduRankAI admissions team</p>',
            text: 'Hello {{first_name|default:there}}, your assessment for application {{application_id}} is still open. It can be started from your portal.',
          },
        },
      },
      { id: 'action_3', kind: 'action', label: 'Tag as assessment done', action: { type: 'add_tag', params: { tag: 'assessment-complete' } } },
    ],
    edges: [
      { id: 'e1', from: 'trigger_1', to: 'condition_1' },
      { id: 'e2', from: 'condition_1', to: 'action_1', branch: 'true' },
      // No 'false' edge: a stage change that is not stage 3 simply ends. That is a WARNING in the
      // validator, not an error, and it is the intended shape here.
      { id: 'e3', from: 'action_1', to: 'delay_1' },
      { id: 'e4', from: 'delay_1', to: 'condition_2' },
      { id: 'e5', from: 'condition_2', to: 'action_2', branch: 'true' },
      { id: 'e6', from: 'condition_2', to: 'action_3', branch: 'false' },
    ],
  },
};

/**
 * CANDIDATE DEADLINE
 *
 *   assessment.assigned -> wait until (deadline - 24h) -> still incomplete? -> remind
 *
 * The delay is `until_field`: the workflow author does not know any candidate's deadline, and the
 * event carries it. A candidate whose event arrives with no deadline ends the run with a sentence
 * saying so — the engine does not invent a date and mail somebody a deadline they do not have.
 */
const candidateDeadline: WorkflowExample = {
  key: 'assessment-deadline-reminder',
  name: 'Assessment deadline: remind a day before',
  description: 'When an assessment is assigned, wait until 24 hours before its deadline and remind anyone who has not finished.',
  definition: {
    version: 1,
    nodes: [
      { id: 'trigger_1', kind: 'trigger', label: 'Assessment assigned', trigger: { event: 'assessment.assigned' } },
      {
        id: 'delay_1', kind: 'delay', label: 'Wait until 24 hours before the deadline',
        delay: { kind: 'until_field', field: 'event.deadline_at', offsetMinutes: -1440 },
      },
      {
        id: 'condition_1', kind: 'condition', label: 'Still incomplete?',
        condition: {
          or: [
            { field: 'contact.custom.assessment_completed', operator: 'does_not_exist' },
            { field: 'contact.custom.assessment_completed', operator: 'not_equals', value: 'true' },
          ],
        },
      },
      {
        id: 'action_1', kind: 'action', label: 'Send the deadline reminder',
        action: {
          type: 'send_email',
          params: {
            subject: 'Your assessment closes tomorrow, {{first_name}}',
            html: '<p>Hello {{first_name|default:there}},</p>'
              + '<p>Your assessment closes on {{event.deadline_at}}. It can be started from your portal at any time before then.</p>'
              + '<p>If you have already submitted it, please ignore this.</p>'
              + '<p>The EduRankAI admissions team</p>',
            text: 'Hello {{first_name|default:there}}, your assessment closes on {{event.deadline_at}}. It can be started from your portal at any time before then.',
          },
        },
      },
    ],
    edges: [
      { id: 'e1', from: 'trigger_1', to: 'delay_1' },
      { id: 'e2', from: 'delay_1', to: 'condition_1' },
      { id: 'e3', from: 'condition_1', to: 'action_1', branch: 'true' },
    ],
  },
};

export const WORKFLOW_EXAMPLES: readonly WorkflowExample[] = [stageProgression, candidateDeadline];

export function exampleByKey(key: string): WorkflowExample | null {
  return WORKFLOW_EXAMPLES.find((e) => e.key === key) || null;
}
