import { earliestListenerHello, prebufferedAcceptedHello } from './ipc-buffered-hello';

await prebufferedAcceptedHello();
await earliestListenerHello();
process.stdout.write('passed: prebuffered and earliest peer hello on native Node\n');
