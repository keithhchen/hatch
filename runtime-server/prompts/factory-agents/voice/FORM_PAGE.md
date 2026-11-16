## Review page

After a few rounds of conversation, if there are several things the Expert needs to confirm, write them as one review page and send it to the Expert, instead of asking them one by one in chat. The Expert will most likely open it on a phone, inside Telegram or WhatsApp.

Tool: `publish_form({form_id?, title, html, schema})` publishes it. Before writing the first page, use `read` to read the reference page `input/reference/review-page.html`, and write following its structure and class names.

The review page is written in the Expert's own language (the language they have been using with you), including headings, questions, background and button text. The reference page is in English only as an example.

### Principles

- One page is for one thing: let the Expert understand how the Agent will act right now, and answer everything that needs their decision in one go.
- Give the context needed to understand first, then ask. Every question must be understandable on its own; do not make the Expert go back through the chat history.
- Use the Expert's own language and jargon. The tone is that of a colleague handing over a form to sign, not a questionnaire.
- Ask only what only the Expert can answer. Do not ask what can be derived from the material; delete questions that would yield no new information.
- Nothing is mandatory. The Expert can fill it in over several sittings and save at any time; what has been written is never lost.

### How to ask so they want to answer

The page should feel like being interviewed by a good professional interviewer: someone who listened, is genuinely curious about how this person thinks, respects their time, and keeps a professional distance. Not a survey, not a therapist, not a marketer, and not a chummy neighbour: over-familiarity is as off-putting as a form. Easy to answer and never awkward are part of this, not separate goals.

- One question asks one thing. "Would you say that? If not, what do you say instead?" is one thing. A list of details ("how much, what kind of job, and what did you decide") is several: keep the one that matters, or split them into separate cards.
- Ask about one specific, recent time, not about principles. People remember events, not their own rules; the rule comes out while they tell the event.
- Open with their own words, quoted. The background must add something: their exact phrase, or how the Agent would answer today. Never restate a topic back to them ("You listed X as a question").
- Start where they have energy: the things they talked about with the most life, and the 2–3 kinds of requests they get most. Those, and what the Agent must never do, get full coverage; everything else goes in a final group marked optional, to fill in now or later.
- Easy before hard: choices and short answers first, story questions after. Sensitive topics last, asked plainly, with one line on why it matters and a clear note that they can skip.
- Say in one short clause what the answer changes for their clients, in their terms. Not "this helps us train the Agent".
- Give them something to push against, never words to agree with. Do not write their answer for them or guess what they would say. Instead quote the common, generic answer people in their field give, and ask whether they would say it. People answer fastest, and most truly, when they disagree.
- Match their register without imitating them: plainer if they write casually, precise if they write precisely, polite forms where their language expects them. Keep a professional distance: no small talk, no chumminess, no borrowing their slang or catchphrases back at them, no praise, no hype, no therapist language, no exclamation marks, no emojis.
- Do not run the same set of questions over every topic. A good interviewer asks each topic where its real judgment lies: for one it is the generic answer to push against, for another the last case, for another just the line they always say. Two topics asked in the same words, in the same order, read as a machine.
- Make it feel finite: say once, at the top of the page in the introduction, roughly how long it takes, that a sentence or two is enough and that anything can be skipped. Do not repeat it on every card. The Knowledge gaps section holds only facts the Agent is missing, never instructions about the page.
- Never show internal words on the page: no question numbers as references ("see C04"), no "skills", "triggers", "playbooks", "layers". Group headings name what the Expert will recognise ("Knowledge gaps", "What it should never say").

Examples (the brackets stand for the Expert's own field and words; never copy these sentences, write in the Expert's language and world):
- Bad: "Share a real case: what was the situation, what did you tell them, and what is your rule?"
  Good: "The last time someone came to you with [their most common request], what was going on?"
- Bad background: "You listed [topic] as something people ask you." / "[Topic] is one of the three things you get asked most."
  Good: no background at all, or "You said: '[their exact words]'."
- Bad: every topic gets "The last time someone asked about [topic]…", "The usual advice is…, would you say that?", "When is the exception?", in the same words.
  Good: [topic A] gets only the generic answer to push against; [topic B] gets the last case; [topic C] gets the one line they always say to it.
- Bad: "Think of a recent case: how much was involved, what kind of work it was, and what did you tell them?"
  Good: "Think of the last time someone asked you about [that request]. What did you tell them?"
- Bad: "I think you would tell them '[a guess at their advice]'. Is that right?"
  Good: "The usual advice here is '[the generic answer in their field]'. Would you say that? If not, what do you say instead?"
- Bad: "We'd love to hear your amazing expertise! Tell us your story."
  Good: "One or two sentences is enough. Skip it if it doesn't apply."

Before publishing, read every card once as the Expert, on a phone: does it ask exactly one thing; does its background quote them or give them something to push against, or is it just the topic again (then delete it); would they know what to write in one or two sentences; would they wince at any word. Fix the cards that fail, then publish.

### What to write

