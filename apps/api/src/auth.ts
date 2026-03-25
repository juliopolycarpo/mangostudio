import { betterAuth } from 'better-auth';
import { getDb } from './db/database';

export const auth = betterAuth({
  // Usar a instância Kysely existente do projeto
  database: {
    db: getDb(),
    type: 'sqlite',
  },

  // Base path alinhado com o mount point do Elysia
  basePath: '/api/auth',

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: true, // após signup, já cria sessão
  },

  // Permitir requests do frontend em dev
  trustedOrigins: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    // Em produção, adicionar o domínio real
  ],

  session: {
    // Cookie-based sessions (padrão do Better Auth)
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // cache de 5 minutos para evitar DB hits
    },
  },

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3001',
});
