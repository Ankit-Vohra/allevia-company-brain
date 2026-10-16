// A fake Composio: makes connect links, holds connected accounts per user id, runs scripted tools, records every call.
import type { ComposioAccount, ComposioClient } from "../../src/connections/composio.js";

export class FakeComposio implements ComposioClient {
  calls: Array<{ op: string; args: unknown }> = [];
  accounts = new Map<string, ComposioAccount>();
  results = new Map<string, unknown>();           // tool slug -> data
  private n = 0;
  async authConfigId(toolkit: string): Promise<string> { this.calls.push({ op: "authConfigId", args: toolkit }); return `ac_${toolkit}`; }
  async link(o: { authConfigId: string; userId: string; callbackUrl: string }) {
    this.calls.push({ op: "link", args: o });
    const accountId = `ca_${++this.n}`;
    const toolkit = o.authConfigId.replace(/^ac_/, "");
    this.accounts.set(accountId, { id: accountId, status: "INITIATED", userId: o.userId, toolkit });
    return { redirectUrl: `https://composio.example/connect/${accountId}`, accountId };
  }
  activate(id: string): void { const a = this.accounts.get(id)!; this.accounts.set(id, { ...a, status: "ACTIVE" }); }
  async account(id: string): Promise<ComposioAccount | null> { this.calls.push({ op: "account", args: id }); return this.accounts.get(id) ?? null; }
  async deleteAccount(id: string): Promise<void> { this.calls.push({ op: "deleteAccount", args: id }); this.accounts.delete(id); }
  async execute(o: { tool: string; accountId: string; userId: string; args: Record<string, unknown> }) {
    this.calls.push({ op: "execute", args: o });
    const a = this.accounts.get(o.accountId);
    if (!a || a.userId !== o.userId) return { ok: false, data: null, error: "no such account" };
    return { ok: true, data: this.results.get(o.tool) ?? null };
  }
}