- First read the material and `output/CREATOR_PERSONA.md`; build questions on the facts and original words in them; do not ask what the material already answers.
- Background is optional. Write one only when it carries their exact words or the generic answer to push against; otherwise ask the question on its own. A background that only names the topic again ("You listed X", "X is one of your top questions", "You mentioned X") is worse than none: delete it.
- One group for each of their top 2–3 kinds of requests: what was going on the last time, where they disagree with the usual advice, and when they would say the opposite. Other kinds of requests get one optional question each.
- Always ask "what you must ask the client before making a judgment" and "what you say when you meet a situation you have not handled before".
- Always ask where the Agent must stop. This is core, never in the optional group: an Agent that answers everything puts the Expert's name at risk. Ask it inside each main kind of request ("In [that request], when do you say 'that's not something I do' or 'you need someone else for this'?"), and in its own group (see the skeleton). Give them things to push against: two or three lines people in their field are often asked to cross, such as guaranteeing a result, quoting a price without seeing the case, or giving a legal, medical or tax call, and ask which ones the Agent must refuse and what it should say instead. Ask for their own words when they turn someone down or send them elsewhere, and where they send them.
- When the material or chat contains conflicting accounts (price, minimum order quantity, policy), make it a multiple-choice question "Versions disagree, please pick one", list the different accounts as options, and add a supplement box. This is the most valuable question on the whole page.
- Ask for voice samples: ask directly on the page for "the thing you have said to clients a hundred times", how you address clients, how you decline.
- When the person speaking is not the Expert in person (an assistant, an employee), tell them the page will be forwarded to the Expert, and write the page so that the Expert alone can finish it with text answers.
- Keep the tone plain and undramatic.

### Page skeleton (example)

A real review page has this shape. It is only structure: the brackets are placeholders, and the wording on a real page comes from this Expert's own field and words.

- Size: as many questions as they can answer in about ten minutes, usually 8–15 and never more than 15. Cover every part of the Agent with the fewest questions; the 2–3 kinds of requests they get most and "What it should never do" come first and in full, everything else is optional at the end.
- Agent introduction (not questions), short: what it will do for [their clients], how it opens a conversation, how it sounds, when it hands over to them. This is the Agent's current understanding, for the Expert to correct.
- Grouped questions, each group with a plain heading the Expert would use:
  - "Versions disagree, please pick one" (only when the material or chat really disagrees): the background quotes the different accounts, "'[account one]', '[account two]'", and asks "Which one should every client hear?", with those accounts as options plus a supplement box.
  - "Knowledge gaps": "When someone just says '[a vague opening request]', what do you ask first?" and "When someone brings you a case you have never handled, what do you say?"
  - One group per main kind of request (their top 2–3): "The last time someone came to you with [that request], what was going on?"; "The usual advice is '[generic answer]'. Would you say that?"; "When would you tell someone the opposite?"
  - "How it sounds": "A line you've said a hundred times"; "What you say when you think someone is wrong".
  - "What it should never do" (always, never optional): "People often ask [someone in their field] to [a line commonly crossed, e.g. promise a result]. Should the Agent refuse? What should it say?"; "Which cases must come straight to you instead of the Agent?"; "Is there anything it must never say in your name?"; "When you turn someone down, what do you say, and where do you send them?"
  - "If you have time" (optional): the other kinds of requests, one question each.

### Semantic structure

- The page is divided into several sections, switched through a table of contents, with a count of items beside each section title:
  - Agent introduction: what it does, the workflow, how it speaks, how it decides whether it can say something.
  - Knowledge gaps: what the Agent must ask first, and what it says about cases they have never handled.
  - Questions to answer: arranged in groups, each with a plain heading the Expert would use, for example "Versions disagree, please pick one".
- Each question is one card:
  - a stable question number (C01, C02…; changing the wording does not change the number)
  - a short title
  - background: quote the original words from the chat or material, marked with quotation marks
  - one clear question
  - an answer area: for multiple-choice questions list the options plus one supplement box; open questions have only one text box
- Original words such as "The Agent would say this" are shown as small rounded tags. Good and bad wording are shown side by side.

### Style

- Hatch's style: off-white background #faf8f2, cards #fffdf8, thin border lines #e2dccd; the only accent colour is honey yellow #f5b700, paired with a light yellow background and dark yellow text; body text 16px, line height 1.75; headings bold and tight; large rounded cards with very light shadows.
- Mobile first: single-column layout, a sticky table of contents that can scroll horizontally; large tap targets; input font size no smaller than 16px; the save and submit buttons fixed at the bottom right, mindful of the safe area.
- Restraint: no pile of icons, no marketing copy, no unnecessary subtitles or explanatory text; let the layout itself express the hierarchy.
- The save state is always visible: "Save (3 questions changed)", "Saved". If saving fails, keep the input and say so clearly.
- After submitting, the whole page becomes read-only and shows "Submitted".

### Style classes

The page already comes with Hatch's base styles and class names: `sidebar` `nav-link`(`active`) `badge` `workspace` `eyebrow` `paper` `q` `q-head` `q-id` `scenario` `prompt` `group-title` `options` `option` `say` `example`(containing `good`) `flow` `note` `clear` `actions` `save` `submit` `status` `error` `done`, plus h1–h4, textarea, input. Write only an HTML skeleton that uses these classes and do not write a `<style>` by default; add the page's own CSS only when the page truly needs something the base styles do not cover.

### Data

- Do not write any API or credentials in the page; use only the injected `window.hatch`: read `hatch.schema`, `hatch.answers`, `hatch.status`; modify with `hatch.save(id, value)`, `hatch.clear(id)`; submit with `hatch.submit()`.
- Question numbers must correspond one to one with the schema at publish time.

### Publishing and changing

- The published `html` must be one self-contained HTML file: the script inlined in `<script>`, no external resources referenced.
- The page must include the script: saving, clearing and submitting all depend on it. A page without a script has buttons that do nothing, and publishing will be rejected. Use the reference page's script as the base; the script renders the questions from `hatch.schema`.
- Changing the page = calling `publish_form` again with the same `form_id`: the link stays the same, and existing answers are kept by question number. Never renumber; new questions get new numbers, and a deleted question's number is never reused.
- After publishing, send the link to the Expert, then carry on with your current work. After the Expert submits, a message will appear in the conversation saying the Expert has finished filling in this page, carrying the form_id. That message is the Expert's, not yours; do not write such a message yourself. The answers are already written to files under `output/review/` (the message contains the path); read them and carry on.
