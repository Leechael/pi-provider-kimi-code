import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { lock as acquireFileLock } from "proper-lockfile";

import { PROVIDER_ID } from "../src/constants.ts";

const execFileAsync = promisify(execFile);

interface KimiLockFixture {
  dir: string;
  piAgentDir: string;
  kimiHome: string;
  legacyDir: string;
  tokenUrl: string;
  cleanup(): void;
}

function fixture(withPiCredential: boolean): KimiLockFixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-kimi-code-lock-"));
  const piAgentDir = join(dir, "pi-agent");
  const kimiHome = join(dir, "kimi-code");
  const legacyDir = join(dir, "no-legacy-credentials");
  const tokenUrl = join(dir, "token-state");
  writeFileSync(tokenUrl, "0", "utf8");
  if (withPiCredential) {
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(
      join(piAgentDir, "auth.json"),
      JSON.stringify({
        [PROVIDER_ID]: {
          type: "oauth",
          access: "stale-access",
          refresh: "refresh-0",
          expires: Date.now() - 1,
        },
      }),
      "utf8",
    );
  }
  mkdirSync(join(kimiHome, "credentials"), { recursive: true });
  writeFileSync(
    join(kimiHome, "credentials", "kimi-code.json"),
    JSON.stringify({
      access_token: "stale-access",
      refresh_token: "refresh-0",
      expires_at: Math.floor(Date.now() / 1000) - 1,
      scope: "",
      token_type: "Bearer",
    }),
    "utf8",
  );
  return {
    dir,
    piAgentDir,
    kimiHome,
    legacyDir,
    tokenUrl,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function childEnv(f: KimiLockFixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: f.piAgentDir,
    KIMI_CODE_HOME: f.kimiHome,
    KIMI_SHARE_DIR: f.legacyDir,
    KIMI_OAUTH_HOST: f.tokenUrl,
    KIMI_BASE_URL: "https://disabled.invalid",
    KIMI_CODE_BASE_URL: "https://disabled.invalid",
    KIMI_E2E_FAKE_KIMI_LOCK: "1",
    KIMI_E2E_FAKE_KIMI_LOCK_PATH: f.tokenUrl,
    KIMI_E2E_FAKE_KIMI_LOCK_DELAY_MS: "500",
  };
}

