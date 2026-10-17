// The Connector interface: one shape for everything a business can connect (Google products on our own OAuth app, long-tail
// tools through Composio). A connector knows how to start a connection, finish it, say how it stands, check its health and
// forget it. It never prints or returns a secret; the sealed store (src/connectors/google/store.ts) holds those per business.
// Words for owners follow docs/owner-words.md: no "scope", "token" or "API" in anything a person reads.
import type { CapabilityKey } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import type { SealedVault } from "../connectors/google/store.js";

export type ConnectionGroup = "google" | "meta" | "commerce" | "customers" | "team";
export const GROUP_LABELS: Record<ConnectionGroup, string> = {
  google: "Google", meta: "Meta", commerce: "Commerce and money", customers: "Customers", team: "Team",
};
export const GROUP_ORDER: ConnectionGroup[] = ["google", "meta", "commerce", "customers", "team"];

/** Three states an owner reads. "not_connected" also covers a connection that was removed. */
export type ConnectionState = "not_connected" | "connected" | "needs_attention";

export interface MissingSetting { setting: string; words: string }

/** Whether this server can offer the connection at all: not ok names what the founder still has to set up. */
export interface Availability {
  ok: boolean;
  /** Plain words for an owner ("Connecting Google Calendar isn't switched on yet..."). Empty when ok. */
  message: string;
  /** For the founder: the environment settings that are missing. Never shown to an owner. */
  missing: MissingSetting[];
  /** Planned but not built: the page says "coming soon". */
  soon?: boolean;
}

export interface ConnectorInfo {
  id: string;                         // lowercase-with-dashes; also the name its sealed record is stored under
  name: string;                       // "Google Calendar"
  group: ConnectionGroup;
  provider: "google" | "composio";
  /** One line, owner's words: what the team will do with it. */
  blurb: string;
  /** What we read, and what we do (only after the owner's OK), in owner's words. */
  reads: string[];
  acts: string[];
  /** The capability-ladder keys this connection feeds. */
  capabilities: CapabilityKey[];
}

export interface ConnectionStatus {
  state: ConnectionState;
  /** One plain sentence for the owner. */
  message: string;
  lastReadAt?: string;                // ISO time of the newest successful read
  /** Set when the connection needs the owner to pick one of several (a website, an analytics property, an ads account). */
  choose?: { label: string; options: string[] };
  /** What is chosen now (the website, the property). */
  selected?: string;
  /** The owner has allowed more than the basics (e.g. reading the inbox). */
  extras?: string[];
}

export interface ConnectionHealth { ok: boolean; message: string }

/** One box on the "paste your key" sheet. `secret`: a password-type box. Never carries a value. */
export interface KeyField { name: string; label: string; help?: string; secret: boolean }
/** A tool with no sign-in page: the owner pastes its key on our sheet instead. `hint` is where the key is found. */
export interface KeyForm { tool: string; fields: KeyField[]; hint?: string }

/** Where the owner goes to say yes. With `key`, the web app opens the paste-your-key sheet instead (and `url` is our own
 *  Connections page with that tool picked, for a link opened from Discord). */
export interface ConnectStart { url: string; key?: KeyForm }

export type CompleteResult = "connected" | "choose" | "denied" | "problem";
export interface CompleteOutcome { result: CompleteResult; reason?: string }

export interface ConnectorCtx {
  tenant: string;
  businessId?: string;
  graph: () => Promise<GraphHandle>;
  now: () => number;
  vault: SealedVault<unknown>;
  /** A signed single-use `state` for the owner's trip to the provider, remembering `data` (a PKCE verifier) on the server. */
  beginAuth: (data?: Record<string, string>) => string;
  /** Records one call in this business's audit log. Never pass a secret. */
  audit: (op: string, ok: boolean, detail?: string) => Promise<void>;
  webBaseUrl: string;
}

export interface Connector {
  info: ConnectorInfo;
  availability(): Availability;
  status(ctx: ConnectorCtx): Promise<ConnectionStatus>;
  /** Starts a connection. `options` are the owner's choices (e.g. `{ inbox: "1" }` to also allow reading the inbox). */
  connect(ctx: ConnectorCtx, options?: Record<string, string>): Promise<ConnectStart>;
  /** Finishes it when the provider sends the owner back. `data` is what beginAuth remembered. */
  complete(ctx: ConnectorCtx, params: Record<string, string>, data: Record<string, string>): Promise<CompleteOutcome>;
  select?(ctx: ConnectorCtx, value: string): Promise<void>;
  /** For a tool connected with a key the owner pastes (see KeyForm): passes it on and keeps only the connection's id. The values
   *  are never stored, logged or returned. Answers the line the owner reads ("Higgsfield connected: 1,200 credits left."). */
  connectWithKey?(ctx: ConnectorCtx, values: Record<string, string>): Promise<{ message: string }>;
  /** Forgets the connection and asks the provider to revoke it. */
  disconnect(ctx: ConnectorCtx): Promise<void>;
  health(ctx: ConnectorCtx): Promise<ConnectionHealth>;
  /** The daily read, for connectors that feed numbers into the brain. */
  pull?(ctx: ConnectorCtx): Promise<{ ok: boolean; message: string }>;
}

// Thrown by a call that needs a connection the business does not have, or that stopped working. `words` is for the owner.
export class NotConnectedError extends Error {
  override name = "NotConnectedError";
  constructor(readonly connector: string, readonly connectorName: string, readonly words: string) {
    super(words);
  }
}
export class NeedsAttentionError extends Error {
  override name = "NeedsAttentionError";
  constructor(readonly connector: string, readonly connectorName: string, readonly words: string) {
    super(words);
  }
}
export class NotConfiguredError extends Error {
  override name = "NotConfiguredError";
  constructor(readonly connector: string, readonly availability: Availability) {
    super(availability.message);
  }
}
/** Connecting did not work, for a reason the owner can read and often fix ("Higgsfield needs your API key"). `status` is the
 *  HTTP status the page gets: 400 for what to do differently, 422 for a key the tool did not accept. */
export class ConnectProblem extends Error {
  override name = "ConnectProblem";
  constructor(readonly connector: string, message: string, readonly status: 400 | 422 = 400) {
    super(message);
  }
}
/** The grant is there, but the owner did not allow this particular thing (booking, reading the inbox). */
export class NotAllowedError extends Error {
  override name = "NotAllowedError";
  constructor(readonly connector: string, readonly connectorName: string, readonly words: string) {
    super(words);
  }
}

export interface ConnectionView {
  id: string;
  name: string;
  /** The tool's logo (Composio's logo address for its toolkit); the page falls back to a letter when it can't load. */
  logo?: string;
  /** Whether it can run in the daily read and what it can do: "Read only" or "Read and act" (acting always waits for the owner's OK). */
  access: "read" | "read_act";
  group: ConnectionGroup;
  blurb: string;
  reads: string[];
  acts: string[];
  state: ConnectionState;
  message: string;
  available: boolean;
  /** Owner's words for why it can't be connected yet ("coming soon", "isn't switched on yet"). */
  unavailableWords?: string;
  soon?: boolean;
  lastReadAt?: string;
  choose?: { label: string; options: string[] };
  selected?: string;
  extras?: string[];
}
