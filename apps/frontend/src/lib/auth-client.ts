import { createAuthClient } from 'better-auth/react';
import { getApiBaseUrl } from './api-base-url';

export const authClient = createAuthClient({
  baseURL: getApiBaseUrl(),
  basePath: '/api/auth',
});
