import { appendFileSync } from "fs";

const startupLogPath = process.env.GLOOMBERB_STARTUP_LOG;

function serializeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function logStartup(message: string): void {
  if (!startupLogPath) return;
  try {
    appendFileSync(startupLogPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Startup diagnostics must never interfere with the application.
  }
}

logStartup("entry started");
process.on("uncaughtException", (error) => {
  logStartup(`uncaught exception\n${serializeError(error)}`);
});
process.on("unhandledRejection", (error) => {
  logStartup(`unhandled rejection\n${serializeError(error)}`);
});

try {
  await import("./index");
  logStartup("entry loaded");
} catch (error) {
  logStartup(`entry import failed\n${serializeError(error)}`);
  throw error;
}
