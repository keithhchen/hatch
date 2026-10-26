import { Observable } from "../observable.js";
import { DEFAULT_PERMISSION_POLICY, normalizePermissionPolicy } from "./local-tools.js";

export function normalizeWorkspaceGrant(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const grantId = typeof value.grant_id === "string" ? value.grant_id.trim() : "";
  const displayPath = typeof value.display_path === "string" ? value.display_path.trim() : "";
  return grantId && displayPath ? Object.freeze({ grant_id: grantId, display_path: displayPath }) : null;
}

/**
 * The folder one Conversation lets its Agent work in, and the change policy
 * (native task settings, keyed by conversation). A grant is an opaque native
 * handle (security-scoped bookmark on macOS); a saved one is never trusted
 * until `ensure_workspace` re-validates it. Without a grant the conversation
 * cannot send (the Desktop folder gate).
 *
 * status: "restoring" | "none" | "granted" | "stale"
 */
export class WorkspaceAccess extends Observable {
  constructor(invoke, conversationId) {
    super({ status: "restoring", grant: null, permission: DEFAULT_PERMISSION_POLICY, error: null });
    this.invoke = invoke;
    this.conversationId = conversationId;
  }

  get grant() {
    return this.state.status === "granted" ? this.state.grant : null;
  }

  get permission() {
    return this.state.permission;
  }

  /**
   * Restore this conversation's saved settings. A conversation that has no
   * folder yet takes `inherited` (the folder it was started with) and keeps it.
   */
  async restore(inherited = {}) {
    const stored = await this.invoke("read_task_settings", { taskId: this.conversationId }).catch(() => null);
    const own = normalizeWorkspaceGrant(stored?.workspaceGrant);
    const saved = own ?? normalizeWorkspaceGrant(inherited.workspaceGrant);
    const permission = normalizePermissionPolicy(own ? stored.permissionMode : inherited.permissionMode ?? stored?.permissionMode);
    if (!saved) {
      this.setState({ status: "none", grant: null, permission });
      return;
    }
    try {
      const grant = await this.validate(saved.grant_id);
      this.setState({ status: "granted", grant, permission, error: null });
      if (!own) this.persist();
    } catch (error) {
      this.setState({ status: "stale", grant: saved, permission, error });
    }
  }

  async validate(grantId) {
    const grant = normalizeWorkspaceGrant(await this.invoke("ensure_workspace", { workspaceGrantId: grantId }));
    if (!grant || grant.grant_id !== grantId) throw new Error("workspace_grant_invalid: The folder grant could not be verified");
    return grant;
  }

  /** Ask the OS folder picker; a cancelled picker changes nothing. */
  async choose() {
    const picked = normalizeWorkspaceGrant(await this.invoke("pick_workspace_folder"));
    if (picked) await this.adopt(picked);
  }

  /** Use a grant the native layer just issued (picker or folder drop). */
  async adopt(candidate) {
    const grant = await this.validate(normalizeWorkspaceGrant(candidate)?.grant_id ?? "");
    this.setState({ status: "granted", grant, error: null });
    this.persist();
  }

  setPermission(policy) {
    this.setState({ permission: normalizePermissionPolicy(policy) });
    this.persist();
  }

  /** Revoke the native grant for this conversation's folder. */
  async revoke() {
    const grant = this.state.grant;
    if (grant) await this.invoke("revoke_workspace_grant", { workspaceGrantId: grant.grant_id });
    this.setState({ status: "none", grant: null, error: null });
    this.persist();
  }

  persist() {
    const { grant, permission, status } = this.state;
    void this.invoke("patch_window_settings", {
      patch: { context: { conversationId: this.conversationId, workspaceGrant: status === "granted" ? grant : null, permissionMode: permission } }
    }).catch(() => {});
  }
}
