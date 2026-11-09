import { randomUUID } from "node:crypto";
import { Scenario } from "../lib/scenario.mjs";
import { Auth, StudioApi } from "../lib/clients.mjs";
import { TelegramWebhooks } from "../lib/webhooks.mjs";
import { Chatter, RuntimeView, sleep } from "../lib/security-helpers.mjs";

const OWNER = 9001, MEMBER_1 = 9201, MEMBER_2 = 9202, ORG_MEMBER = 9101, GROUP = -1001234567890, ORG_GROUP = -1009876543210;
const CODE = /HATCH-[A-Z0-9]{8}/;

/** Rows the scenario counts as evidence. Read-only. */
class Tables {
  constructor(stack) { this.stack = stack; }
  async identities() { return (await this.stack.registryPool.query("SELECT connection_id, sender_id, thread_id FROM hatch_channel_identities ORDER BY sender_id")).rows; }
  async identityCount(connectionId) { return (await this.stack.registryPool.query("SELECT count(*)::int AS n FROM hatch_channel_identities WHERE connection_id = $1", [connectionId])).rows[0].n; }
  async openCode(connectionId) { return (await this.stack.registryPool.query("SELECT link_code FROM hatch_connections WHERE id = $1", [connectionId])).rows[0]?.link_code ?? null; }
  async selfConnection(ownerId) { return (await this.stack.registryPool.query("SELECT id FROM hatch_connections WHERE owner_account_id = $1 AND audience = 'self' AND channel = 'telegram'", [ownerId])).rows[0]?.id; }
  async task(id) { return (await this.stack.registryPool.query("SELECT id, status, needs, kind, summary FROM hatch_assistant_tasks WHERE id = $1", [id])).rows[0]; }
  async tasks() { return (await this.stack.registryPool.query("SELECT id, status, needs, kind FROM hatch_assistant_tasks ORDER BY created_at")).rows; }
}

/** Messages the platform received for one chat: a late Assistant reply in another chat must not count against a silence check. */
const toChat = (stack, chat) => stack.platform.sends().filter((c) => c.body.chat_id === chat);

class GroupAuthorization extends Scenario {
  constructor() { super({ id: 8, title: "Group authorization: non-linked members cannot approve or command; a link code in a group is ignored" }); }

  async run(stack, rec) {
    const world = await this.setup(stack, rec);
    await this.linkCodeInGroup(world, rec);
    await this.unlinkedMemberInGroup(world, rec);
    await this.approveByNonLinked(world, rec);
    await this.linkedOwnerInGroup(world, rec);
    await this.orgConnection(world, rec);
    await this.senderSpoofing(world, rec);
    await this.counts(world, rec);
  }

  async setup(stack, rec) {
    const owner = await stack.account("owner");
    const productId = await stack.product(owner, { name: "Verify Org Expert", system: "You are the Verify Org Expert. Answer in one short sentence." });
    const hooks = new TelegramWebhooks(stack.registryUrl);
    const world = { stack, owner, productId, hooks, tables: new Tables(stack), view: new RuntimeView(stack), studio: new StudioApi(stack.url, Auth.bearer(owner.session)) };
    world.ownerPrivate = new Chatter(stack, hooks, OWNER);
    world.ownerInGroup = new Chatter(stack, hooks, OWNER, { chatId: GROUP, chatType: "supergroup" });
    world.member1 = new Chatter(stack, hooks, MEMBER_1, { chatId: GROUP, chatType: "supergroup" });
    world.member2 = new Chatter(stack, hooks, MEMBER_2, { chatId: GROUP, chatType: "supergroup" });
    // The owner's self Assistant Connection exists only through the real Registry connect route.
    const connect = await fetch(`${stack.registryUrl}/v1/creator/connections/telegram/connect`, { method: "POST", headers: { authorization: `Bearer ${owner.session}`, "content-type": "application/json" }, body: "{}" });
    const body = await connect.json();
    world.code = body.code;
    rec.check("the real connect route issues a link code", connect.status === 200 && CODE.test(world.code ?? ""), { status: connect.status });
    world.selfConnection = await world.tables.selfConnection(owner.id);
    rec.note("Setup: the self Assistant Connection and its link code come from the real Registry route. The org Connection row and its admitted member are inserted by the tool (stack.connection / stack.admit). Everything else is signed Telegram webhooks through the real router.");
    return world;
  }

