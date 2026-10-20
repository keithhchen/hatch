# Hatch Web visual guidelines

The rules every Web page follows (landing, Explore, Studio, chat, account, download).
Tokens live in `creator-dashboard/src/webTheme.css` (`--web-*`). Desktop is out of scope.

## 1. Page rhythm
- Each screen: one soft pill label → one plain sentence title → one big visual (real photo, real product UI, or small animated graphic). No text-only screens.
- One idea per screen. Title is one sentence; subtitle at most two lines.
- Generous white space. Background is warm paper `#FAF8F2` with faint yolk/blue aura. No colored section panels, no black divider rules, no ✓/— comparison tables.
- Light backgrounds only. Never a dark section.

## 2. Color
- Paper `#FAF8F2`, card `#FFFDF8`, ink `#17150F`, body `#3E3A31`, muted `#6B6455`, rule `#E8E2D4`.
- Yolk `#F5B700` only for the single most important thing on screen (primary action, active selection, key word). Yolk-soft `#FFF3CC` + gold `#7A5A00` for pills.
- Pastel pairs only for card fills and small graphics: blue `#E3EEFB/#3F6FA8`, lilac `#F4E4F1/#A0549A`, green `#D8ECDC/#2F7D4F`.
- No pure greys; every neutral leans warm.

## 3. Type
- DM Sans for everything. Headings weight 700, tracking −0.02em. Never the thin serif for headings.
- Instrument Serif only for brand moments: logo, giant footer wordmark, step numbers, prices.
- No monospace anywhere. No UPPERCASE English tags (READ, EVAL, BOOKED…). Labels are in the page language.
- Chinese titles should not break mid-phrase; shrink instead.

## 4. Imagery
- Real-people lifestyle photos: warm, natural light, shallow depth of field. No stock posing.
- Overlay real product UI (chat bubbles, task lists, toggles) as frosted cards. No abstract skeleton illustrations.
- Examples must fit CN / US / JP; avoid single-country examples.

## 5. Motion
- Motion explains something; never decoration for its own sake.
- Prefer scroll-driven or play-on-enter. Replayable on tap where useful.
- No dense, flickering or jittery effects.

## 6. Logo
- Use the combined lockup `/assets/web/hatch-lockup.svg` (`WebBrand`); never compose egg + wordmark in CSS.
- Small sizes (favicon, avatar): egg only. Don't recolor, outline, or place on dark.

## 7. Copy
- Say what a normal person would say. If it sounds odd read aloud, rewrite it.
- No report feel: no status tags like 已上线/试点中, no checkmark tables.
- Specific where it should be (real questions, real prices), big where it should be.
- zh / en / ja carry the same meaning and each reads naturally — not word-for-word.

## Pre-ship checklist
- [ ] Any dark background?
- [ ] Any monospace or UPPERCASE English tags?
- [ ] Does every screen have one visual?
- [ ] Do titles read naturally aloud?
- [ ] On a phone, is anything covered or cut off?
