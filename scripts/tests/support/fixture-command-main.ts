// A deadline kills this exact wrapper through its retained process handle. On
// Windows the private job also terminates descendants behind .cmd shims.
if (process.platform === 'win32') {
  const { joinFixtureJob } = await import('./fixture-windows-job');
  joinFixtureJob(process.argv[2] ?? '');
}
const child = Bun.spawn(process.argv.slice(3), {
  stdin: 'ignore',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
