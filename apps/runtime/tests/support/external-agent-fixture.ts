import { spawn } from 'node:child_process';

const mode = process.argv[process.argv.indexOf('--mode') + 1];

switch (mode) {
  case 'partial':
    process.stdout.write('first');
    setTimeout(() => {
      process.stdout.write(' line\nsecond\n');
      process.exit(0);
    }, 10);
    break;
  case 'oversized':
    process.stdout.write(`${'x'.repeat(256)}\n`);
    break;
  case 'buffered':
    process.stdout.write('one\ntwo\nthree\n');
    setTimeout(() => process.exit(0), 50);
    break;
  case 'environment':
    process.stdout.write(`${JSON.stringify(process.env)}\n`);
    break;
  case 'stderr':
    process.stderr.write(
      'Authorization: Bearer top-secret API_KEY=another-secret redis://app:password@db/main'
    );
    setTimeout(() => process.exit(1), 10);
    break;
  case 'graceful':
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      if (chunk.includes('shutdown')) process.exit(0);
    });
    break;
  case 'tree': {
    const descendant = spawn(process.execPath, [import.meta.path, '--mode', 'descendant'], {
      stdio: 'ignore',
    });
    process.stdout.write(`${descendant.pid}\n`);
    process.on('SIGTERM', () => undefined);
    setInterval(() => undefined, 1_000);
    break;
  }
  case 'descendant':
    process.on('SIGTERM', () => undefined);
    setInterval(() => undefined, 1_000);
    break;
  default:
    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exit(2);
}
