/** Report probe isolation and acknowledge termination. @example fakeIsolatedRuntime(); */
export async function fakeIsolatedRuntime(reportPath?: string): Promise<void> {
  const observation = {
    pid: process.pid,
    cwd: process.cwd(),
    executable: process.argv[1],
    home: process.env.HOME,
    profile: process.env.USERPROFILE,
    runtime: process.env.MANGOSTUDIO_RUNTIME_BINARY,
    developerSetting: process.env.MANGO_PROBE_PRIVATE_SETTING,
    path: process.env.PATH,
  };

  if (process.argv.includes('--version')) {
    console.log(JSON.stringify(observation));
  } else {
    let descendant: Bun.Subprocess | undefined;
    if (reportPath) {
      const ready = Promise.withResolvers<void>();
      descendant = Bun.spawn({
        cmd: [process.execPath, '-e', "process.send('ready'); setInterval(() => {}, 1000)"],
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
        ipc: () => ready.resolve(),
      });
      await ready.promise;
      await Bun.write(reportPath, JSON.stringify({ ...observation, descendant: descendant.pid }));
    }
    process.on('SIGTERM', () => {
      void (async () => {
        await descendant?.exited;
        console.error('runtime shutdown completed');
        process.exit(0);
      })();
    });
    console.log(JSON.stringify({ type: 'hello', observation }));
    setInterval(() => {}, 1000);
  }
}
