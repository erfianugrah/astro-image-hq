/**
 * Subprocess execution abstraction. Wrapping `child_process.execFile` behind
 * a function type makes capability detection trivially mockable in tests.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly ok: boolean;
}

export type Runner = (cmd: string, args: readonly string[]) => Promise<RunResult>;

/** Default runner: executes via `child_process.execFile`. */
export const defaultRunner: Runner = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, [...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, ok: true };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      ok: false,
    };
  }
};
