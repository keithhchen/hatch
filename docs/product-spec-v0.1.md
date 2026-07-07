# Hatch Product Spec v0.1

Status: product direction draft  
Audience: founders, product, engineering  
Primary goal: turn Hatch from a technical spike into a believable product prototype

## 1. One-Line Definition

Hatch is an AI-native App Store where creators distribute protected AI apps, users run those apps against their local filesystem, and the platform handles discovery, review, installation, licensing, and trust without ingesting user content.

## 2. Product Thesis

Current skills are commercially too thin. They can encode taste, workflow, and judgment, but they do not create enough control for the creator or enough trust for the user.

Hatch makes the skill thicker without turning it into a traditional app:

- The creator owns the runtime, system prompt, private skill logic, API surface, model choice, and token spend.
- The user owns the local filesystem, raw context, privacy mapping, and installed app state.
- The platform owns discovery, review, signed manifests, app identity, licensing, install flow, and update rails.

The important commercial inversion:

```text
Current skill world:
  User pays token provider.
  Creator distributes a mostly exposed recipe.

Hatch:
  User pays for the app.
  Creator pays token cost and protects the runtime.
  Platform takes distribution margin.
```

v0.1 does not implement payment, but the product must already feel like this model.

### 2.1 Creator Thesis

Hatch is infrastructure for one-person AI app companies.

The target creator is not a developer, not a software operator, and not necessarily a VC-backed founder. The target creator is a person with insight, taste, audience trust, and a repeatable method.

Examples:

- how to do business,
- how to improve oneself,
- how to get fit,
- how to create content and traffic,
- how to manage relationships,
- how to apply to schools or jobs,
- how to operate a niche professional workflow.

These creators often already have:

- content traffic,
- a trusted audience,
- a workflow, playbook, SOP, prompt pack, template, or course,
- proof that their method helps people.

Their problem is not that they lack ideas. Their problem is that the current software shapes force bad tradeoffs:

```text
Chat is too shallow.
  It can answer, but it cannot reliably act on local context, produce files, and create durable output.

Open skill is too exposed.
  It can encode the method, but distributing it exposes the playbook and makes charging difficult.

AI methods have no consumer app surface.
  A skill may contain the method, but small consumer users do not care about infrastructure. They care whether the chat experience is good and whether the method can run a complete workflow that produces an outcome.
```

Hatch offers the third path:

```text
Installable AI App
  deeper than chat,
  more protected than open skill,
  more productized than a bare skill.
```

Creator-side positioning:

```text
Hatch helps one-person creators turn their insight into protected AI apps, without becoming software companies.
```

The creator should focus on:

- the method,
- the judgment,
- the examples,
- the desired user context,
- the output the app should produce,
- the boundaries of what the app should not do.

Hatch should handle:

- consumer app shell,
- chat experience,
- local workspace,
- install flow,
- app review,
- updates,
- usage view,
- runtime connection,
- privacy trace,
- local tool execution,
- platform distribution.

This changes the supply-side product language. Creator-facing UI should use creator-native terms:

```text
Hatch Studio, not Developer Console.
App Page, not manifest.
AI Method, not system prompt.
Local Workspace, not filesystem schema.
Usage, not telemetry.
Earnings, not billing integration.
Publish, not deployment.
```

Technical terms can exist in advanced settings and docs, but they should not define the primary creator experience.

### 2.2 Creator Pain

The supply-side pain is specific:

```text
The creator has traffic.
The creator has a method.
The method works.
But the method cannot become a protected, paid software product.
```

Today, when this creator discovers AI, they have two obvious paths:

```text
Path A: make a chatbot.
  Easy to explain and easy to launch.
  But it mostly talks.
  It does not reliably act on local context, create files, update state, or produce durable work.
  It feels like content, not software.

Path B: publish a skill, repo, prompt pack, or agent workflow.
  More powerful.
  It can encode the creator's actual method.
  But the method is exposed as plain text or source.
  It has no native client-side app surface.
  It has no local state container for the user.
  Users still need GitHub, agent tools, API keys, and setup knowledge.
  The creator cannot charge cleanly for the skill itself.
```

So creators are forced into a workaround economy:

```text
They publish videos.
They open-source workflows.
They sell courses.
They sell communities.
They sell consulting.
They sell done-for-you setup.
They monetize traffic around the method instead of the method itself.
```

This is inefficient because the product value is already inside the workflow. The problem is that the distribution unit is wrong.

Hatch's claim:

```text
The workflow itself should become the product.
```

For a creator, the aha moment should be:

