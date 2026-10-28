/** The DROPBOX_* settings, while the variables every paid service shares are loadServiceEnv's */
import { resolve } from "node:path";
import { ConfigError, read, readInt, readUrl, type Env } from "@z402/service-kit";
import { MAX_POLL_MS } from "./tip.js";

export interface DropboxConfig {
  /** Absolute path of the directory the drops are stored in */
  dir: string;
  /** Largest upload in bytes */
  maxBytes: number;
  /** Largest total of all stored uploads in bytes */
  maxTotalBytes: number;
  /** Blocks one paid call buys */
  blocksPerCall: number;
  /** A drop is never held more than this many blocks past the current tip */
  maxHoldBlocks: number;
  lwdUrl: string;
  tipPollMs: number;
  /** Upload attempts per minute per client, the paid retry of an attempt that passed not counted */
  ratePerMin: number;
}

const DEFAULT_DIR = ".data/dropbox";
const DEFAULT_LWD_URL = "http://127.0.0.1:28137";
const GIB = 1024 ** 3;
const MAX_BLOCKS = 1_000_000_000;
const MIN_POLL_MS = 100;

/** Reads and checks DROPBOX_*, throwing a ConfigError that names the variable at fault */
export function loadDropboxConfig(env: Env): DropboxConfig {
  const dir = read(env, "DROPBOX_DIR") ?? DEFAULT_DIR;
  if (dir.trim() === "") throw new ConfigError("DROPBOX_DIR: must not be blank");

  const maxBytes = readInt(env, "DROPBOX_MAX_BYTES", 1024 ** 2, 1, GIB);
  const maxTotalBytes = readInt(env, "DROPBOX_MAX_TOTAL_BYTES", 256 * 1024 ** 2, 1);
  if (maxTotalBytes < maxBytes) {
    throw new ConfigError("DROPBOX_MAX_TOTAL_BYTES: must be at least DROPBOX_MAX_BYTES, or no upload could ever fit");
  }

  const blocksPerCall = readInt(env, "DROPBOX_BLOCKS_PER_CALL", 10, 1, MAX_BLOCKS);
  const maxHoldBlocks = readInt(env, "DROPBOX_MAX_HOLD_BLOCKS", 1000, 1, MAX_BLOCKS);
  if (maxHoldBlocks < blocksPerCall) {
    throw new ConfigError(
      "DROPBOX_MAX_HOLD_BLOCKS: must be at least DROPBOX_BLOCKS_PER_CALL, or no call could be held",
    );
  }

  return {
    // A relative path is relative to the working directory of the process
    dir: resolve(dir),
    maxBytes,
    maxTotalBytes,
    blocksPerCall,
    maxHoldBlocks,
    lwdUrl: readUrl(env, "DROPBOX_LWD_URL", DEFAULT_LWD_URL),
    tipPollMs: readInt(env, "DROPBOX_TIP_POLL_MS", 10_000, MIN_POLL_MS, MAX_POLL_MS),
    ratePerMin: readInt(env, "DROPBOX_RATE_PER_MIN", 30, 1, 100_000),
  };
}
