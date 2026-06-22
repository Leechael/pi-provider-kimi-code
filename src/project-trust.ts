export async function isKimiProjectConfigApproved(ctx: unknown, cwd: string): Promise<boolean> {
  const check = (ctx as { isProjectTrusted?: () => boolean } | undefined)?.isProjectTrusted;
  if (typeof check !== "function") return true;
  if (!check.call(ctx)) return false;

  const mod = (await import("@earendil-works/pi-coding-agent")) as unknown as {
    ProjectTrustStore?: new (agentDir: string) => { get(cwd: string): boolean | null };
    getAgentDir?: () => string;
  };
  if (!mod.ProjectTrustStore || !mod.getAgentDir) return true;

  try {
    return new mod.ProjectTrustStore(mod.getAgentDir()).get(cwd) === true;
  } catch {
    return false;
  }
}