```text
I do not have to give away the playbook.
I do not have to teach every user to assemble tools.
I do not have to invent the missing app container.
I can turn the method into an app people install.
```

This is why Hatch must feel like creator commerce, not developer infrastructure.

### 2.3 Ideal Creator Profiles

The first creators should not be generic app developers. They should be creators whose workflow already gets attention but cannot yet become a protected, installable, paid product.

Ideal first creator:

```text
10k-100k precise followers
posts workflow tutorials
has comments asking for templates, setup, or implementation help
has sold courses, templates, community, consulting, or services
knows the method loses value when fully exposed
wants product leverage without becoming a software company
```

Early creator segments:

1. **AI Power User With Audience**

   These creators already build agent workflows, Claude/Codex skills, prompt systems, automation chains, or AI content pipelines.

   Current monetization:

   ```text
   tutorials
   prompt packs
   paid communities
   workshops
   implementation services
   ```

   Pain:

   ```text
   their workflows are powerful, but users cannot install them easily;
   once published, the workflow is copied;
   users must bring tools, models, and keys;
   creator earns from content around the workflow, not from the workflow itself.
   ```

   This is likely the first beachhead because they already understand why chat is too shallow and why open skills are too exposed.

2. **Workflow Creator**

   These creators teach how to do a repeated task better:

   ```text
   cross-border commerce content
   short-video operations
   Xiaohongshu growth
   Notion/Obsidian systems
   job or school application workflows
   content production workflows
   ```

   Pain:

   ```text
   methods spread well through video,
   but users still struggle to execute,
   and the creator cannot protect or operationalize the workflow.
   ```

3. **Template / Knowledge Product Seller**

   These creators already sell static assets:

   ```text
   Notion templates
   spreadsheet templates
   prompt packs
   PDF workbooks
   checklist products
   course materials
   ```

   Pain:

   ```text
   static products are copied easily;
   value is one-time;
   no usage feedback;
   hard to turn into subscription-like value.
   ```

   Hatch upgrades a static template into a living AI app with local user state.

4. **Domain Coach / Advisor**

   These creators help users improve in areas with sensitive context:

   ```text
   relationship management
   fitness and diet
   personal growth
   career communication
   parenting and education planning
   financial habits
   personal branding
   ```

   Pain:

   ```text
   user context is private;
   web forms reduce honesty;
   one-to-one service does not scale;
   building a full software product is too much.
   ```

   Hatch gives these creators leverage without asking users to expose everything to a generic web app.

5. **Niche Professional Operator**

   These are not always public creators, but they own practical industry playbooks:

   ```text
   real-estate sales trainers
   insurance advisor trainers
   recruiters
   agency operators
   private-domain commerce consultants
   B2B sales playbook owners
   industry-specific consultants
   ```

   Pain:

   ```text
   their SOP is commercially valuable;
   documents are easy to leak;
   customer data is sensitive;
   building dedicated software is too expensive.
   ```

   These may be strong later customers, but early sales cycles may be slower than creator-led segments.

Priority order:

```text
1. AI Power User With Audience
2. Workflow Creator
3. Template / Knowledge Product Seller
4. Domain Coach / Advisor
5. Niche Professional Operator
```

The common thread:

```text
They have insight and audience, not engineering teams.
They need leverage, protection, distribution, monetization, feedback, and simplicity.
```

### 2.4 Product Category

Hatch should not present itself as:

```text
developer platform
agent IDE
prompt marketplace
workflow automation tool
traditional software builder
```

Those categories pull the product toward the wrong user.

Better category language:

```text
creator-commerce layer for AI apps
app infrastructure for one-person creator companies
method-to-app platform
protected workflow commerce
AI app store for creator-led methods
```

The shortest practical positioning:

```text
Hatch turns creator know-how into protected, installable AI apps.
```

The more complete positioning:

```text
Hatch helps one-person creators turn their insight into AI apps that do work, produce local outputs, protect the method, and can be sold to their audience.
```

The product must make this feel true in the first ten minutes:

```text
creator writes method,
defines local workspace,
tests with examples,
publishes to Store,
user installs,
app does work,
creator sees usage and earnings.
```

### 2.5 Strategic Wedge

OpenAI and other model companies can build many of the underlying primitives:

- agent runtime,
- tool calling,
- local privacy models,
- payments,
- app discovery,
- developer observability,
- distribution.

The strategic difference is not whether they can build the technology. The difference is which economy the product is designed for.

Model companies naturally gravitate toward Developer Economy:

```text
SDKs
APIs
agents
tools
connectors
evals
deployments
observability
rate limits
model billing
```

