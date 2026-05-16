import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { RuleFilePreviewBodySchema } from '@mangostudio/shared/prompt-rules';
import { Elysia } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  getDefaultRuleFileDescriptors,
  previewRuleFile,
  RuleFileError,
} from '../application/rule-file-resolver';

function handleRuleFileError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof RuleFileError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  console.error('[prompt-rules] Unexpected error:', error);
  set.status = 500;
  return { error: 'Unexpected error while processing rule file.', code: 'INTERNAL' };
}

export const ruleFileRoutes = new Elysia().use(requireAuth).group('/rule-files', (app) =>
  app
    .get('/defaults', () => {
      return { files: getDefaultRuleFileDescriptors() };
    })

    .post(
      '/preview',
      ({ body, set }) => {
        try {
          return previewRuleFile(body.path);
        } catch (error) {
          return handleRuleFileError(error, set);
        }
      },
      {
        body: RuleFilePreviewBodySchema,
      }
    )
);