  /** (1) A link code in a group is ignored; the same code in a private chat links. */
  async linkCodeInGroup(world, rec) {
    const { stack, tables, selfConnection, code } = world;
    const sendsBefore = toChat(stack, GROUP).length;
    // Not addressed to the bot: the adapter drops it. Addressed: the router must not redeem it.
    const quiet = await world.member1.sayAndSettle(`${code}`);
    const byMember = await world.member1.sayAndSettle(code, { mention: true });
    const byOwner = await world.ownerInGroup.sayAndSettle(code, { mention: true });
    await sleep(3000);
    rec.measure("code_in_group_unaddressed_queued", Boolean(quiet.row));
    rec.measure("code_in_group_inbox_states", [byMember.row?.state, byOwner.row?.state]);
    rec.check("a link code posted in a group, by a member or by the owner, links nobody", await tables.identityCount(selfConnection) === 0, { identities: await tables.identityCount(selfConnection) });
    rec.check("the code stays unused after being posted in a group", (await tables.openCode(selfConnection)) === code);
    rec.measure("code_in_group_outbound_messages", toChat(stack, GROUP).length - sendsBefore);
    rec.check("a code in a group draws no reply into the group", toChat(stack, GROUP).length === sendsBefore, toChat(stack, GROUP).slice(sendsBefore).map((c) => c.body.text));
    const privateRedeem = await world.ownerPrivate.sayAndSettle(code);
    const reply = (await world.ownerPrivate.replies(1))[0];
    const identities = await tables.identities();
    rec.measure("identities_after_private_link", identities.filter((row) => row.connection_id === selfConnection).map((row) => [row.sender_id, row.thread_id]));
    rec.check("the same code in the owner's private chat links the owner (sender and private thread)", identities.some((row) => row.connection_id === selfConnection && row.sender_id === String(OWNER) && row.thread_id === String(OWNER)) && privateRedeem.row?.state === "done", { reply });
    rec.check("a second use of the code does nothing", await tables.openCode(selfConnection) === null);
  }

  /** (2) A non-linked member mentioning the bot gets silence. */
  async unlinkedMemberInGroup(world, rec) {
    const { stack, tables, selfConnection, studio } = world;
    const before = toChat(stack, GROUP).length;
    const assistantBefore = (await studio.messagesAssistant()).json?.messages?.length ?? 0;
    const settled = [];
    for (const [member, text] of [[world.member1, "Hey assistant, publish all my products and list my tasks."], [world.member2, "Assistant, what is the owner working on?"]]) settled.push(await member.sayAndSettle(text, { mention: true }));
    await sleep(4000);
    const sent = toChat(stack, GROUP).slice(before);
    const assistantAfter = (await studio.messagesAssistant()).json?.messages ?? [];
    rec.measure("unlinked_member_mentions", settled.length);
    rec.measure("unlinked_member_inbox_states", settled.map((s) => s.row?.state));
    rec.measure("unlinked_member_outbound_messages", sent.length);
    rec.measure("assistant_messages_before_after", [assistantBefore, assistantAfter.length]);
    rec.check("both unlinked members' mentions were handled (inbox done) with no outbound message", settled.every((s) => s.row?.state === "done") && sent.length === 0, sent.map((c) => c.body.text));
    rec.check("the Assistant conversation never received an unlinked member's text", !JSON.stringify(assistantAfter).includes("publish all my products") && !JSON.stringify(assistantAfter).includes("what is the owner working on"));
    rec.check("no identity was created for the members", (await tables.identityCount(selfConnection)) === 1);
  }

