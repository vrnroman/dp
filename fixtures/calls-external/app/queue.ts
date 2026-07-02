// Runs work in the background through a BullMQ queue (backed by Redis). Another external system
// the evaluator should surface for approval, detected from the "bullmq" dependency.
import { Queue } from "bullmq";

const emails = new Queue("emails");

export async function enqueueWelcome(userId: string) {
  await emails.add("welcome", { userId });
}