Hatch is designed for Creator Economy:

```text
method
audience
trust
workflow
playbook
examples
local workspace
protected app
usage
earnings
```

Strategic positioning:

```text
OpenAI helps developers build agents.
Hatch helps creators productize insight.
```

Hatch should not compete by claiming model companies cannot build the primitives. Hatch competes by building the creator-commerce layer for AI apps:

- creator-native onboarding,
- method-first app building,
- protected workflow distribution,
- install flow for non-technical audiences,
- local workspace UX,
- privacy trace UX,
- usage and earnings loop,
- marketplace curation for creator-led apps.

The product must therefore avoid drifting into a developer platform. The creator should feel closer to Gumroad, Substack, Shopify, or a creator studio than to an API console.

One-line strategic rule:

```text
Hatch is the creator-commerce layer for AI apps, not the developer platform for agents.
```

This difference has concrete product consequences:

```text
Developer Economy product:
  "Build an agent."
  "Configure tools."
  "Deploy runtime."
  "Observe traces."
  "Manage API usage."

Creator Economy product:
  "Turn your method into an app."
  "Let your audience install it."
  "Keep the playbook protected."
  "Make the method usable as a consumer app."
  "See usage, cost, errors, and earnings."
```

The underlying primitives may overlap, but the user experience should not.

OpenAI can expose stronger primitives. That is not a threat by itself. It can also expand the surface area of what Hatch can wrap. The risk is not technical duplication. The risk is Hatch accidentally adopting Developer Economy language and losing the creator wedge.

Therefore:

```text
Expose advanced settings only after the creator already understands the product.
Keep first-run creator flow method-first.
Keep Store and Studio language commercial and concrete.
Treat consumer chat, install, local files, workflow execution, usage views, and review as Hatch's responsibility.
Treat the creator's method as the scarce asset.
```

Useful analogy:

```text
Stripe can power payments, but Gumroad and Shopify still matter because they package commerce for a specific seller.
Cloud platforms can host software, but the important layer is often the product surface built for a specific seller.
OpenAI can power agents, but Hatch matters if it packages AI app commerce for a specific creator.
```

Hatch's moat should not be "we have a model primitive others lack." It should be:

- creator supply,
- creator-native onboarding,
- method packaging language,
- local workspace UX,
- privacy trust UX,
- install behavior,
- marketplace curation,
- category-specific app templates,
- usage and earnings loop,
- norms around protected creator workflows.

## 3. The Three Parties

### 3.1 User

Analogy: iPhone user.

The user wants to install an AI app that can work with their real context without forcing them to upload raw personal data into a public web app.

User jobs:

- discover a PeopleOS app from the Hatch Store,
- install it into a local sandbox,
- open it as an independent app window,
- chat with it naturally,
- see what raw context stayed local,
- see what sanitized context was sent to the creator runtime,
- allow local tools to read and write inside the app sandbox,
- keep the app's filesystem across sessions.

The user should not think about API keys, token billing, model providers, prompt files, or runtime hosting.

### 3.2 Creator

Analogy: App Store creator/seller.

The creator is not just uploading a prompt. The creator is operating a full AI application backend.

Creator jobs:

- define a public manifest for Platform review,
- define one creator runtime for the app,
- define system prompts and private skill instructions,
- define the app filesystem schema that must be replicated on the user's device,
- expose a versioned API gateway that the User Local Runner can call,
- control model/provider selection and token cost,
- submit manifest updates to the Platform,
- monitor app usage, runtime health, cost, and failure patterns,
- keep private skill logic off the Platform and off user devices.

The creator's output is exactly two things:

```text
1. Public manifest submitted to Platform.
2. Creator-hosted API gateway used by installed clients.
```

The creator does not submit a skill zip to the Platform in this model.

### 3.3 Platform

Analogy: App Store.

The Platform is the distribution and trust layer. It does not run the creator's LLM runtime and does not receive user content.

Platform jobs:

- receive public manifests,
- review submitted apps,
- sign approved manifests,
- list apps in the Store,
- let users install apps,
- maintain app identity and version history,
- issue install/license records,
- provide update and revoke mechanisms,
- eventually handle subscription and revenue split.

The Platform must feel like a marketplace with governance, not a loose API registry.

## 4. v0.1 Showcase App: PeopleOS

PeopleOS is the first Hatch app.

PeopleOS helps a user manage relationships through local notes, contact records, reminders, and conversation history. It is the right showcase because it naturally needs sensitive context and a creator-owned methodology.

