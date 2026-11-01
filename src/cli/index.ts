#!/usr/bin/env node

/**
 * wave-adk CLI — Agent Developer Kit command-line interface
 *
 * Commands:
 *   wave-adk init [template] [dir]   Scaffold a new agent project via @wave-av/create-app
 *   wave-adk help                    Show help
 *
 * deploy, test, logs and status exit 1 with "not implemented" until a WAVE API
 * operation backs them. See ./run.ts.
 */

import { run } from './run';

process.exitCode = run(process.argv.slice(2));
