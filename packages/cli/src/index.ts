#!/usr/bin/env -S npx tsx
/**
 * deployctl — the one command a non-engineer (or Claude on their behalf) runs to put an
 * app on the internet. It makes every technology decision for them and never asks a
 * question only an engineer could answer.
 */
import { Command } from "commander";
import { runCheck, runCheckHook, runCheckWithBuild } from "./commands/check.ts";
import { runUp } from "./commands/up.ts";
import { runDown } from "./commands/down.ts";
import { runReview } from "./commands/review.ts";

const program = new Command();

program
  .name("deployctl")
  .description("Put a Claude-built app on the internet in one command.")
  .version("0.1.0");

program
  .command("check")
  .argument("[app]", "path to the app folder", ".")
  .option("--hook", "run as a Claude Code Stop hook (silent on success, exit 2 on problems)")
  .option("--build", "also build the app to prove it really deploys (slower)")
  .description("Tell me if this app is ready to deploy, in plain English.")
  .action(async (app: string, options: { hook?: boolean; build?: boolean }) => {
    if (options.hook) process.exitCode = runCheckHook(app);
    else if (options.build) process.exitCode = await runCheckWithBuild(app);
    else process.exitCode = runCheck(app);
  });

program
  .command("preflight")
  .argument("[app]", "path to the app folder", ".")
  .description("The full pre-deploy gate: the shape check, plus a real build, before anything goes live.")
  .action(async (app: string) => {
    process.exitCode = await runCheckWithBuild(app);
  });

program
  .command("up")
  .argument("[app]", "path to the app folder", ".")
  .option("--dry-run", "show what would happen without doing it")
  .option("--skip-build-check", "skip the pre-deploy build (the host will still build it)")
  .description("Deploy the app. Database, front door, storage, and a live URL, all set up for you.")
  .action(async (app: string, options: { dryRun?: boolean; skipBuildCheck?: boolean }) => {
    process.exitCode = await runUp(app, { dryRun: options.dryRun, skipBuildCheck: options.skipBuildCheck });
  });

program
  .command("review")
  .argument("[app]", "path to the app folder", ".")
  .option("--no-brief", "skip the AI brief; show the deterministic facts and verdict only")
  .option("--json", "print the full review as JSON")
  .description("Write a deployment approval brief: what it does, what it connects to, and a compliance verdict.")
  .action(async (app: string, options: { brief?: boolean; json?: boolean }) => {
    process.exitCode = await runReview(app, { brief: options.brief, json: options.json });
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
