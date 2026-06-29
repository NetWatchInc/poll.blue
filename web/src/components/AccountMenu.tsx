import { useStore } from "@nanostores/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { $account, $authReady, type Account, initSession, signIn, signOut } from "../lib/session";

function Avatar({ account, size = 36 }: { account: Account; size?: number }) {
  if (account.avatar) {
    return (
      <img
        src={account.avatar}
        alt={account.handle}
        width={size}
        height={size}
        class="rounded-full object-cover"
        style={`width:${size}px;height:${size}px`}
      />
    );
  }
  const initial = (account.displayName ?? account.handle).charAt(0).toUpperCase();
  return (
    <span
      class="grid place-items-center rounded-full font-display font-bold text-white"
      style={`width:${size}px;height:${size}px;background:linear-gradient(135deg,#1185fe,#073a86)`}
    >
      {initial}
    </span>
  );
}

export default function AccountMenu() {
  const account = useStore($account);
  const ready = useStore($authReady);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signinOpen, setSigninOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initSession();
  }, []);

  // close popovers on outside click / Escape
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setSigninOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setSigninOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  async function doSignIn() {
    setError("");
    const h = handle.trim().replace(/^@/, "");
    if (!h) return setError("Enter your handle.");
    setBusy(true);
    try {
      await signIn(h);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!ready) {
    return <div class="h-9 w-9 animate-pulse rounded-full" style="background: var(--color-paper-2)"></div>;
  }

  if (!account) {
    return (
      <div class="relative" ref={rootRef}>
        <button class="btn btn-primary !px-5 !py-2 text-sm" onClick={() => setSigninOpen(!signinOpen)}>
          Sign in
        </button>
        {signinOpen && (
          <div class="card absolute right-0 z-50 mt-2 w-72 p-4">
            <p class="mb-2 text-sm font-semibold">Sign in with Bluesky</p>
            <input
              class="field"
              type="text"
              placeholder="oakley.bsky.social"
              value={handle}
              autocomplete="username"
              onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") doSignIn(); }}
            />
            <button class="btn btn-primary mt-2 w-full text-sm" disabled={busy || !handle.trim()} onClick={doSignIn}>
              {busy ? "Redirecting…" : "Continue"}
            </button>
            <p class="mt-2 text-xs text-[var(--color-ink-faint)]">Into the Atmosphere!!</p>
            {error && <p class="mt-2 text-xs font-medium text-red-600">{error}</p>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div class="relative" ref={rootRef}>
      <button class="flex items-center gap-2 rounded-full p-0.5 transition-transform hover:scale-105" onClick={() => setMenuOpen(!menuOpen)} aria-label="Account menu">
        <Avatar account={account} />
      </button>
      {menuOpen && (
        <div class="card absolute right-0 z-50 mt-2 w-60 p-2">
          <div class="flex items-center gap-3 px-3 py-2.5">
            <Avatar account={account} size={40} />
            <div class="min-w-0 leading-tight">
              <p class="truncate font-semibold">{account.displayName ?? account.handle}</p>
              <p class="truncate text-sm text-[var(--color-ink-faint)]">@{account.handle}</p>
            </div>
          </div>
          <div class="my-1 border-t" style="border-color: var(--color-line)"></div>
          <a class="block rounded-xl px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-paper-2)]" href="/create">
            Create a poll
          </a>
          <a class="block rounded-xl px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-paper-2)]" href={`https://bsky.app/profile/${account.handle}`} target="_blank" rel="noreferrer">
            View profile on Bluesky ↗
          </a>
          <button class="block w-full rounded-xl px-3 py-2 text-left text-sm font-medium text-red-600 transition-colors hover:bg-red-50" onClick={() => { setMenuOpen(false); signOut(); }}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
