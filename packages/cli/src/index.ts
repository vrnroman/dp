#!/usr/bin/env -S npx tsx
/**
 * deployctl — the one command a non-engineer (or Claude on their behalf) runs to put an
 * app on the internet. It makes every technology decision for them and never asks a
 * question only an engineer could answer.
 */
import { Command } from "commander";
import { runCheck, runCheckHook } from "./commands/check.ts";
import { runUp } from "./commands/up.ts";
import { runDown } from "./commands/down.ts";

const program = new Command();

program
  .name("deployctl")
  .description("Put a Claude-built app on the internet in one command.")
  .version("0.1.0");

program
  .command("check")
  .argument("[app]", "path to the app folder", ".")
  .option("--hook", "run as a Claude Code Stop hook (silent on success, exit 2 on problems)")
  .description("Tell me if this app is ready to deploy, in plain English.")
  .action((app: string, options: { hook?: boolean }) => {
    process.exitCode = options.hook ? runCheckHook(app) : runCheck(app);
  });

program
  .command("up")
  .argument("[app]", "path to the app folder", ".")
  .option("--dry-run", "show what would happen without doing it")
  .description("Deploy the app. Database, front door, storage, and a live URL, all set up for you.")
  .action(async (app: string, options: { dryRun?: boolean }) => {
    process.exitCode = await runUp(app, { dryRun: options.dryRun });
  });

program
  .command("down")
  .argument("[app]", "path to the app folder", ".")
  .option("--yes", "confirm permanent removal")
  .description("Take the app down and remove everything it created.")
  .action(async (app: string, options: { yes?: boolean }) => {
    process.exitCode = await runDown(app, { yes: options.yes });
  });

program.parseAsync(process.argv);
