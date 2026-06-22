import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isKimiProjectConfigApproved } from "../src/project-trust.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

async function withAgentDir<T>(agentDir: string, fn: () => T | Promise<T>): Promise<T> {
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn();
  } finally {
    if (originalDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalDir;
    }
  }
}

describe("isKimiProjectConfigApproved", () => {
  it("keeps trusted behavior when Pi has no project trust API", async () => {
    assert.equal(await isKimiProjectConfigApproved({}, tempDir("kimi-project-trust-cwd")), true);
  });

  it("blocks project config when the current Pi session is untrusted", async () => {
    assert.equal(
      await isKimiProjectConfigApproved(
        { isProjectTrusted: () => false },
        tempDir("kimi-project-trust-cwd"),
      ),
      false,
    );
  });

  it("requires saved Pi project trust when the trust store API is available", async () => {
    const piExports = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
    const ProjectTrustStore = piExports.ProjectTrustStore as
      | (new (agentDir: string) => { set(cwd: string, trusted: boolean): void })
      | undefined;
    if (!ProjectTrustStore) return;

    const cwd = tempDir("kimi-project-trust-cwd");
    const agentDir = tempDir("kimi-project-trust-agent");
    const ctx = { isProjectTrusted: () => true };

    await withAgentDir(agentDir, async () => {
      assert.equal(await isKimiProjectConfigApproved(ctx, cwd), false);

      new ProjectTrustStore(agentDir).set(cwd, true);
      assert.equal(await isKimiProjectConfigApproved(ctx, cwd), true);

      new ProjectTrustStore(agentDir).set(cwd, false);
      assert.equal(await isKimiProjectConfigApproved(ctx, cwd), false);
    });
  });

  it("keeps Pi 0.78 fallback when the trust store API is unavailable", async () => {
    const piExports = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
    if (piExports.ProjectTrustStore) return;

    assert.equal(
      await isKimiProjectConfigApproved(
        { isProjectTrusted: () => true },
        tempDir("kimi-project-trust-cwd"),
      ),
      true,
    );
  });
});
