/**
 * Human-narrated progress. The non-engineer should never see "provisioning Postgres
 * instance" or a stack of CLI noise. They see plain sentences about what is happening to
 * their app, in order. Each line maps to a real step the deploy actually takes.
 */
import ora, { type Ora } from "ora";

export class Narrator {
  private spinner: Ora | null = null;
  private quiet: boolean;

  // When output is not a terminal (piped, captured by the portal, redirected to a log),
  // there is no spinner to animate, so we print each step as a plain line instead. That way
  // the portal can stream real progress to the browser, and logs stay readable.
  constructor(quiet = !process.stdout.isTTY) {
    this.quiet = quiet;
  }

  /** Begin a step. Pass plain English: "Setting up where your data lives". */
  start(text: string): void {
    if (this.quiet) {
      process.stdout.write(`… ${text}\n`);
      return;
    }
    this.spinner = ora({ text, spinner: "dots" }).start();
  }

  update(text: string): void {
    if (this.spinner) this.spinner.text = text;
    else if (this.quiet) process.stdout.write(`… ${text}\n`);
  }

  done(text?: string): void {
    if (this.spinner) this.spinner.succeed(text);
    else if (text) process.stdout.write(`✓ ${text}\n`);
    this.spinner = null;
  }

  fail(text?: string): void {
    if (this.spinner) this.spinner.fail(text);
    else if (text) process.stdout.write(`✗ ${text}\n`);
    this.spinner = null;
  }

  info(text: string): void {
    process.stdout.write(`${text}\n`);
  }
}