The demo must not use real personal data. Use synthetic names and lorem-style content only.

Example local workspace:

```text
peopleos/
  contacts/
    alex-lorem.md
    casey-ipsum.md
  notes/
    2026-05-15-lorem-coffee.md
  reminders/
    follow-ups.md
  outputs/
    weekly-relationship-brief.md
  sessions/
  audit.jsonl
```

Example user interaction:

```text
User sees:
  "I had lunch with Alex Lorem. She is considering a move to Berlin and asked about Ipsum Labs."

Creator runtime sees:
  "I had lunch with PERSON_A. PERSON_A is considering a move to LOCATION_A and asked about ORG_A."

User receives:
  "Add a follow-up note for Alex Lorem about the Berlin move and Ipsum Labs."
```

This single flow should demonstrate:

- local raw context,
- privacy transformation,
- creator runtime reasoning,
- local filesystem tool execution,
- rehydrated response,
- persistent app state.

## 5. Product Surfaces

### 5.0 Hatch Onboarding

The first launch experience should explain Hatch, not PeopleOS.

The user should understand the product through concrete examples, not protocol language. Avoid words such as runtime, manifest, schema, PII, sanitization, agent, SDK, local runner, tool call, rehydration, privacy boundary, and API gateway in onboarding copy.

The onboarding should teach three ideas:

```text
Install app -> app has a local folder.
Write message -> Hatch prepares the outgoing version.
AI helps -> result can become a local file.
```

Recommended three-screen flow:

Screen 1:

```text
AI apps with local folders

Hatch lets AI apps work with files on your computer.

Each app gets its own folder.

PeopleOS
  Contacts
  Notes
  Reminders
```

Screen 2:

```text
Your version stays here

On your computer:
  "Had coffee with Alex. She is moving to Berlin."

Sent out:
  "Had coffee with PERSON_A. PERSON_A is moving to LOCATION_A."

Back on your computer:
  "Add a reminder to follow up with Alex about Berlin."

Hatch prepares the message before sending it.
```

Screen 3:

```text
Replies can become files

PeopleOS created:

Reminders
  Follow up with Alex.md

You can open what changed in the app folder.
```

Primary action:

```text
Open Store
```

This onboarding is not a security guarantee and not a technical explanation. It is a mental model: Hatch apps work with local folders, Hatch prepares what is sent out, and useful replies can become local files.

### 5.1 Platform Store

The Store is the public marketplace.

Required v0.1 screens:

- Listed apps
- App detail page
- Install button
- App version and creator identity
- Review status badges for submitted apps

Required product feeling:

The Store should look like a place where apps are distributed, not a debug dashboard.

### 5.2 Platform Review Console

The Review Console is where Platform operators review creator-submitted manifests.

Required v0.1 states:

```text
Draft -> Submitted -> Reviewed -> Listed -> Revoked
```

The Platform reviews:

- app name,
- creator identity,
- manifest version,
- runtime API gateway URL,
- declared filesystem schema,
- declared local tool permissions,
- declared privacy behavior,
- declared runtime API surface,
- app screenshots/copy if present.

The Platform does not review private system prompts by reading their source. It reviews declared capabilities, API contracts, and runtime metadata.

### 5.3 Hatch Studio

Hatch Studio is the creator cockpit for turning a method into an installable AI app.

It is not a developer console, a prompt editor, or an admin panel. It is for non-technical creators with insight, audience, and repeatable workflows.

It has two primary functions:

1. Submit the public manifest to Platform.
2. Configure the creator-hosted app runtime.

Hatch Studio must let a creator define:

- app identity and public metadata,
- API gateway base URL,
- model/provider config,
- system prompt,
- private skill instructions,
- required local filesystem schema,
- allowed local tools,
- expected privacy mode.

The creator defines the app filesystem schema once. When a user installs the app, the User Local Runner replicates that structure locally.

Hatch Studio should present these as creator-facing areas:

```text
App Page
AI Method
Local Workspace
Test
Publish
Usage
Earnings
```

Underlying technical mapping:

```text
App Page        -> public manifest
AI Method       -> private instructions / system prompt
Local Workspace -> filesystem schema
Test            -> synthetic test lab
Publish         -> platform submission and versioning
Usage           -> usage view / telemetry
Earnings        -> payments and revenue reporting
```

Hatch Studio must also include a simple app dashboard. A creator needs product feedback to improve the app, but this dashboard must not become a loophole for raw user content.

Allowed creator-visible dashboard data:

