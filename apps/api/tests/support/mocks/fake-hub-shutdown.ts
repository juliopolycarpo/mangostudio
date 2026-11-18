import type {
  HubShutdownAnswer,
  HubShutdownRequester,
} from '../../../src/cli/hub-shutdown-request';
import type { ServerState } from '../../../src/lib/server-state';

/**
 * Stand-in for the CLI's loopback shutdown request: a scripted answer and the states it was
 * asked about, with no socket. Whether the hub's pid then exits is the test's to script on its
 * `FakeProcessController`.
 */
export class FakeHubShutdown {
  readonly requested: ServerState[] = [];

  constructor(private readonly answer: HubShutdownAnswer) {}

  readonly request: HubShutdownRequester = (state) => {
    this.requested.push(state);
    return Promise.resolve(this.answer);
  };
}
