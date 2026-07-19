import { describe, expect, it } from 'bun:test';
import { en, ptBR } from '../../src/i18n';

describe('i18n provider-neutral copy', () => {
  it('keeps generic chat placeholder copy provider-neutral', () => {
    expect(en.chat.input.placeholder).not.toContain('Gemini');
    expect(ptBR.chat.input.placeholder).not.toContain('Gemini');
  });

  it('keeps generated image filenames provider-neutral', () => {
    expect(en.common.downloadFilenamePrefix).toBe('mangostudio');
    expect(ptBR.common.downloadFilenamePrefix).toBe('mangostudio');
  });

  it('provides model selector placeholder labels', () => {
    expect(en.models.loading).toBe('Loading models...');
    expect(en.models.unavailable).toBe('Models unavailable');
    expect(en.models.noModelsAvailable).toBe('No models available');
    expect(ptBR.models.loading).toBe('Carregando modelos...');
    expect(ptBR.models.unavailable).toBe('Modelos indisponíveis');
    expect(ptBR.models.noModelsAvailable).toBe('Nenhum modelo disponível');
  });

  it('provides generation error fallback labels', () => {
    expect(en.errors.textGenerationFailed).toBe('Failed to get a response. Please try again.');
    expect(en.errors.imageGenerationFailed).toBe('Failed to generate image. Please try again.');
    expect(ptBR.errors.textGenerationFailed).toBe('Falha ao obter uma resposta. Tente novamente.');
    expect(ptBR.errors.imageGenerationFailed).toBe('Falha ao gerar imagem. Tente novamente.');
  });

  it('provides accessibility labels', () => {
    expect(en.common.openMenu).toBe('Open menu');
    expect(en.common.closeMenu).toBe('Close menu');
    expect(en.common.settingsNavigation).toBe('Settings navigation');
    expect(en.common.contextIndicator).toBe('Context usage indicator');
    expect(en.common.mangoStudioLogo).toBe('Mango Studio Logo');
    expect(ptBR.common.openMenu).toBe('Abrir menu');
    expect(ptBR.common.closeMenu).toBe('Fechar menu');
    expect(ptBR.common.settingsNavigation).toBe('Navegação de configurações');
    expect(ptBR.common.contextIndicator).toBe('Indicador de uso de contexto');
    expect(ptBR.common.mangoStudioLogo).toBe('Logo do Mango Studio');
  });

  it('provides common action labels', () => {
    expect(en.common.retry).toBe('Retry');
    expect(en.common.noResultsFor).toContain('{query}');
    expect(ptBR.common.retry).toBe('Tentar novamente');
    expect(ptBR.common.noResultsFor).toContain('{query}');
  });

  it('provides tool call section labels', () => {
    expect(en.tools.argsLabel).toBe('args');
    expect(en.tools.errorLabel).toBe('error');
    expect(en.tools.resultLabel).toBe('result');
    expect(ptBR.tools.argsLabel).toBe('argumentos');
    expect(ptBR.tools.errorLabel).toBe('erro');
    expect(ptBR.tools.resultLabel).toBe('resultado');
  });

  it('provides chat feed fallback labels', () => {
    expect(en.chat.feed.neuralDiffusionPath).toBe('Using Neural Diffusion Path.');
    expect(ptBR.chat.feed.neuralDiffusionPath).toBe('Usando Neural Diffusion Path.');
  });

  it('provides provider settings labels', () => {
    expect(en.settings.providers.reservedForFuture).toBe('Reserved for future settings');
    expect(en.settings.providers.maxOutputTokensPlaceholder).toContain('{limit}');
    expect(ptBR.settings.providers.reservedForFuture).toBe('Reservado para configurações futuras');
    expect(ptBR.settings.providers.maxOutputTokensPlaceholder).toContain('{limit}');
  });

  it('provides ChatGPT connector OAuth labels', () => {
    expect(en.settings.connectors.chatgptSignInButton).toBe('Sign in with ChatGPT');
    expect(en.settings.connectors.chatgptPortBusyError).toContain('1455');
    expect(ptBR.settings.connectors.chatgptSignInButton).toBe('Entrar com ChatGPT');
    expect(ptBR.settings.connectors.chatgptPortBusyError).toContain('1455');
  });
});
