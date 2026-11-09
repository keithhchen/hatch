import { LarkChannel } from "./larkChannel.js";
import { MessengerChannel } from "./messengerChannel.js";
import type { ChannelAdapter, ChannelKind } from "./types.js";
import { WeChatKfChannel } from "./wechatKfChannel.js";
import { WhatsAppChannel } from "./whatsappChannel.js";
import { WeComBotChannel } from "./wecomBotChannel.js";

/**
 * Port to a platform where each Expert brings their own app: what they type in Studio, and how it becomes an adapter.
 * The credentials are sealed as built here and opened by `build` for the hub, so the form is the only place that knows them.
 */
type FormFields = {
  /** Request field -> credential key. */
  fields: Array<{ field: string; key: string; required?: true }>;
  /** Credentials the platform fixes, such as which domain. */
  fixed?: Record<string, unknown>;
};
export type OwnAppForm = FormFields & {
  build(credentials: any, scope: string): ChannelAdapter;
  /** Proves the credentials work before they are saved. Returns what to keep from the proof. */
  probe?(adapter: any): Promise<Record<string, unknown> | void>;
};
/** One shared app serves many tenants: what the Expert types is their tenant's token, and `tenant` names the credential that is the tenant's id. */
export type TenantForm = FormFields & {
  tenant: string;
  probe?(adapter: any, credentials: any): Promise<Record<string, unknown> | void>;
};
export type CredentialForm = OwnAppForm | TenantForm;
export const isTenantForm = (form: CredentialForm): form is TenantForm => "tenant" in form;

export function readCredentials(form: FormFields, body: Record<string, unknown>): Record<string, unknown> | undefined {
  const credentials: Record<string, unknown> = { ...form.fixed };
  for (const { field, key, required } of form.fields) {
    const value = typeof body[field] === "string" ? (body[field] as string).trim() : "";
    if (value) credentials[key] = value; else if (required) return undefined;
  }
  return credentials;
}

const lark = (domain: "lark" | "feishu"): OwnAppForm => ({
  fields: [
    { field: "app_id", key: "appId", required: true }, { field: "app_secret", key: "appSecret", required: true },
    { field: "verification_token", key: "verificationToken", required: true }, { field: "encrypt_key", key: "encryptKey" },
  ],
  fixed: { domain },
  build: (credentials, scope) => new LarkChannel(credentials, scope),
  probe: async (adapter: LarkChannel) => ({ botOpenId: await adapter.probe() }),
});

export const CREDENTIAL_FORMS: Partial<Record<ChannelKind, CredentialForm>> = {
  // Slack and Instagram install by OAuth, not by form: see `ChannelAdapter.install`.
  whatsapp: { tenant: "wabaId", fields: [{ field: "waba_id", key: "wabaId", required: true }, { field: "access_token", key: "token", required: true }], probe: (adapter: WhatsAppChannel, credentials) => adapter.probe(credentials.wabaId, credentials.token) },
  messenger: { tenant: "pageId", fields: [{ field: "page_id", key: "pageId", required: true }, { field: "access_token", key: "token", required: true }], probe: (adapter: MessengerChannel, credentials) => adapter.probe(credentials.pageId, credentials.token) },
  lark: lark("lark"),
  feishu: lark("feishu"),
  wecom: {
    fields: [{ field: "token", key: "token", required: true }, { field: "encoding_aes_key", key: "encodingAesKey", required: true }],
    build: (credentials, scope) => new WeComBotChannel(credentials, scope),
  },
  wechatkf: {
    fields: [
      { field: "corp_id", key: "corpId", required: true }, { field: "secret", key: "secret", required: true },
      { field: "token", key: "token", required: true }, { field: "encoding_aes_key", key: "encodingAesKey", required: true },
    ],
    build: (credentials, scope) => new WeChatKfChannel(credentials, scope),
    probe: (adapter: WeChatKfChannel) => adapter.probe(),
  },
};
