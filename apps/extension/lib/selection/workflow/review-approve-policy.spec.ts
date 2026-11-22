import { WorkflowStepType as Step } from '@project-x/types';
import { describe, expect, it } from 'vitest';

import { SELECTABLE_REVIEW_EVENTS } from '../components/review-draft-panel';
import { runWorkflowStepHandler } from './workflow-handlers';

/**
 * H1: approving through Project X is not offered (with the workspace GitHub App the review
 * would be the shared bot's, which the API refuses). The API enforces it; the UI only avoids
 * presenting an action that would fail.
 */
describe('review APPROVE is not offered in the extension', () => {
  it('review composer events', () => {
    expect([...SELECTABLE_REVIEW_EVENTS]).toEqual(['COMMENT', 'REQUEST_CHANGES']);
  });

  it('workflow review-event step', () => {
    const result = runWorkflowStepHandler(Step.USER_SELECT_REVIEW_EVENT, { sessions: {} } as never);
    const options = 'options' in result ? (result.options ?? []) : [];
    expect(options.map((o) => o.id)).toEqual(['COMMENT', 'REQUEST_CHANGES']);
  });
});