- active installs,
- runs,
- successful and failed runs,
- latency,
- token usage and estimated cost,
- model/provider usage,
- local tool call types,
- tool call success/failure,
- sanitized error messages,
- app version distribution,
- coarse retention and repeat usage.

Not allowed in creator dashboard:

- raw user messages,
- raw local file contents,
- unredacted tool results,
- local PII mapping tables,
- cross-app user filesystem data.

In v0.1, creator analytics should be simple and operational. It should answer:

```text
Are people using my app?
Is the runtime working?
Where is it failing?
What is it costing me?
Which app/runtime version caused the issue?
```

Creator onboarding should be creator-native and commercial, not technical.

Recommended flow:

Screen 1:

```text
Your insight can become an app

You know how to help people do something better.
Hatch turns that know-how into an AI app your audience can install.
```

Screen 2:

```text
Do not build the missing app container

Hatch gives the method a consumer-grade chat surface, local workspace, install flow, full-workflow execution path, and usage view.
You focus on the method.
```

Screen 3:

```text
Sell the outcome, not the setup

Your users do not need GitHub, agent tools, or API keys.
They install your app, use your method, and pay for the experience.
```

Screen 4:

```text
Keep your method protected

Your workflow is not handed out as a prompt file or repo.
You can improve the app with usage signals without seeing private user content.
```

Primary action:

```text
Create My App
```

### 5.4 User Local Runner

The User Local Runner is the user's installed runtime.

Required v0.1 areas:

- Store view
- Installed apps library
- Independent app session/window for each installed app
- Chat surface
- Local workspace/file view
- Privacy trace panel
- Tool/audit trace panel

The user-side interface must separate installation from use:

```text
Store / Library:
  find and install apps

App Window:
  use one installed app
```

Opening an installed PeopleOS app should feel like launching an app, not like selecting an item in a terminal harness.

The User App UI is shared across Hatch apps. A creator does not declare custom UI layout, panels, blocks, navigation, or frontend components in the manifest.

The manifest declares the app's local filesystem schema. Hatch uses that schema to render the shared workspace UI.

Product boundary:

```text
Hatch owns the User App UI.
Creator owns the runtime and filesystem schema.
User owns the filesystem contents.
Platform owns distribution and review.
```

For PeopleOS, the manifest does not say "show a contacts panel." It says the app has a `contacts/` directory with a relationship-record purpose, read/search/write permissions, and privacy expectations. Hatch renders that folder in the common workspace UI.

The User App UI should therefore feel consistent across apps while letting each app's filesystem schema and runtime behavior create product specificity.

Chat should also follow this rule. Hatch should not invent a new chat protocol. The User App chat surface should use Vercel AI SDK UI primitives, with a custom Hatch transport that connects to the Local Runner and Creator API Gateway.

Runtime boundary:

```text
OpenAI Agents SDK = creator runtime primitive
Vercel AI SDK UI = user chat UI primitive
Hatch = transport, local filesystem, privacy, permission, and audit shell
```

The shared User App UI should render:

- Agent SDK-compatible user and assistant messages,
- streaming message updates,
- tool call requests,
- tool result states,
- run completion and failure states,
- Hatch privacy metadata,
- Hatch local filesystem audit metadata.

Hatch may adapt events for display, but should not create a parallel agent model such as `HatchTask`, `HatchIntent`, or `HatchAgentStep` when the Agent SDK already has a primitive for the concept.

### 5.5 Privacy Center

Privacy is not just a compliance claim. It is a product interaction that reduces user input friction.

The Privacy Center must show:

- raw user input stored locally,
- sanitized outbound request,
- creator runtime response before rehydration when useful,
- rehydrated final response,
- stable placeholder map summary,
- local tool calls and sanitized tool results.

This is the product proof that Hatch has a different trust boundary.

## 6. Core Object Model

### 6.1 Public Manifest

The manifest is submitted to the Platform. It is public, reviewable, signed, installable metadata.

It contains:

- app id,
- name,
- creator id,
- version,
- description,
- categories,
- runtime API gateway URL,
- filesystem schema,
- local tool permissions,
- privacy declaration,
- required runner version,
- update policy.

It does not contain:

- private skill instructions,
- system prompt body,
- creator API keys,
- model secrets,
- user content,
- proprietary routing logic.

### 6.2 Creator API Gateway

The Creator API Gateway is the creator-owned runtime surface.

It exposes versioned endpoints for installed local runners:

```text
GET  /hatch/v1/apps/{app_id}/runtime
POST /hatch/v1/apps/{app_id}/sessions
WS   /hatch/v1/apps/{app_id}/sessions/{session_id}/stream
POST /hatch/v1/apps/{app_id}/local-tool-results
GET  /hatch/v1/apps/{app_id}/health
```

