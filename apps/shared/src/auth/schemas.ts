import { Type, type Static } from '@sinclair/typebox';

export const SignUpBodySchema = Type.Object({
  name: Type.String(),
  email: Type.String(),
  password: Type.String(),
});

export type SignUpBody = Static<typeof SignUpBodySchema>;

export const SignInBodySchema = Type.Object({
  email: Type.String(),
  password: Type.String(),
});

export type SignInBody = Static<typeof SignInBodySchema>;
