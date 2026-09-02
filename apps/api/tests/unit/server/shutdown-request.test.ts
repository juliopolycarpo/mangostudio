import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  registerShutdownHandler,
  requestShutdown,
  resetShutdownRequestForTest,
} from '../../../src/server/shutdown-request';

afterEach(() => {
  resetShutdownRequestForTest();
});

describe('requestShutdown', () => {
  it('runs the registered stop once and then exits', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let stops = 0;
    registerShutdownHandler(() => {
      stops += 1;
      return Promise.resolve();
    });
    try {
      requestShutdown();
      requestShutdown();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stops).toBe(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('exits even when nothing was registered', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      requestShutdown();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
