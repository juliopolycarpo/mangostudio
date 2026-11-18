import { RuleFilePreviewBodySchema } from '@mangostudio/shared/prompt-rules';
import { Elysia, status } from 'elysia';

import { apiErrorStatus } from '../../../lib/api-error-status';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  getDefaultRuleFileDescriptors,
  previewRuleFile,
  RuleFileError,
} from '../application/rule-file-resolver';

function handleRuleFileError(error: unknown) {
  if (error instanceof RuleFileError) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  console.error('[prompt-rules] Unexpected error:', error);
  return status(500, { error: 'Unexpected error while processing rule file.', code: 'INTERNAL' });
}

export const ruleFileRoutes = new Elysia().use(requireAuth).group('/rule-files', (app) =>
  app
    .get('/defaults', () => {
      return { files: getDefaultRuleFileDescriptors() };
    })

    .post(
      '/preview',
      {
        body: RuleFilePreviewBodySchema,
      },
      ({ body }) => {
        try {
          return previewRuleFile(body.path);
        } catch (error) {
          return handleRuleFileError(error);
        }
      }
    )
);