The exact endpoint shape can change, but the product principle should not:

The creator operates a real API gateway, not a static skill file.

### 6.3 App Runtime

The app runtime is the single creator-defined execution unit for v0.1.

PeopleOS may contain internal workflows:

```text
relationship_chat
weekly_brief
follow_up_writer
contact_importer
```

But these are not first-class Hatch protocol objects in v0.1. They are private implementation details inside the creator runtime.

The app runtime can have:

- system prompt,
- private skill instructions,
- model config,
- local tool requirements,
- filesystem areas it expects,
- response schema,
- status/version.

This keeps Hatch closer to App Store than AWS. The first-order product entity is the app.

### 6.4 Local App Sandbox

The local app sandbox is created from the manifest's filesystem schema.

The creator defines structure. The user owns contents.

```text
HatchLocal/
  apps/
    peopleos/
      app.json
      workspace/
        contacts/
        notes/
        reminders/
        outputs/
        sessions/
        tmp/
      audit/
      privacy/
```

The creator runtime may request tool calls inside this sandbox. The Local Runner enforces containment and privacy.

The filesystem schema is the app's local state contract. It tells Hatch:

- what to create at install time,
- which directories are visible to the user,
- which directories are system-owned,
- which directories can be searched,
- which directories can be read,
- which directories can be written,
- which directories contain generated outputs,
- which directories require stronger privacy handling,
- which starter files or templates should be initialized.

Example PeopleOS schema:

```yaml
filesystem:
  folders:
    - path: contacts
      kind: collection
      description: relationship records
      permissions: [read, search, write]
    - path: notes
      kind: collection
      description: meeting notes and relationship context
      permissions: [read, search, write]
    - path: reminders
      kind: task_list
      description: follow-up reminders
      permissions: [read, write]
    - path: outputs
      kind: generated_outputs
      description: generated briefs and drafts
      permissions: [read, write]
    - path: sessions
      kind: system
      description: local session memory
      permissions: [system]
```

The schema is not a UI schema. It is a local state schema.

### 6.5 Creator App Telemetry

App telemetry is generated by the Creator API Gateway and by the User Local Runner.

Creator-side telemetry can include:

```text
run_id
app_id
app_version
runner_version
started_at
duration_ms
status
error_code
model
input_token_count
output_token_count
estimated_cost
requested_tool_names
tool_statuses
privacy_mode
```

Local-runner telemetry sent to the creator must be metadata-only or sanitized:

```text
tool_name
tool_status
duration_ms
sanitized_error_code
result_size_bytes
affected_path_class
```

`affected_path_class` should be coarse, for example:

```text
contacts
notes
reminders
outputs
sessions
tmp
```

It must not include raw file names when those names may contain user private data.

The Platform may receive aggregate install/license metadata. It should not receive per-turn app transcripts in v0.1.

### 6.6 Local Session And Runtime Runs

Chat history is local-only user app state.

Hatch should treat session memory, chat transcript, privacy traces, and runtime event capture as durable local state. The creator runtime executes remote runs, but it does not own the conversation.

Source-of-truth rule:

```text
Vercel AI SDK UI state is ephemeral.
OpenAI Agents SDK run state is ephemeral.
Hatch Local Session is durable and authoritative.
```

This produces three different identities:

```text
local_session_id
  Long-lived user-local app conversation.

local_turn_id
  One user turn inside a local session.

remote_run_id
  One creator-side OpenAI Agents SDK execution.
```

Mapping:

```text
local_session_id
  -> local_turn_id
      -> remote_run_id
```

The Local Runner stores the full mapping. The creator may store only hashed install/session references and run metadata.

The Local Runner stores:

- raw user messages,
- rehydrated user-visible assistant messages,
- Vercel AI SDK UI message state or a close equivalent,
- Agent SDK-compatible run events/items,
- raw-to-sanitized-to-rehydrated privacy traces,
- local PII map,
- local tool audit entries,
- generated files and outputs.

The Creator Runtime may process during a run:

- sanitized current turn,
- sanitized selected local history,
- sanitized selected file context,
- sanitized local tool results.

The Creator Runtime persists by default:

- remote run id,
- app id,
- hashed install/session/turn references,
- app/runtime version,
- status,
- latency,
- token usage,
- tool names,
- sanitized error category.

The Creator Runtime should not persist raw transcripts or rehydrated transcripts. In v0.1 it should also not persist sanitized transcripts by default.

