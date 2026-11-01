import { env } from 'cloudflare:workers';
import type { Env } from '../src/env.js';

/** The test runtime's bindings, typed as the Worker's own `Env`. */
export const testEnv = env as unknown as Env;
