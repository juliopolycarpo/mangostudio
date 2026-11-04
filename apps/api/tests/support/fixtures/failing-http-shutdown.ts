import { app } from '../../../src/app';

/** Model a drain failure without asserting that active writers have settled. */
app.stop = () => Promise.reject(new Error('fixture HTTP drain failed'));
