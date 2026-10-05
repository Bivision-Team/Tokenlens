#!/usr/bin/env node
import { runHook } from "../src/hook.js";

// Hooks must stay silent: stdout becomes Claude context for several hook events.
runHook().catch(() => {
  process.exitCode = 0;
});