The Platform stores no chat history, no sanitized transcript, no privacy trace, and no tool result transcript.

The consequence is intentional:

```text
Conversation lives locally.
Remote run executes temporarily.
Events stream back and are persisted locally.
Creator keeps operational metadata only.
```

If the Local Runner exits, the remote run should stop. Resume means local retry/replay from the durable local session, not server-side continuation.

## 7. Runtime Flow

### 7.1 Install Flow

```text
Hatch Studio
  -> submit manifest

Platform Review Console
  -> review and list app

User Store
  -> install signed manifest

User Local Runner
  -> create local sandbox from filesystem schema
  -> store install/license record
  -> app appears in Installed Library
```

### 7.2 Chat Flow

```text
User App Window
  -> user enters raw message

Local Runner
  -> stores raw message in local session
  -> loads selected local session history
  -> assembles current context
  -> sanitizes outbound message
  -> sanitizes selected history and file context
  -> keeps stable PII map locally

Creator API Gateway
  -> receives sanitized turn
  -> receives sanitized selected history/context
  -> records creator-visible run metadata
  -> starts a remote run
  -> runs OpenAI Agents SDK runtime
  -> may request local tool calls

Local Runner
  -> captures runtime stream events locally
  -> executes allowed tools inside sandbox
  -> sanitizes tool results
  -> emits sanitized tool metadata
  -> returns sanitized results

Creator API Gateway
  -> completes reasoning
  -> returns sanitized response

Local Runner
  -> rehydrates placeholders
  -> shows final answer to user
  -> stores rehydrated assistant message in local session
  -> writes audit log
```

The chat surface should be implemented as:

```text
Vercel AI SDK UI useChat
  -> custom Hatch transport
  -> Local Runner privacy boundary
  -> Creator API Gateway
  -> OpenAI Agents SDK runtime
```

This keeps Hatch out of the business of defining a new chat lifecycle. Hatch adds local state, privacy, permissions, and audit around the SDK primitives.

The integration model is:

```text
Vercel useChat
  -> HatchChatTransport
  -> Local Runner durable session
  -> Local Runner privacy boundary
  -> Creator API Gateway
  -> OpenAI Agents SDK remote run
  -> streamed events
  -> Local Runner event capture
  -> Vercel UI message parts
```

The remote run is disposable. The local session is durable.

When the app opens:

```text
Local Runner loads local session
  -> hydrates Vercel UI messages
```

When events stream:

```text
Creator stream event
  -> Hatch transport
  -> Local Runner persists event
  -> UI renders message/tool/run state
```

When the Local Runner closes:

```text
Vercel state disappears
remote run is cancelled or marked interrupted
local session remains
```

When the user retries:

```text
Local Runner loads local session
  -> assembles context again
  -> sanitizes again
  -> starts a new remote run
```

### 7.3 Tool Flow

The creator runtime never receives raw shell access.

It receives declared local tools:

```text
list
stat
search
read
write_file
append_file
apply_patch
copy
move
```

Every local tool call is:

- requested by creator runtime,
- checked against manifest permissions,
- executed inside the app sandbox,
- audited locally,
- sanitized before returning to creator.

## 8. v0.1 Acceptance Criteria

### 8.1 Distribution Must Feel Real

Pass if:

- Creator can create or update a PeopleOS manifest.
- Creator can submit the manifest to Platform.
- Platform can move app through review states.
- User can install only listed/signed apps.
- Installed PeopleOS appears in a separate local library.

Fail if:

- the user is manually typing runtime URLs,
- the Platform feels like a JSON registry only,
- creator private skill text is uploaded to Platform.

### 8.2 Creator Runtime Must Feel Protected

Pass if:

- private system prompt and skill instructions live only on creator side,
- runtime uses OpenAI Agents SDK,
- creator can define an app runtime behind an API gateway,
- creator can see app usage and operational health without raw user content,
- local runner calls the gateway through a stable contract.

Fail if:

- the product distributes raw `SKILL.md` to users,
- the platform stores private prompts,
- the agent loop is hand-rolled instead of SDK-wrapped.

### 8.3 User Local Context Must Feel Native

Pass if:

- installing PeopleOS creates the expected local filesystem structure,
- the shared User App UI renders that structure from the filesystem schema,
- the app can read/write/search within its sandbox,
- user can inspect files created by the app,
- installed app opens as a separate app session/window.

Fail if:

- the demo is only a chat box,
- the file system is hidden or fake,
- local tools are mocked.

### 8.4 Privacy Must Be Visible

Pass if:

