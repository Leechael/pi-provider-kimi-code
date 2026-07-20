import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests mock proper-lockfile itself (pi's own auth-storage tests do the
// same via vitest spies): lock compromise cannot be triggered deterministically
// through the real implementation, since it requires the mtime updater to fail
// past the stale threshold. mock.module needs --experimental-test-module-mocks
// (see the test script) and must precede importing the module under test.

interface LockOptions {
  onCompromised?: (err: Error) => void;
}

const lockControl = {
  onAcquire: undefined as ((options: LockOptions) => void) | undefined,
  release: undefined as (() => Promise<void>) | undefined,
};

mock.module("proper-lockfile", {
  namedExports: {
    lock: async (_file: string, options?: LockOptions) => {
      lockControl.onAcquire?.(options ?? {});
      return lockControl.release ?? (async () => {});
    },
  },
});

const { refreshKimiAuthToken } = await import("../src/oauth.ts");

const PROVIDER_ID = "kimi-coding";

function withTempAuthFile(
  credential: Record<string, unknown>,
  kimiCredential?: Record<string, unknown>,
) {
  const dir = mkdtempSync(join(tmpdir(), "pi-kimi-auth-lock-"));
  const kimiHome = join(dir, "kimi-code");
  const kimiCredentialPath = join(kimiHome, "credentials", "kimi-code.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify(credential ? { [PROVIDER_ID]: credential } : {}),
    "utf8",
  );
  if (kimiCredential) {
    mkdirSync(join(kimiHome, "credentials"), { recursive: true });
    writeFileSync(kimiCredentialPath, JSON.stringify(kimiCredential), "utf8");
  }
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.KIMI_CODE_HOME = kimiHome;
  process.env.KIMI_SHARE_DIR = join(dir, "no-legacy-credentials");
  return {
    readCredential() {
      return JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))[PROVIDER_ID];
    },
    readKimiCredential() {
      return JSON.parse(readFileSync(kimiCredentialPath, "utf8"));
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.KIMI_CODE_HOME;
      delete process.env.KIMI_SHARE_DIR;
    },
  };
}

const staleCredential = () => ({
  type: "oauth",
  access: "stale-access",
  refresh: "refresh-1",
  expires: Date.now() - 1,
});

let realFetch: typeof fetch;

afterEach(() => {
  lockControl.onAcquire = undefined;
  lockControl.release = undefined;
  if (realFetch) globalThis.fetch = realFetch;
});

describe("refreshKimiAuthToken lock safety", () => {
  it("refuses to persist when the auth.json lock is compromised", async () => {
    lockControl.onAcquire = (options) => options.onCompromised?.(new Error("lock compromised"));
    const auth = withTempAuthFile(staleCredential());
    let fetchCalled = false;
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("must not reach the refresh endpoint");
    }) as typeof fetch;

    try {
      // Without a recorded onCompromised, proper-lockfile's default handler
      // rethrows inside its updater callback and crashes the process.
      assert.equal(await refreshKimiAuthToken("stale-access"), null);
      assert.equal(fetchCalled, false);
      assert.equal(auth.readCredential().refresh, "refresh-1");
    } finally {
      auth.cleanup();
    }
  });

  it("does not write the kimi-code sidecar when the lock breaks mid-refresh", async () => {
    // No pi credential on disk: the kimi-code-only fallback awaits the token
    // endpoint and then writes the sidecar. If the lock is compromised during
    // that await, another process may already hold the rotated token.
    let compromise: ((err: Error) => void) | undefined;
    lockControl.onAcquire = (options) => {
      compromise = options.onCompromised;
    };
    const auth = withTempAuthFile(null as unknown as Record<string, unknown>, {
      access_token: "stale-access",
      refresh_token: "refresh-1",
      expires_at: Math.floor((Date.now() - 1000) / 1000),
    });
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      compromise?.(new Error("lock compromised"));
      return new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "refresh-2",
          expires_in: 900,
          scope: "kimi-code",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      assert.equal(await refreshKimiAuthToken("stale-access"), null);
      assert.equal(auth.readKimiCredential().refresh_token, "refresh-1");
    } finally {
      auth.cleanup();
    }
  });

  it("returns the refreshed token even when releasing the lock fails", async () => {
    lockControl.release = async () => {
      throw new Error("unlock failed");
    };
    const auth = withTempAuthFile(staleCredential());
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "refresh-2",
          expires_in: 900,
          scope: "kimi-code",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      assert.equal(await refreshKimiAuthToken("stale-access"), "fresh-access");
      assert.equal(auth.readCredential().refresh, "refresh-2");
    } finally {
      auth.cleanup();
    }
  });
});
