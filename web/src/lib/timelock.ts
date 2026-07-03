// Timelock encryption via drand (tlock). A "sealed" poll encrypts each voter's
// choice to a future drand round; the ciphertext can only be decrypted once that
// round's beacon is published — i.e. after the poll closes. Nobody (not the
// creator, not poll.blue) can read votes early; after close ANYONE can decrypt
// and tally. This module is dynamically imported so the (heavy) BLS crypto is
// only fetched when a sealed poll is actually created or read.

import { mainnetClient, roundAt, timelockDecrypt, timelockEncrypt, Buffer } from "tlock-js";

let _client: ReturnType<typeof mainnetClient> | undefined;
function client() {
  return (_client ??= mainnetClient());
}

/** The drand round + chain hash that unlocks at (or just after) `endsAtMs`. */
export async function sealParamsFor(endsAtMs: number): Promise<{ round: number; chain: string }> {
  const info = await client().chain().info();
  return { round: roundAt(endsAtMs, info), chain: info.hash };
}

/** Encrypt a choice so it can't be read until `round` is published. */
export async function sealChoice(round: number, plaintext: string): Promise<string> {
  return timelockEncrypt(round, Buffer.from(plaintext), client());
}

/** Decrypt a sealed choice. Throws if the round isn't available yet. */
export async function unsealChoice(ciphertext: string): Promise<string> {
  const buf = await timelockDecrypt(ciphertext, client());
  return buf.toString();
}