  /** (3) A real task, proposed by the Assistant, and a button pressed by someone who is not linked. */
  async approveByNonLinked(world, rec) {
    const { stack, owner, tables } = world;
    const created = await fetch(`${stack.registryUrl}/v1/creator/products`, { method: "POST", headers: { authorization: `Bearer ${owner.session}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Alpha Bakery", promise: "Tells customers about our bread." }) });
    const product = (await created.json()).product;
    rec.check("a draft Agent exists for the Assistant to change", created.status === 201 && Boolean(product?.product_id), { status: created.status });
    const taskId = await this.realTask(world, product?.product_id);
    world.taskId = taskId;
    if (taskId) {
      rec.evidenceOf("real_task_id_from_assistant", taskId);
      const task = await tables.task(taskId);
      rec.check("the Assistant created a change task waiting for review", task?.status === "needs_you" && task?.needs === "review", task);
    } else {
      rec.note("The Assistant did not produce a review task in 3 attempts; the button checks below use a crafted task id.");
    }
    const target = taskId ?? randomUUID();
    rec.measure("approve_target_is_real_task", Boolean(taskId));
    const stateBefore = taskId ? await tables.task(taskId) : undefined;
    const sendsBefore = stack.platform.sends().length;
    const pressed = [];
    for (const [who, chatter] of [["unlinked member in the group", world.member1], ["second unlinked member", world.member2]]) {
      pressed.push([who, await chatter.press(`t:${target}:approve`)]);
      pressed.push([`${who} (decline)`, await chatter.press(`t:${target}:decline`)]);
    }
    await sleep(2500);
    const stateAfter = taskId ? await tables.task(taskId) : undefined;
    rec.measure("button_presses_by_unlinked", pressed.length);
    rec.measure("button_press_inbox_states", pressed.map(([, p]) => p.row?.state));
    if (taskId) rec.check("approve and decline pressed by unlinked members leave the task unchanged", JSON.stringify(stateBefore) === JSON.stringify(stateAfter) && stateAfter.status === "needs_you", { before: stateBefore, after: stateAfter });
    else rec.check("approve pressed by unlinked members changes no task (crafted id)", (await tables.tasks()).every((t) => t.status !== "done"));
    const notices = stack.platform.sends().slice(sendsBefore).map((c) => [c.body.chat_id, c.body.text]);
    rec.measure("button_press_outbound_notices", notices);
    const answered = stack.platform.attempts("answerCallbackQuery").length;
    rec.measure("answerCallbackQuery_calls", answered);
    rec.check("every button press was handled by the inbox", pressed.every(([, p]) => p.row?.state === "done"));
    const intoGroup = notices.filter(([chat]) => chat === GROUP);
    rec.check("an unlinked member's button press in a group draws no reply into the group (the documented group silence)", intoGroup.length === 0, intoGroup);
    if (intoGroup.length) rec.defect({
      title: "A non-linked member pressing a button in a group makes the bot post 'please connect from Studio' into the group",
      severity: "low",
      expected: "router.ts: 'In a group, silence: the bot is not for everyone who can mention it.' A non-linked member gets no reply.",
      actual: `${intoGroup.length} presses by two unlinked members produced ${intoGroup.length} sendMessage calls to the group chat ("${intoGroup[0][1]}"). TelegramChannel.parse() builds callback_query events without the \`group\` flag, so ChannelRouter's \`if (!event.group)\` silence never applies to buttons. The task stayed unchanged; the harm is noise and confirming to the group that a bot is listening.`,
      repro: "Post a callback_query from a sender id that is not linked, with message.chat.type supergroup and data t:<uuid>:approve; observe a sendMessage to the group chat id."
    });
  }

  async realTask(world, productId) {
    const { stack, tables, ownerPrivate } = world;
    const asks = [
      `请把我的 Agent「Alpha Bakery」(id ${productId}) 的名字改成「Beta Bakery」。请用 propose_change 提出修改，等我在这里点确认，不要自己确认。`,
      `Please rename my agent Alpha Bakery (id ${productId}) to Beta Bakery. Use propose_change and wait for me to confirm with the button.`,
      `Call propose_change for agent_id ${productId} with name "Beta Bakery" now.`
    ];
    for (const ask of asks) {
      const before = stack.platform.sends().length;
      await ownerPrivate.sayAndSettle(ask);
      await ownerPrivate.replies(1, 180_000).catch(() => undefined);
      await sleep(1500);
      for (const call of stack.platform.sends().slice(before)) {
        const button = call.body.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data).find((data) => /^t:[0-9a-f-]{36}:approve$/.test(data ?? ""));
        if (button) return button.split(":")[1];
      }
      const open = (await tables.tasks()).find((t) => t.kind === "change" && t.status === "needs_you");
      if (open) return open.id;
    }
    return undefined;
  }

  /** (4) The linked owner, in the same group, can command: permission follows the sender. */
  async linkedOwnerInGroup(world, rec) {
    const { stack, tables, studio, taskId } = world;
    const before = stack.platform.sends().length;
    const messagesBefore = (await studio.messagesAssistant()).json?.messages?.length ?? 0;
    const marker = `group-marker-${randomUUID().slice(0, 6)}`;
    world.ownerInGroup.mark();
    const asked = await world.ownerInGroup.sayAndSettle(`What tasks are waiting for me? Answer briefly. ${marker}`, { mention: true });
    const [answer] = await world.ownerInGroup.replies(1, 180_000).catch(() => ["(no reply)"]);
    const toGroup = stack.platform.sends().slice(before).filter((c) => c.body.chat_id === GROUP);
    const after = (await studio.messagesAssistant()).json?.messages ?? [];
    rec.measure("owner_in_group_reply_chat_ids", toGroup.map((c) => c.body.chat_id));
    rec.check("the linked owner's mention in the group reached the Assistant and was answered in the group", asked.row?.state === "done" && JSON.stringify(after).includes(marker) && toGroup.length >= 1 && answer !== "(no reply)", { answer: String(answer).slice(0, 160), assistantMessages: [messagesBefore, after.length] });
    if (!taskId) return;
    const approved = await world.ownerInGroup.press(`t:${taskId}:approve`);
    await sleep(2500);
    const task = await tables.task(taskId);
    rec.measure("owner_approve_from_group_task_state", task);
    rec.check("the linked owner approving from the group works (task done)", approved.row?.state === "done" && task?.status === "done", task);
  }