async function runForcedRefresh(f: KimiLockFixture): Promise<void> {
  await execFileAsync(process.execPath, ["--input-type=module", "-e", CHILD_PROGRAM], {
    env: childEnv(f),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

const CHILD_PROGRAM = `
const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
const { dirname, join } = await import("node:path");
const { refreshKimiAuthToken } = await import(${JSON.stringify(new URL("../src/oauth.ts", import.meta.url).href)});
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/models")) {
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const statePath = process.env.KIMI_E2E_FAKE_KIMI_LOCK_PATH;
  const delayMs = Number(process.env.KIMI_E2E_FAKE_KIMI_LOCK_DELAY_MS ?? "0");
  const attempt = Number(readFileSync(statePath, "utf8")) + 1;
  writeFileSync(statePath, String(attempt), "utf8");
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (attempt > 1) {
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  }
  return new Response(
    JSON.stringify({
      access_token: "access-" + attempt,
      refresh_token: "refresh-" + attempt,
      expires_in: 900,
      scope: "kimi-code",
      token_type: "Bearer",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
if (process.env.KIMI_E2E_PROACTIVE_REFRESH === "1") {
  const { refreshKimiCodeToken } = await import(${JSON.stringify(new URL("../src/oauth.ts", import.meta.url).href)});
  const refreshed = await refreshKimiCodeToken({
    access: "stale-access",
    refresh: "refresh-0",
    expires: Date.now() - 1,
  });
  if (!refreshed.access) throw new Error("refreshKimiCodeToken returned no access token");
} else {
  const token = await refreshKimiAuthToken("stale-access");
  if (token === null) {
    throw new Error("refreshKimiAuthToken returned null");
  }
}
`;

describe("Kimi Code credential locking", () => {
  it("serializes concurrent Pi processes on Kimi Code's native OAuth lock", async () => {
    const f = fixture(false);

    try {
      await Promise.all([runForcedRefresh(f), runForcedRefresh(f)]);

      assert.equal(readFileSync(f.tokenUrl, "utf8"), "1");
      const credential = JSON.parse(
        readFileSync(join(f.kimiHome, "credentials", "kimi-code.json"), "utf8"),
      );
      assert.equal(credential.refresh_token, "refresh-1");
      assert.equal(credential.access_token, "access-1");
      assert.equal(credential.expires_at > Math.floor(Date.now() / 1000), true);
    } finally {
      f.cleanup();
    }
  });

  it("serializes concurrent proactive refreshes on Kimi Code's native OAuth lock", async () => {
    const f = fixture(false);
    const env = childEnv(f);
    env.KIMI_E2E_PROACTIVE_REFRESH = "1";

    try {
      await Promise.all([
        execFileAsync(process.execPath, ["--input-type=module", "-e", CHILD_PROGRAM], {
          env,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        }),
        execFileAsync(process.execPath, ["--input-type=module", "-e", CHILD_PROGRAM], {
          env,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        }),
      ]);

      assert.equal(readFileSync(f.tokenUrl, "utf8"), "1");
      const credential = JSON.parse(
        readFileSync(join(f.kimiHome, "credentials", "kimi-code.json"), "utf8"),
      );
      assert.equal(credential.refresh_token, "refresh-1");
      assert.equal(credential.access_token, "access-1");
      assert.equal(credential.expires_at > Math.floor(Date.now() / 1000), true);
    } finally {
      f.cleanup();
    }
  });

  it("persists the Kimi-locked credential to Pi's auth store", async () => {
    const f = fixture(true);

    try {
      await Promise.all([runForcedRefresh(f), runForcedRefresh(f)]);

      assert.equal(readFileSync(f.tokenUrl, "utf8"), "1");
      const piCredential = JSON.parse(readFileSync(join(f.piAgentDir, "auth.json"), "utf8"))[
        PROVIDER_ID
      ];
      assert.equal(piCredential.access, "access-1");
      assert.equal(piCredential.refresh, "refresh-1");
      const kimiCredential = JSON.parse(
        readFileSync(join(f.kimiHome, "credentials", "kimi-code.json"), "utf8"),
      );
      assert.equal(kimiCredential.refresh_token, "refresh-1");
      assert.equal(kimiCredential.expires_at > Math.floor(Date.now() / 1000), true);
    } finally {
      f.cleanup();
    }
  });

  it("does not leave a stale sidecar behind after the refreshed credential", async () => {
    const f = fixture(false);
    const env = childEnv(f);
    env.KIMI_DISABLE_OAUTH_LOCK = "1";

    try {
      await execFileAsync(process.execPath, ["--input-type=module", "-e", CHILD_PROGRAM], {
        env,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });

      const target = join(f.kimiHome, "oauth", "kimi-code");
      mkdirSync(join(f.kimiHome, "oauth"), { recursive: true });
      writeFileSync(target, "", { encoding: "utf8", flag: "a" });
      const release = await acquireFileLock(target, { realpath: false, stale: 5_000 });
      const staleCredential = {
        access_token: "stale-access",
        refresh_token: "stale-refresh",
        expires_at: Math.floor(Date.now() / 1000) - 1,
        scope: "",
        token_type: "Bearer",
      };
      writeFileSync(
        join(f.kimiHome, "credentials", "kimi-code.json"),
        JSON.stringify(staleCredential),
        "utf8",
      );
      await release();

      process.env.PI_CODING_AGENT_DIR = f.piAgentDir;
      process.env.KIMI_CODE_HOME = f.kimiHome;
      process.env.KIMI_SHARE_DIR = f.legacyDir;
      process.env.KIMI_OAUTH_HOST = f.tokenUrl;
      process.env.KIMI_DISABLE_OAUTH_LOCK = "1";
      const { refreshKimiAuthToken } = await import("../src/oauth.ts");
      globalThis.fetch = async () => {
        const attempt = Number(readFileSync(f.tokenUrl, "utf8")) + 1;
        writeFileSync(f.tokenUrl, String(attempt), "utf8");
        return new Response(
          JSON.stringify({
            access_token: `access-${attempt}`,
            refresh_token: `refresh-${attempt}`,
            expires_in: 900,
            scope: "kimi-code",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const recovered = await refreshKimiAuthToken("stale-access");
      assert.equal(recovered, "access-2");
      assert.equal(readFileSync(f.tokenUrl, "utf8"), "2");
      const kimiCredential = JSON.parse(
        readFileSync(join(f.kimiHome, "credentials", "kimi-code.json"), "utf8"),
      );
      assert.equal(kimiCredential.access_token, "access-2");
      assert.equal(kimiCredential.refresh_token, "refresh-2");
      assert.equal(kimiCredential.expires_at > Math.floor(Date.now() / 1000), true);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.KIMI_CODE_HOME;
      delete process.env.KIMI_SHARE_DIR;
      delete process.env.KIMI_OAUTH_HOST;
      delete process.env.KIMI_DISABLE_OAUTH_LOCK;
      f.cleanup();
    }
  });
});
