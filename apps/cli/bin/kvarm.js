#!/usr/bin/env node
import { main } from '../src/main.js';

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