- user sees raw input,
- user sees sanitized outbound context,
- creator runtime receives sanitized content,
- response is rehydrated locally,
- tool results are sanitized before leaving device.

Fail if:

- privacy is only described in copy,
- creator receives raw PeopleOS content,
- placeholder mapping is regenerated every turn without stable local state.

### 8.6 Local Session Must Be Source Of Truth

Pass if:

- chat history is persisted locally under the installed app,
- Vercel UI state can be reconstructed from local session storage,
- Agent SDK run events are captured locally,
- remote runs can be cancelled when the Local Runner exits,
- retry starts a new remote run from local session state,
- creator dashboard stores metadata only by default.

Fail if:

- creator server owns durable conversation history,
- platform receives per-turn transcripts,
- closing the Local Runner silently loses user-visible transcript,
- retry depends on creator-side hidden session state.

### 8.5 PeopleOS Must Feel Like an App

Pass if:

- app has a name, icon/identity, description, creator, and version,
- it opens into its own session,
- it has chat, files, privacy trace, and audit trace,
- it performs at least one useful relationship-management workflow.

Fail if:

- it feels like a generic test agent,
- creator-specific UI layout is required for the app to feel useful,
- it uses real personal data,
- it cannot persist app state across sessions.

## 9. Demo Storyboard

Five-minute product demo:

1. Creator opens Hatch Studio and shows the PeopleOS app setup.
2. Creator defines the PeopleOS filesystem schema.
3. Creator submits only the public manifest to Platform.
4. Platform Review Console moves PeopleOS from Submitted to Listed.
5. User opens Hatch Store, sees PeopleOS, and installs it.
6. User opens PeopleOS from Installed Library into its own app window.
7. User enters a synthetic relationship note.
8. Privacy Center shows raw local text and sanitized outbound text.
9. Creator Runtime responds through OpenAI Agents SDK and requests a local file write.
10. Local Runner writes a follow-up file into the PeopleOS sandbox.
11. User sees the rehydrated answer and can inspect the new local file.

The audience should understand the whole business model without reading architecture diagrams.

## 10. What Current Prototype Proves

Already proved:

- there can be three separate instances: Platform, Creator Runtime, User Local Runner,
- Platform can receive and distribute manifests,
- Creator Runtime can run OpenAI Agents SDK,
- desktop runner can install an app and open a chat session,
- local Rust tools can enforce a sandbox,
- deterministic privacy sanitization can transform outbound text.

## 11. Current Product Gaps

The prototype is not yet a product because:

- Hatch Studio does not yet feel like a creator-native app studio.
- Platform review flow is too light to feel like an App Store.
- PeopleOS is not yet a strong showcase app.
- Filesystem schema replication is not yet prominent enough.
- Privacy Center is not yet the visual centerpiece.
- User app window is not yet rich enough to feel independent.
- The creator API gateway contract needs to become explicit.

These gaps should drive the next implementation cycle.

## 12. Next Build Priorities

Priority 1: PeopleOS product shell

- app identity,
- app detail page,
- installed app window,
- local workspace tree,
- shared User App UI driven by filesystem schema,
- Vercel AI SDK UI chat surface with Hatch transport,
- synthetic starter files,
- one relationship workflow.

Priority 2: Hatch Studio as creator app cockpit

- App Page editor,
- AI Method editor,
- Local Workspace editor,
- advanced runtime config,
- app dashboard,
- token/cost dashboard,
- failure and latency view,
- Publish action.

Priority 3: Platform review and distribution

- submission queue,
- review state transitions,
- listed app page,
- signed install manifest,
- install/license record.

Priority 4: Privacy Center

- raw input,
- sanitized outbound,
- placeholder map,
- sanitized tool result,
- rehydrated final response.

Priority 5: Creator API gateway contract

- document runtime endpoints,
- align desktop client with that contract,
- keep OpenAI Agents SDK as the runtime engine,
- keep Vercel AI SDK UI as the user chat UI primitive,
- avoid inventing a parallel agent protocol where the SDK already has a shape.

## 13. Product Rule

When in doubt, use the App Store mental model:

```text
Platform = App Store
Creator = App Store creator/seller
User Local Runner = iPhone + installed app sandbox
PeopleOS = first app
Manifest = App Store listing + entitlement declaration
Creator API Gateway = app backend
Local filesystem = user-owned app container
Privacy mapper = local-only trust boundary
```

The product fails if any party collapses into another party:

- Platform must not become the creator runtime.
- Creator must not receive raw local context.
- User Local Runner must not contain creator private skill logic.
