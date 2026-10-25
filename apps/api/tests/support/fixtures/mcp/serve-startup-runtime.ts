/** Native test executable: either exits before health or accepts a health request without answering. */
import { writeFileSync } from 'node:fs';

const { mode, journal } = JSON.parse(process.env.MANGOSTUDIO_RUNTIME_SERVE_TOKEN ?? '{}') as {
  mode: 'exit' | 'pending-health';
  journal: string;
};
const receipt = { pid: process.pid, mangoHome: process.env.MANGO_HOME, home: process.env.HOME };
if (mode === 'exit') {
  writeFileSync(journal, JSON.stringify(receipt));
  console.error('NAMED_SERVE_STARTUP_EXIT');
  process.exit(17);
}
const listen = process.argv[process.argv.indexOf('--listen') + 1];
const port = Number(listen?.split(':').at(-1));
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request) {
    if (new URL(request.url).pathname !== '/health')
      throw new Error(`Unexpected fixture URL: ${request.url}`);
    writeFileSync(journal, JSON.stringify(receipt));
    return new Promise<Response>(() => {
      /* Deliberately accepts health without responding. */
    });
  },
});