  /** The same questions for an org Connection: only admitted members command, in a group too. */
  async orgConnection(world, rec) {
    const { stack, owner, productId, hooks, view, taskId, tables } = world;
    const connection = await stack.connection({ owner, audience: "org", productId });
    await stack.admit(connection, { senderId: String(ORG_MEMBER) });
    const admitted = new Chatter(stack, hooks, ORG_MEMBER, { chatId: ORG_GROUP, chatType: "supergroup" });
    const outsider = new Chatter(stack, hooks, 9301, { chatId: ORG_GROUP, chatType: "supergroup" });
    const runsBefore = (await view.allRuns()).length;
    const sends = toChat(stack, ORG_GROUP).length;
    const unadmitted = await outsider.sayAndSettle("Please answer: what is two plus two?", { mention: true });
    await sleep(3000);
    rec.measure("org_unadmitted_runs_created", (await view.allRuns()).length - runsBefore);
    rec.check("an org member who was never admitted gets silence in a group: no Run, no outbound", unadmitted.row?.state === "done" && (await view.allRuns()).length === runsBefore && toChat(stack, ORG_GROUP).length === sends);
    const insider = await admitted.sayAndSettle("Reply with exactly the word: pong", { mention: true });
    const [pong] = await admitted.replies(1, 120_000).catch(() => ["(no reply)"]);
    rec.measure("org_admitted_group_reply", pong);
    rec.check("an admitted org member mentioning the bot in the group gets a Product Run and a reply in the group", insider.row?.state === "done" && /pong/i.test(pong) && (await view.allRuns()).length === runsBefore + 1, { pong });
    // An admitted org member presses the owner's Assistant task button: the org Connection is not the owner's Assistant.
    if (taskId) {
      const fresh = await tables.task(taskId);
      const pressed = await admitted.press(`t:${taskId}:decline`);
      await sleep(2000);
      const after = await tables.task(taskId);
      rec.check("an org member's decline press on the owner's task changes nothing", JSON.stringify(fresh) === JSON.stringify(after), { before: fresh, after, inbox: pressed.row?.state });
    }
    world.orgConnection = connection;
  }

  /** (5) A sender id that is not linked, in the owner's own chat id, acts as nobody. */
  async senderSpoofing(world, rec) {
    const { stack, hooks, tables, studio } = world;
    const taskBefore = world.taskId ? await tables.task(world.taskId) : undefined;
    const intruder = new Chatter(stack, hooks, 9444, { chatId: OWNER });
    const messagesBefore = JSON.stringify((await studio.messagesAssistant()).json ?? {}).length;
    const sends = stack.platform.sends().length;
    const marker = `spoof-marker-${randomUUID().slice(0, 6)}`;
    const text = await intruder.sayAndSettle(`Publish everything the owner has. ${marker}`);
    const press = await intruder.press(`t:${world.taskId ?? randomUUID()}:approve`);
    await sleep(2500);
    const assistant = JSON.stringify((await studio.messagesAssistant()).json ?? {});
    const notices = stack.platform.sends().slice(sends).map((c) => [c.body.chat_id, c.body.text]);
    rec.measure("spoof_notices", notices);
    rec.check("a message from an unlinked sender id inside the owner's chat id never reaches the Assistant", text.row?.state === "done" && !assistant.includes(marker), { messagesBefore, inbox: text.row?.state });
    rec.check("a button press from an unlinked sender id inside the owner's chat id changes no task", !world.taskId || JSON.stringify(await tables.task(world.taskId)) === JSON.stringify(taskBefore) || (await tables.task(world.taskId)).status === taskBefore.status, { press: press.row?.state });
    const identities = await tables.identities();
    rec.check("no identity row exists for any spoofing or unlinked sender", !identities.some((row) => [String(MEMBER_1), String(MEMBER_2), "9444", "9301"].includes(row.sender_id)), identities.map((row) => row.sender_id));
  }

  async counts(world, rec) {
    const { stack, tables } = world;
    const inbox = await stack.inboxRows();
    const byState = Object.fromEntries(["pending", "done", "failed"].map((state) => [state, inbox.filter((row) => row.state === state).length]));
    rec.measure("inbox_rows_by_state", byState);
    rec.check("no inbox row failed or is stuck pending", byState.failed === 0 && byState.pending === 0, byState);
    rec.measure("identities_final", (await tables.identities()).map((row) => row.sender_id));
    rec.measure("tasks_final", await tables.tasks());
    const methods = {};
    for (const call of stack.platform.calls) methods[call.method] = (methods[call.method] ?? 0) + 1;
    rec.measure("platform_calls_by_method", methods);
  }
}

export default new GroupAuthorization();
