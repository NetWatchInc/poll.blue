// Shared auth state across islands (header account menu + the create form).
// nanostores is the Astro-sanctioned way to share state between islands.
import { atom } from "nanostores";
import type { OAuthUserAgent } from "@atcute/oauth-browser-client";
import {
  devHostIsWrong,
  ensureConfigured,
  getStoredAgent,
  restoreOrFinalize,
  startSignIn,
} from "./oauth";

export interface Account {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

export const $account = atom<Account | null>(null);
export const $authReady = atom<boolean>(false);

let initStarted = false;

/** Run once per page load (module is a shared singleton across islands):
 *  complete an OAuth redirect or restore a stored session, then publish the
 *  account. Network/redirect-free on a fresh visit with no session. */
export async function initSession(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  try {
    ensureConfigured();
    const agent = await restoreOrFinalize();
    if (agent) await loadAccount(agent.sub);
  } catch (e) {
    console.error("session init failed", e);
  } finally {
    $authReady.set(true);
  }
}

async function loadAccount(did: string): Promise<void> {
  let account: Account = { did, handle: did };
  try {
    const r = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
    );
    if (r.ok) {
      const p = await r.json();
      account = { did, handle: p.handle ?? did, displayName: p.displayName, avatar: p.avatar };
    }
  } catch {
    // profile is cosmetic — fall back to the DID
  }
  $account.set(account);
}

/** The OAuth agent for the signed-in account (for making XRPC calls). */
export async function getAgent(): Promise<OAuthUserAgent | null> {
  const account = $account.get();
  if (!account) return null;
  return getStoredAgent(account.did);
}

export async function signIn(handle: string): Promise<void> {
  if (devHostIsWrong()) {
    throw new Error("Open this page at http://127.0.0.1:4321 for local OAuth.");
  }
  ensureConfigured();
  await startSignIn(handle); // resolves identity + redirects to the auth server
}

export async function signOut(): Promise<void> {
  try {
    const agent = await getAgent();
    await agent?.signOut();
  } catch {
    // ignore
  }
  $account.set(null);
}
