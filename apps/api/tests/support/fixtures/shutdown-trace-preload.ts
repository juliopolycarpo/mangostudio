if (process.env.MANGO_SHUTDOWN_TRACE === '1')
  process.stderr.write(`preload-admitted ${Math.round(performance.now())}ms\n`);
