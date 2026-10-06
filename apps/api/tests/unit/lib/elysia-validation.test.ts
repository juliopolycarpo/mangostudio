import { describe, expect, it } from 'bun:test';
import { Elysia, t } from 'elysia';
import Type from 'typebox';
import { registerFileTypeDetector } from '../../../src/lib/file-type-detector';

// TypeBox 1.3.24 removed Validator.buildResult. Elysia beta.19 read it while
// compiling routes, so a compatible peer dependency could still prevent startup.
describe('Elysia and TypeBox compilation', () => {
  for (const precompile of [false, true]) {
    it(`validates request and response schemas with precompile=${precompile}`, async () => {
      const app = new Elysia({ precompile })
        .post(
          '/counts/:id',
          {
            params: t.Object({ id: t.Numeric() }),
            query: Type.Object({ label: Type.String() }),
            headers: Type.Object({ 'x-marker': Type.String() }),
            body: Type.Object({ count: Type.Integer() }),
            response: Type.Object({
              id: Type.Number(),
              label: Type.String(),
              marker: Type.String(),
              count: Type.Integer(),
            }),
          },
          ({ params, query, headers, body }) => ({
            id: params.id,
            label: query.label,
            marker: headers['x-marker'],
            count: body.count,
          })
        )
        .compile();

      const response = await app.handle(
        new Request('http://localhost/counts/7?label=ready', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-marker': 'compiled' },
          body: JSON.stringify({ count: 2 }),
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: 7,
        label: 'ready',
        marker: 'compiled',
        count: 2,
      });

      const rejected = await app.handle(
        new Request('http://localhost/counts/7?label=ready', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-marker': 'compiled' },
          body: JSON.stringify({ count: 'many' }),
        })
      );

      expect(rejected.status).toBe(422);
    });
  }

  it('awaits file content validation after eager compilation', async () => {
    registerFileTypeDetector();
    const app = new Elysia({ precompile: true })
      .post('/image', { body: t.Object({ image: t.File({ type: 'image/*' }) }) }, () => 'ok')
      .compile();
    const form = new FormData();
    form.append(
      'image',
      new File(['plain text pretending to be a PNG'], 'image.png', { type: 'image/png' })
    );

    const response = await app.handle(
      new Request('http://localhost/image', { method: 'POST', body: form })
    );

    expect(response.status).toBe(422);

    const validForm = new FormData();
    const png = Uint8Array.fromBase64(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    );
    validForm.append('image', new File([png], 'image.png', { type: 'image/png' }));

    const accepted = await app.handle(
      new Request('http://localhost/image', { method: 'POST', body: validForm })
    );

    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe('ok');
  });
});
