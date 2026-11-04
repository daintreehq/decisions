# Daintree Decisions redesign: consolidated guide

**Status:** the authoritative brief for the 0.4 redesign. **Date:** 3 November 2026. **Baseline:** `main` at `e3f7e55` (v0.3.0).

This guide consolidates two independent interaction specifications ("Spec A", grounded in the source; "Spec B", written from the documentation export) and the owner's direction for the visual system. The two specs were treated as votes: where both asked for the same thing it is settled here without comment; where they disagreed, or where the owner's direction overrides both, the resolution and its reason are recorded inline as **Resolved:**. Requirements use **must** (required for done), **should** (strong default, tune on devices) and **later** (out of this release; never expose a dead control for it).

Existing security, protocol and trust behaviour stays authoritative. This redesign changes presentation, interaction and local client behaviour. It does not change the wire protocol, grant the phone new permissions, or add attachment types.

## 1. Direction

### 1.1 The loop

Decisions exists so an agent can ask a person for a decision without holding a tool call open. The loop the whole app is built around:

1. Tap a notification (or open the app) and land on the right question.
2. Read it and recognise its project and computer.
3. Swipe through its files; tap one to inspect it closely.
4. Keep looking at the evidence while dictating an answer.
5. Stop, review the text and any selected option.
6. Send once and see honestly where the answer has reached.
7. Go to the next question when ready.

The central structural change, which both specs proposed independently: **a question is a workspace with a persistent answer dock.** The question and its files fill the screen; the dock at the bottom always offers dictation, typing and the way to every other question. Opening a file is a mode of the same workspace, keeping the same draft and recorder.

### 1.2 The quality bar

The owner's verdict on 0.3: "a janky mess… nothing really makes sense… press a separate button to dictate and then submit the dictation… a 3 out of 10." The redesign is judged against that. It must feel like one coherent tool, not a form with a recorder bolted under a textarea:

- **One-thumb answering.** Tap Dictate, talk, tap Stop, tap Send. Dictate never moves; your words appear in the answer while you speak; Send appears directly above Dictate the moment there is something to send. No scrolling, no hunting, no second "submit the dictation" step.
- **Fewer things on screen.** Every badge, card, banner and button must earn its place. When two elements say the same thing, delete one.
- **Nothing jumps.** Loading, transcription, delivery updates and new questions never shift what is under the finger.
- **Every state looks intentional,** including empty, loading, offline, expired and error states.

Target: a reviewer comparing it with Daintree scores it 8/10 or better on every main screen.

### 1.3 Belongs to Daintree

Decisions is Daintree's sister app and must look like it. **Resolved:** both specs said "keep the existing green palette"; the owner's direction overrides that. The app ships exactly two themes, generated from Daintree's own theme engine: **Daintree** (dark) and **Bondi** (light), with "Match device" choosing between them. The current hand-written green palette is removed.

### 1.4 Non-negotiable rules

1. The answer controls never depend on scrolling to the end of the question.
2. The question stays identifiable in every file-viewing and answering mode.
3. Files and questions have different navigation. A horizontal file gesture never changes the question.
4. **Stop and Send are separate actions in separate places.** Silence, a spoken phrase, a swipe or closing a viewer never sends.
5. A draft belongs to one question, one reviewed revision and one mode (answer or correction). Late async results can never land in another question or a newer revision.
6. Normal movement is reversible: going back restores the file, scroll, draft, filters and search.
7. Selecting an option is reversible until Send. No option is preselected.
8. An answer never silently authorises a newer question revision.
9. Loading evidence is not acknowledging it. A prefetched image is not a reviewed image.
10. Human and model authorship stay visible; confirming a model answer does not rewrite who authored it.
11. Status claims match evidence: saved on this device, saved on your relay, received by your computer and delivered to the terminal are different labels.
12. Every gesture has a visible, tappable and keyboard-operable alternative.
13. Failures keep recoverable work on screen and say what was not saved.
14. No routine confirmation for a safely saved draft. Confirm only real loss or a deliberate corrective action (a correction, unpairing, discarding a correction).

## 2. Visual system

### 2.1 Character

Daintree's look, adapted for touch: a calm, near-neutral field; one load-bearing accent per region; hairline structure; quiet depth; dense but readable type. The question, the evidence and the answer create the hierarchy, not stacks of tinted cards and repeated badges.

The rules carried over from Daintree (its `.claude/rules/design-system.md` and `docs/themes/*`):

- **Accent restraint.** The accent (`#36CE94` on Daintree, deep water `#004E6B` on Bondi) is at most one load-bearing signal per region: a focus ring, the recording state, or the active navigation item. Never a fill for multi-select, membership, badges or "everything is fine" chrome. In doubt, no accent.
- **The primary action is a contrast button**, not an accent button: `text-primary` fill with `text-inverse` label (near-white on Daintree, near-black on Bondi). It is theme-aware by construction.
- **Selection is neutral.** A selected option or row gets a raised neutral fill plus a `text-secondary` edge, never an accent wash. On Bondi selection lifts toward white.
- **Green is scarce.** Status success (`#6B8D72` on Daintree, `#017249` on Bondi) is only for named outcomes and finite completed steps (delivered, confirmed), never ambient "healthy" chrome.
- **Status colour sits on the glyph and the tint, never the words.** A status chip is a 10–15% tint of its hue with a coloured icon and neutral text.
- **Never fade text with alpha.** Step down the hierarchy: primary → secondary → muted. `text-muted` is not for icons or load-bearing text.
- **Shadows only from tokens**; borders are 1 px hairlines; the input edge is the solid `border-input` token (it owes 3:1).

### 2.2 Tokens

Colour values are generated, not hand-written. `app/scripts/sync-theme.mjs` imports Daintree's `shared/theme/themes.ts`, calls `getAppThemeCssVariables()` for `daintree` and `bondi`, and writes `app/src/styles/theme.generated.css`. The generated file is committed (the build never depends on a Daintree checkout) and carries a header naming its source commit. Regenerate whenever Daintree's themes change.

The app consumes the generated `--theme-*` variables through a small semantic layer in `app/src/styles/tokens.css`. Components never reference a raw hex. The names follow Daintree's vocabulary so the two codebases read the same:

| Role             | Variables                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces         | `--theme-surface-grid` (app field), `-sidebar` (the sidebar), `-canvas`, `-panel` (content cards), `-panel-elevated` (sheets, popovers), `-input`, `-inset` (recessed wells) |
| Text             | `--theme-text-primary`, `-secondary`, `-muted`, `-placeholder`, `-inverse`, `-link`                                                                                          |
| Borders          | `--theme-border-default`, `-subtle`, `-strong`, `-divider`, `-input`                                                                                                         |
| Accent           | `--theme-accent-primary`, `-foreground`, `-soft`, `-muted`, `--theme-focus-ring`                                                                                             |
| Status           | `--theme-status-{success,warning,danger,info}`, their `-surface` and `-text` variants, `--theme-activity-waiting`                                                            |
| Overlays         | `--theme-overlay-{subtle,hover,active,selected,raised}`, `--theme-scrim-{soft,medium,strong}`, `--theme-scrim-blur`                                                          |
| Depth            | `--theme-shadow-{ambient,floating,dialog}`, `--theme-material-blur`, grain via `--grain-image` and `--theme-grain-opacity`                                                   |
| Model provenance | `--theme-syntax-keyword` (Daintree's violet; `#c89ce8` dark, `#644395` light), always paired with the words "Model answer"                                                   |

**Resolved:** Spec A gave the model-provenance marker its own purple; this keeps it but takes the value from the theme so it stays in family.

Theme application: `data-theme="daintree" | "bondi"` on `<html>`; "Match device" resolves through `prefers-color-scheme` and follows live changes. `<meta name="theme-color">` and the manifest colours use each theme's `surface-grid`. The stored preference keeps its existing values (`system | light | dark`), so nothing migrates: `light` applies Bondi and `dark` applies Daintree. The UI labels them Match device, Bondi (light) and Daintree (dark).

### 2.3 Type

| Element                         | Size / line height                | Weight                |
| ------------------------------- | --------------------------------- | --------------------- |
| Question                        | 22 / 30 px; 20 / 28 below 360 px  | 600, tracking −0.01em |
| Body, answer text, option label | 16 / 24 px                        | 400; option label 500 |
| Secondary and metadata          | 14 / 20 px                        | 400–500               |
| Small labels, chips             | 13 / 18 px                        | 500                   |
| Section eyebrow                 | 12 px, uppercase, tracking 0.06em | 600, `text-secondary` |
| Code, IDs, fingerprints         | JetBrains Mono, 0.9em             | 400                   |

**Resolved:** Spec A asked for 17 px body and Spec B for 16 px; Daintree is dense. 16 px wins: it is the iOS no-zoom floor for inputs and matches Daintree's character. The question at 22 px sits between Spec A (22–24) and Spec B (24). UI font is the system stack (both specs and Daintree agree). JetBrains Mono (latin 400 and 700 woff2) is self-hosted for code, because the CSP allows only `font-src 'self'`.

### 2.4 Shape, spacing and targets

- Spacing scale 4, 8, 12, 16, 24, 32 px. Phone gutter 16 px (12 px under 360 px); 24–32 px on wide layouts.
- Radius follows Daintree's scale (base 10 px): `--radius-sm` 6 px for chips; `--radius-md` 8 px for buttons and inputs; `--radius-lg` 10 px for cards, option rows and file stages; `--radius-xl` 14 px for dialogs; bottom sheets 16 px top corners. **Resolved:** the specs' 12–16 px panel radii were the old app's softness; Daintree's tighter scale is the identity.
- Touch targets: 48 × 48 px preferred, never below 44 × 44 for anything frequent. Dictate/Stop is at least 56 px. (Daintree's 32 px desktop controls are not used; the look is Daintree's, the size is a phone's.)
- Reading width for long prose about 68–72 characters.

### 2.5 Depth and material

- Shadows are the theme tokens: `ambient` for cards that sit on the field, `floating` for the dock and popovers, `dialog` for sheets and dialogs.
- The app field carries Daintree's grain (`--grain-image` at `--theme-grain-opacity`, 0.03) as a fixed, non-interactive `::before` layer. Nothing else gets texture.
- Sheets, the dock and menus use Daintree's material: on Daintree a 94% surface with `backdrop-filter: blur(var(--theme-material-blur)) saturate(115%)`; on Bondi they are opaque.
- Scrims use `--theme-scrim-medium` with `--theme-scrim-blur`.
- The file-viewer stage is the darkest surface in both themes (Bondi keeps a dark stage, as Bondi keeps a dark terminal) so screenshots read true.

### 2.6 Motion

Daintree's tiers, all under 300 ms: state changes 150 ms ease-out; panel and sheet enter 200 ms on `cubic-bezier(0.2, 0, 0, 1)`, exit 120 ms on `cubic-bezier(0.2, 0, 0.7, 0)`; press feedback `scale(0.98)` that snaps (no transition on transform). File swipes follow the finger with no overshoot. Never `transition: all`. `prefers-reduced-motion` removes slides, scales and pulses (fade at most). The recording indicator stays clear without movement. Loading follows the Doherty gate: show nothing before 400 ms, a skeleton (if the shape is predictable) from 400 ms, "Still loading…" after 5 s.

### 2.7 Icons and brand

- One icon set drawn as inline SVG (the CSP forbids external assets). Glyphs follow Lucide's geometry at 1.75 stroke so they match Daintree; one glyph per recurring action (copy, refresh, edit, close, chevrons, mic, stop square, send, files, expand, compare).
- Severity glyphs are fixed: error `XCircle`, warning `AlertTriangle`, info `Info`, success `CheckCircle2`.
- Decisions wears Daintree's own mark (canopy, trunk and roots) on Daintree's icon tile (`#151616` with the mint mark), so the two apps read as one family. The sidebar's head carries the mark and "Daintree", set large in the system face at display size (issue #40); working screens carry no logo. See `docs/brand/README.md`.

## 3. Layout, navigation and platforms

### 3.1 Destinations

Three top-level destinations, as both specs agree: **Questions** (scopes Needs you, Model answers, All), **History**, **Settings**. Devices moves inside Settings; `/devices` keeps working and shows a back link to Settings.

| Route                             | Meaning                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `/`                               | Home: every question, Needs you first, remembering this device's filters |
| `/q/:id`                          | That exact question in its current authoritative state                   |
| `/history`                        | History, restoring the session's query, filters and position             |
| `/settings`, `/settings/:section` | Settings index and its sections                                          |
| `/devices`                        | Devices (inside Settings visually)                                       |
| `/pair`, `/install`, `/privacy`   | Unchanged meanings                                                       |

Never put question text, answers, file names, search terms, pairing secrets or keys in a URL. Workspace modes (file viewer, navigator, editor) are history entries without new paths: they push a `history.state` marker so Back closes them, and file-to-file movement replaces state rather than adding Back steps.

### 3.2 Responsive modes

| Width          | Layout                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Under 720 px   | One surface at a time, with no title bar and no tab bar. A round 48 px menu button floats top-left inside the safe area (in a question it takes the header's leading slot) and opens the sidebar from the left: the mark and name, Home, History and Settings, Recent questions (each with a fresh agent state, 4.2, in a fixed slot at its end), and the connection and update state. |
| 720–1099 px    | One centred surface (max 760 px reading column). The sidebar is still an overlay; the navigator opens as a side sheet from the left.                                                                                                                                                                                                                                                   |
| 1100 px and up | The sidebar is a persistent 300–320 px column on the left, in the same style; the page or workspace fills the rest; the dock belongs to the workspace column, not the window.                                                                                                                                                                                                          |

**Resolved:** Spec A put the first breakpoint at 768 px and Spec B at 720 px; 720 px wins so iPad split view and small tablets in portrait stay single-surface. Both agreed on a persistent column at 1100 px. **Resolved (issue #40):** the owner replaced the tab bar, the top navigation and the navigator rail with the menu button and sidebar. The current 900 px split is retired. Breakpoints are evaluated with container queries on the shell where practical so large text forces the simpler layout.

### 3.3 Workspace geometry

The question workspace is a grid: header (auto), body (`minmax(0, 1fr)`, the one scroll container), dock (auto). The dock is a real layout row, not a sticky element hoping to stick. Its measured height is reserved; the safe-area inset is added exactly once (to the dock). `scroll-padding` uses the real header and dock heights so focused controls and errors are never hidden.

Virtual keyboard: the editor sits above the keyboard with Send and Collapse reachable. Use `100dvh` plus a feature-detected `visualViewport` adjustment for the dock's bottom offset; never infer the keyboard from height alone (page zoom changes it too). Preserve pinch zoom of the page outside the file stage. Rotation keeps the draft, the active file and its normalised zoom/pan.

### 3.4 Desktop, iPad and the installed app

The owner wants Decisions usable on iPad, iPhone and desktop as an installed app. The PWA already installs; this release makes it a good desktop citizen without a native shell:

- Manifest: remove `orientation: portrait-primary`; add `display_override: ["window-controls-overlay", "standalone"]`; `background_color` and `theme_color` from the Daintree grid; add `launch_handler: { client_mode: "focus-existing" }` so notification clicks reuse the open window.
- Window controls overlay: when active (Chromium desktop installs), the app header becomes the title bar (`app-region: drag` on empty header space, `no-drag` on controls) and respects `env(titlebar-area-*)`.
- Install help covers desktop: Chrome/Edge "Install app", Safari on macOS "Add to Dock", plus the existing iOS and Android steps.
- Desktop keyboard: modifier shortcuts only, never single letters (both specs forbid global single-key traps). `Ctrl/⌘ + Enter` sends when Send is enabled (same validation, same confirmations); `Ctrl/⌘ + Shift + Space` starts or stops dictation; `Ctrl/⌘ + K` opens the navigator and focuses search; `Escape` closes one layer. Each shortcut is shown in its control's tooltip and in a Keyboard shortcuts sheet in Settings › About & help.
- A native wrapper is **later**.

## 4. The question workspace

### 4.1 Anatomy, top to bottom

| Zone          | Contents                                                                    | Behaviour                                                                                                                         |
| ------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Header        | Back; project (primary) and computer (secondary); compact status; more menu | Stays visible. After the question heading scrolls away it shows a one-line excerpt that scrolls back to the question when tapped. |
| Question      | The full original wording as the page's `h1`                                | Plain safe text, selectable, never summarised or truncated by default.                                                            |
| Status line   | One principal state plus only useful extras                                 | For example "Needs you · Human decision required · Due in 2 h".                                                                   |
| Files         | Count, active preview, label, index, thumbnail strip                        | Immediately after the question when attachments exist; omitted entirely when there are none.                                      |
| Context       | "Context from the agent" disclosure with a one-line literal preview         | Expands inline; never inserts itself above the question after loading.                                                            |
| Decision area | Options (radio cards) or the current answer, model answer or closed state   | Depends on kind and lifecycle.                                                                                                    |
| Record        | Delivery progress and question details                                      | Collapsed under clear labels; exact timestamps, IDs and fingerprints live in Question details.                                    |
| Dock          | All Q&A, the draft, Dictate, and the Send row                               | Always visible in an answerable question.                                                                                         |

On a 390 × 844 phone with a short question and images, the first screen shows the question, a useful preview and the complete dock. Do not spend the top third on branding, multiple timestamps and repeated badges.

### 4.2 Status vocabulary

One principal status per question: **Needs you**, **Model answer · review**, **Answered**, **Expired**, **Withdrawn**, plus **Delivery needs attention** when relevant. Deadlines read "Due in 2 h", then "Due in 12 min", in the warning hue only inside 24 hours; nothing flashes. Human-required questions say "Human decision required" next to the choice. An answered question shows the actual answer and its author instead of more chips.

**Agent state** is a second, separate vocabulary: what Daintree last observed in the asking pane, from its pane snapshot (`docs/protocol.md` section 18), never a claim about the question. The words are Daintree's own: **Working**, **Waiting**, **Directing**, **Idle**, **Finished** (for `completed`) and **Exited**; a state this version does not know shows nothing. Colour sits on a small dot only: Daintree's working green, its waiting amber, and secondary text for the rest. A snapshot the relay received over a minute ago (or a refresh nobody answered) is stale: the dot becomes a hollow neutral ring, the word steps down to secondary text at the same weight, and where there is room its age follows ("Waiting · 4 min ago"). No snapshot, sharing turned off or a closed question shows nothing, so the row looks as it does without the feature. A mark that would appear on or leave a Home row waits while the person is touching or scrolling, since it changes the row's height; a mark already there updates at once. In Recent only fresh states show, in a fixed slot at the row's end; which rows have a slot is held while the sidebar is in use (as its order is), so a state that goes stale, stops being shared or closes meanwhile leaves its slot empty until the sidebar is next opened, and a new state waits for that opening. `app/src/domain/agentState.ts` holds the words and rules, for every surface that shows agent state.

### 4.3 More menu

Question details, Copy question, Copy question ID, View activity, and Change answer when legal. Never a non-functional Delete, Reopen, Cancel question or Revoke.

### 4.4 Opening states

| State                 | Treatment                                                                         |
| --------------------- | --------------------------------------------------------------------------------- |
| Saved locally         | Show immediately; refresh quietly                                                 |
| Not yet fetched       | Skeleton for question and file area; dock reserved                                |
| Over 5 s              | "Still loading this question…" with Retry                                         |
| Offline and not saved | "This question is not saved on this device."                                      |
| Not found after sync  | "This question is no longer available."                                           |
| Old key               | "This device cannot read this earlier question." with the existing explanation    |
| Signature failure     | "Could not verify this question." Diagnostic detail available; no answer controls |

A change to the question while answering stops capture, keeps the text, locks Send and shows "This question changed. Your draft is saved; review the update before sending." **Review update** clears the old selection and rebinds the draft to the new revision. Delivery and connection changes never reset the draft or the file view.

## 5. Files

### 5.1 One sequence

All attachments form one stable sequence in signed order. Before/After roles label items in that sequence; they never pull files out of it. The active index is shared by the inline gallery, the viewer, the thumbnail strip and the All files grid.

Header "Files · 4" with **All files** at the right. Below: the active file in a stable stage (`object-fit: contain`, never cropped; height 240–320 px on a phone, capped for tall screenshots), its label ("Before", "After", the supplied caption, or "Image 3"; never an invented filename) and "2 of 4". A thumbnail strip shows the whole set with the active thumbnail marked by a 2 px `text-primary` edge and its accessible selected state (tablist pattern, manual activation). One attachment: no pagination dots or strip. No attachments: no gallery.

### 5.2 Loading and failure

Render the count and placeholders immediately, load the active file first, then its neighbours, with bounded concurrency. Tiles keep their size through every state: Preparing preview…, ready, "Could not load this file" + Retry, "This file is no longer available", "File could not be verified" (no preview, no Open).

### 5.3 Evidence review

Both specs ask for this and it is required for approvals:

- **Verified:** the exact bytes decrypted, validated and decoded.
- **Presented:** the file was actually displayed as the active inline preview, in the viewer, or in a usable comparison pane. A prefetched file or a thumbnail does not count.
- Send decision is available once every required file is verified and presented. While not, the hint reads "Review the remaining 2 files" and tapping it selects the first unreviewed file. No checkboxes, timers or forced fullscreen.
- The digests of the presented files are what Send acknowledges. A new revision or changed digest resets presentation.

### 5.4 The viewer

Tapping the active preview (or Enlarge) opens the viewer as a **mode of the workspace**, not a modal that makes the dock inert. Top: Close, a short question identity with a **Question** button that reveals the full text in a sheet, the file label and "2 of 4". Centre: the darkest stage with the largest practical area. Near the stage: Previous / Next, zoom −/+ and Fit. Bottom: **the same dock**, including Stop while recording.

Gesture ownership (custom zoom and pan only in the viewer and comparison; inline previews stay fitted and the page scrolls normally):

| Input                        | At Fit                                          | Zoomed                                   |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------- |
| Horizontal swipe in stage    | Previous / next file (one per gesture, no wrap) | Pan; never changes file, even at an edge |
| Vertical drag in stage       | Nothing (no dismiss)                            | Pan                                      |
| Pinch                        | Zoom around the midpoint                        | Continue                                 |
| Double-tap / double-click    | Zoom 2.5× into that point                       | Back to Fit                              |
| Arrow keys (stage focused)   | Left/Right change file                          | Pan                                      |
| `+` `-` `0` (viewer focused) | Zoom in, out, Fit                               | Same                                     |

Thresholds to tune on devices: 10 px slop, horizontal intent > 1.3× vertical, commit at one fifth of the stage width or a fast fling. A two-pointer gesture owns input until every pointer lifts. A completed drag suppresses the following click. Zoom is a multiple of Fit up to 8×. Pan is bounded. Zoom and pan are remembered per file for the session and reset when bytes change. A visible **Move** control reveals directional pan buttons so panning never requires dragging.

Close, Escape and Back leave the viewer before leaving the question and restore the active thumbnail, the scroll anchor and focus to the opener. Recording continues across viewer open, close, swipe, zoom and compare.

### 5.5 Before and after

On phones, one large image at a time with a full-width **Before | After** segmented switch, plus **Compare** to enter comparison mode. On wide screens, comparison shows side-by-side panes with fixed labels and an optional **Link zoom** toggle. A pair is auto-selected only when exactly one Before and one After exist. Images of different dimensions are never stretched into false alignment. A reveal slider is later.

### 5.6 Open and download

**Enlarge** inspects inside Decisions; **Open** hands the verified original to the browser (new tab with a Blob URL) and **Download** saves it with an honest name (`decision-image-3.png`). Both are in the file's menu. The first time, explain once: "Opening this file makes a readable copy available outside Decisions." If recording, Open first stops and saves dictation, then asks for a fresh tap ("Open file now"). Never export a file that failed verification. Non-image file types are **later** (they need a protocol change).

## 6. The answer dock

### 6.1 Layout

**Resolved:** the specs split on the bottom row. Spec A: All Q&A · text affordance · Dictate. Spec B: All Q&A · Dictate (centre, largest) · Type. Both put All Q&A at the left, both make Dictate a large target, and both need a place for the draft. The consolidated row merges Spec B's Type button into Spec A's text affordance and keeps Dictate at the right edge, where a right thumb rests and where it never moves:

| Slot                            | Control                                                                     | Behaviour                                                           |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Left (about 64–72 px)           | **All Q&A** icon plus label, with the needs-you count                       | Opens the navigator. While recording it reads **Stop & questions**. |
| Centre (flexible)               | The draft field: "Type an answer" / "Add a note" / a two-line draft preview | Tapping opens the editor and focuses it (this is "Type").           |
| Right (56 px minimum, circular) | **Dictate** (mic) → **Stop** (stop square) in the same place                | Starts or stops capture. Never sends.                               |

A **summary row** appears above the bottom row only when there is something to commit: the selected option and/or the first line of the note at the left, and **Send answer** / **Send decision** / **Send correction** at the right (contrast button). Send never occupies the Dictate slot, so a double tap on Stop can never send. When the question forbids text, the centre becomes **Choose an option**, which scrolls to (or opens) the options, and Dictate is hidden rather than shown disabled.

The dock is opaque on Bondi and material on Daintree, with a top hairline and `shadow-floating`. Labels stay visible at every text size; at large text it may wrap to two rows instead of clipping.

### 6.2 State table

| State                   | Bottom row                                               | Summary row / status                                | Send                                |
| ----------------------- | -------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| Empty, text allowed     | All Q&A · Type an answer · Dictate                       | none                                                | absent                              |
| Choice, nothing chosen  | All Q&A · Add a note (if allowed) · Dictate              | "Choose an option"                                  | absent                              |
| Choice selected         | same                                                     | "Selected: Keep Canopy"                             | Send decision (subject to evidence) |
| Draft text              | All Q&A · draft preview · Dictate                        | "Saved on this device" (quiet)                      | Send answer                         |
| Connecting              | All Q&A · "Starting microphone…" · Cancel                | —                                                   | disabled                            |
| Recording               | Stop & questions · live transcript (last 2 lines) · Stop | "Recording · 00:24" with the level ring             | disabled                            |
| Finishing               | All Q&A · transcript · progress                          | "Finishing your words…"                             | disabled                            |
| Cleaning                | All Q&A · raw draft · Dictate                            | "Tidying wording… · Use original wording"           | disabled until applied or bypassed  |
| Sent, queued or sending | All Q&A · your answer summary                            | "Queued on this device" / "Sending…"                | none (no second Send)               |
| Committed               | All Q&A · View answer · **Next question**                | Delivery stage                                      | Change answer where legal           |
| Conflict                | All Q&A · **Review change**                              | The specific reason; draft kept                     | disabled                            |
| Expired or withdrawn    | All Q&A · Next question                                  | "This question expired" / "Withdrawn by your agent" | none                                |
| Unreadable, unverified  | All Q&A                                                  | The trust explanation                               | none                                |

Dictation availability changes only the Dictate slot: unconfigured relay opens "Dictation isn't set up for this relay" with Type; offline shows "Dictation needs a connection". Never a silently disabled icon.

### 6.3 The editor

Tapping the draft field opens the editor growing upward from the dock: 3–5 lines, growing to about a third of the visible height, then scrolling, with **Expand** into a full-height focused editor that keeps a compact question header and **Done**. It is the same draft in every view; there is never a second editor instance. Return inserts a newline. Closing saves and collapses. The editor never opens or focuses itself because dictation produced text (that would raise the keyboard over the evidence).

### 6.4 Choice tray

Two or three short options appear as full-width radio cards in the decision area of the page, and a **Choose an option** sheet lists all options with descriptions when they are long or many. Selecting closes the sheet (when descriptions were fully visible) and returns a summary to the dock. Neither sends. Mixed questions offer **Clear choice** when text replaces the choice.

## 7. Composing and validating

| Kind       | Required                                      | Text                    | Send label      |
| ---------- | --------------------------------------------- | ----------------------- | --------------- |
| Text       | Non-empty valid text                          | Typed or dictated       | Send answer     |
| Choice     | One option                                    | Note when allowed       | Send answer     |
| Approval   | One option plus every required file presented | Note when allowed       | Send decision   |
| Mixed      | An option or non-empty text                   | Supplements or replaces | Send answer     |
| Correction | A changed answer plus a reason                | Kind-specific           | Send correction |

Validation speaks only when it can help: next to Send, as one short reason ("Choose an option", "Write an answer", "Review the remaining 2 files", "Add a reason for the change", "Review the updated question"). Use the protocol's real limits: answer text is limited in UTF-8 bytes (measure bytes, not characters), reasons to 2,000 characters. Over-limit text is kept and the overage is stated; nothing is truncated. Everything is validated again at the moment of Send.

## 8. Drafts

A draft is keyed by question, reviewed revision and mode, and holds the selected options, text, correction reason, selection/caret, and any raw/cleaned dictation variants needed to restore "Use original wording". Drafts are encrypted at rest in the existing `drafts` store (schema-versioned; migrate the current rows conservatively). **Correction drafts persist too** (Spec A and Spec B both flag that they do not today); reopening Change answer resumes "Unsent correction". **Cancel** closes a correction while keeping its draft; **Discard correction** is the explicit loss action.

Save on a 400 ms debounce plus explicit flushes at Stop, navigation, collapse and Send. Feedback is quiet: "Saving…" only if a write takes long enough to notice, "Saved on this device", "Could not save draft" (persistent, with Retry and Copy), "Draft restored" once on return, "Draft from an earlier version of this question" when the revision moved. Screen readers hear failures and restoration, never each autosave. **Clear draft** lives in the editor menu with Undo.

## 9. Dictation

Dictation is an input method for the current draft field. It never starts on its own (opening a question, focusing a field, restoring a draft or returning from the background never starts the mic).

### 9.1 Start

1. First tap ever: a compact disclosure naming the speech provider and the cleanup provider, explaining that audio goes through the relay to them and is not end-to-end encrypted, with **Enable and start dictation** and **Keep typing**. Consent is recorded only by that button.
2. The browser permission prompt follows that tap. Show "Allow microphone access to continue" with Cancel. A permission that resolves after Cancel closes its stream immediately.
3. **Daintree parity:** open the microphone in parallel with the relay session and queue captured frames (up to 15 s) until the provider is ready, instead of dropping everything said while connecting. Show "Starting microphone…" until the microphone is delivering real audio; only then show Recording. If no audio level arrives within 3 s, say "No sound from your microphone" with help, without stopping.

### 9.2 While recording

- The Dictate slot becomes **Stop** (a stop square on a contrast fill) wrapped in Daintree's **orbit ring**: an accent arc whose speed, opacity and thickness follow the voice level (port of `VoiceInputButton.tsx`'s orbit, `requestAnimationFrame` driven, still under reduced motion). The words "Recording · 00:24" are always present; the ring is never the only signal.
- **Resolved:** Spec A coloured recording red; Daintree uses the accent for live capture and keeps red for errors. Daintree's convention wins (red would read as an error state in this palette).
- Finalized words are written into the draft **at the caret position captured when recording started** (Daintree parity; Spec A's target behaviour) as they arrive, and checkpointed to encrypted draft storage. Interim words show in the dock's transcript line in `text-secondary` italic; they are never written into the draft. **View transcript** expands the full passage.
- Same-question file gestures, viewer and comparison keep working; Stop stays reachable everywhere.
- Spoken "new line" and "new paragraph" become line breaks (Daintree's formatting commands). No spoken command ever selects an option, sends, deletes or changes trust.
- The relay's five-minute session cap is shown as a warning 15 s before it ("Stopping in 15 s"), then the passage is stopped and saved.

### 9.3 Stop and cleanup

1. Stop releases the microphone immediately, then waits a bounded time (5 s) for final text: "Finishing your words…".
2. The raw passage is in the draft before cleanup starts.
3. Cleanup (when enabled) replaces **only that passage** and only if it is still untouched and the draft generation matches. If the user edits first, the edit wins.
4. **Use original wording** is offered while cleaning and afterwards, for as long as the cleaned passage is unchanged. **Resolved:** Spec A said "Use original wording", Spec B "Keep raw text", the app "Use what I said"; Spec A's label is the clearest and wins.
5. After cleanup, changed words are underlined for 5 s (Daintree's correction review); tapping one shows "Heard “x”". The existing unsure-words review becomes a compact **Review 2 words** affordance in the summary row that opens the editor at the first span with original and suggested wording.
6. Cleanup failure keeps the raw text: "Kept your original wording."

### 9.4 Cancel

A **Discard** control in the expanded transcript cancels the passage and removes its text from the draft (with Undo). On desktop, Escape twice within 4 s does the same, with "Press Escape again to discard dictation" (Daintree parity).

### 9.5 Navigation during dictation

| Action                                            | Result                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swipe files, enlarge, zoom, compare, close viewer | Recording continues                                                                                                                                      |
| Open original                                     | Stop and save first, then "Open file now"                                                                                                                |
| Stop & questions                                  | Stop immediately, open the navigator; choosing another question waits for the raw checkpoint; late cleanup can only land in its original untouched draft |
| History or Settings                               | Stop, finalize and save to the original question                                                                                                         |
| App hidden, device locked, connection lost        | Stop; keep text; never restart automatically                                                                                                             |
| Question changes or expires                       | Stop; keep draft; lock Send                                                                                                                              |
| Send tapped while recording                       | Not possible: Send is disabled until capture has settled. No "send after stopping"                                                                       |

### 9.6 Messages

| Condition            | Copy                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| Offline              | Dictation needs a connection. You can keep typing.                                   |
| Not configured       | Dictation isn't set up for this relay.                                               |
| Permission denied    | Microphone access is blocked. (with platform help)                                   |
| No microphone        | No microphone is available.                                                          |
| Device failure       | The microphone couldn't start. Retry                                                 |
| Connection lost      | Recording stopped when the connection dropped. Your words so far are in your answer. |
| Nothing captured     | No words were captured. Try again                                                    |
| Final text timed out | Kept the words received so far. Check the ending.                                    |
| Cleanup failed       | Kept your original wording.                                                          |
| Storage failed       | Your text is still here but couldn't be saved on this device. Retry · Copy           |

Tap-to-start/tap-to-stop is the default; hold-to-talk stays a preference and handles release outside the button, pointer cancel and keyboard activation; its release finishes the passage, never sends. **Resolved:** Daintree's default is tap-or-hold; both specs voted for plain tap as the default with hold optional, and that wins.

## 10. Sending and delivery

At Send: re-validate (status, revision, trust, kind, byte limits, evidence); require capture settled and cleanup applied or bypassed; snapshot the exact action (kind, question, revision, selection, text, reason, acknowledged digests, confirmed proxy action); disable repeat; seal and enqueue durably; only then clear the draft and show the queued state; invalidate outstanding cleanup and autosave generations so nothing can recreate the cleared draft. Retries reuse the same request and idempotency key (the existing outbox already does).

| Evidence                    | Label                             |
| --------------------------- | --------------------------------- |
| Outbox only                 | Queued on this device             |
| In flight                   | Sending…                          |
| Relay committed             | Saved on your relay               |
| Desktop receipt             | Received by your computer         |
| Terminal receipt            | Delivered to the agent's terminal |
| Target unavailable          | Needs attention on your computer  |
| Unknown outcome             | Delivery couldn't be confirmed    |
| Conflict, expiry, rejection | Your answer was not applied       |

The dock shows the current stage; tapping it expands the stepper (done steps carry a check glyph and words). Never claim the agent finished or acted. After Send the answer stays on screen as a read-only card and the dock offers **Next question** (explicit, never automatic; next in Needs you order, skipping questions with a pending local answer; "No more questions need you" when empty).

Conflict: show **Current answer** (author, time) and **Your unsent answer** with **Copy text**, **Use as correction** (deliberate, needs a reason) and **Dismiss**. Expiry keeps and copies the draft but offers no Send.

## 11. Model answers and corrections

Model answer presentation: "Model answer · review", the option and text, the model and the model-reported confidence (labelled as such), the rationale and references behind a disclosure, with **Confirm answer** (contrast) and **Change answer**. Confirming records an endorsement and never shows a delivery animation (the `confirm-proxy` action is not delivered). After confirming: "Model answer, confirmed by you · 14:02". Human-required questions cannot be satisfied by a model answer.

Change answer opens correction mode in the workspace: the current answer read-only at the top, the replacement choice/text, and **Why are you changing it?** (required). The dock's Dictate targets the focused field and says so ("Dictating your reason"); switching fields while recording stops first. Send correction shows a compact before → after review with the reason and "Your agent may already have acted on the earlier answer. This sends a correction; it doesn't undo completed work." and a final **Send correction**. An unchanged choice with no changed text cannot be sent, and the hint says why.

## 12. Questions & answers navigator

One navigation model, two presentations: Home's list, and a sheet titled **Questions & answers** (opened from All Q&A or Ctrl/⌘ + K; full height on phones, from the left from 720 px). Same counts, same selection, same filters.

- **Sections:** one list of every question, with no scope control: **Needs you** first (answers whose delivery needs attention on a computer, then answerable questions; when empty it says so in its place), then **Waiting to send** (answers still in this device's outbox), **Model answers to review**, and everything else by most recent activity under Today, Yesterday and dates. A long Needs you links down to the answers waiting to send and the model answers to review. **Resolved (issue #41):** the owner asked for the list to be as efficient as a chat list; sections replace the Needs you / Model answers / All segments, so nothing is a tap away and the top of the screen is the list.
- **Search** (local over decrypted content, 150–250 ms debounce) and separate **Project** and **Computer** filters in one **Filter** sheet, offered only when questions come from more than one of either. On phones and tablets search and filter are round buttons on the menu button's row (search opens into a field there); in the wide column and the sheet they sit above the list. Active filters show as removable chips; the sheet's **Any computer** / **Any project** clears one.
- **Sort:** Needs you by soonest deadline then oldest (or newest first); everything else by most recent activity. Rows never reshuffle under the finger: new questions show "2 new questions" to refresh deliberately.
- **Row:** the state glyph; the question in one line, two at most, with its relative time at the right; the answer in force as one line ("You: …" / "Model: …"), or why it closed without one; project · computer; and only the chips that call for action: a due time inside three days, Queued or Sending…, Delivery issue. When the asking desktop shares pane snapshots, the agent's observed state (4.2) ends that line in a slot as wide as its longest word, so going stale or changing word never adds a line. The whole row opens the question. The current question is highlighted (neutral raised fill) and scrolled into view. **Resolved (issue #41):** file counts, Draft and Review chips and the status word leave the row (the section and the glyph carry the status); a week-out default expiry is not shown.
- History and Settings are reachable from the navigator's header on phones.
- Empty states: "No questions yet." · "Nothing needs you right now." (in Needs you's place) · "No questions match these filters." (Clear filters) · "No matches in questions saved on this device." · offline "You're offline. New questions will appear when you reconnect." · syncing "Checking for questions…" (never an all-clear while syncing).
- Filters and the Needs you order persist per device; search persists for the session.
- From 1100 px Home is a list-detail split: the list keeps its own column beside the sidebar, and the pane beside it holds the chosen question, or a calm "Choose a question" until one is chosen.

## 13. History

History answers "what did I decide, why, and what changed?" It is not a second inbox.

- Default **Decisions**: human answers, confirmed model answers, expired and withdrawn. **All activity** adds unreviewed model answers (still labelled Review).
- Rows: project · computer, question excerpt, **the effective answer** with author, decision time, "Changed 2 times" when corrected, delivery issue if any. Grouped Today, Yesterday, then dates.
- Search covers question, context, origin, option labels, current and earlier answers and correction reasons. A hit in an earlier answer says "Matched an earlier answer". Coverage line: "Searching questions saved on this device · Synced 14:32" (replacing the transport-based warning).
- Opening a record shows the question workspace in read-only mode with an **Activity** timeline: asked, model answer, human answer, confirmation, corrections (old → new with reason), expiry or withdrawal, and delivery milestones (collapsed). Back returns to the same query and row.

## 14. Settings

An index of rows (label, current value, chevron, 48 px), each opening a focused section; returning preserves scroll; Settings never disturbs an open question's draft.

| Section                 | Summary                   | Contents                                                                                                                             |
| ----------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Appearance              | Match device              | Match device / Bondi / Daintree with live previews (each shows its hero image); reduced motion follows the system                    |
| Dictation               | Tap to start · Cleanup on | Consent, mode, speech provider and cleanup (only configured ones), microphone status, **Test microphone** (level meter, never sends) |
| Notifications           | On for this device        | Enable, Test, Turn off, blocked and install-required states                                                                          |
| Quiet hours & reminders | 22:00–07:00               | Times with the time zone, reminder schedule, model-review reminders; "Applies to every device paired to this relay"                  |
| Devices                 | This phone + 2 computers  | The Devices screen                                                                                                                   |
| Privacy & security      | Paired to your relay      | Data flow, recovery, **Unpair this device**                                                                                          |
| About & help            | Version 0.4.0             | Version, update, install help, keyboard shortcuts                                                                                    |

Two save models, stated in each section: local preferences apply immediately; relay settings (quiet hours, reminders) use an explicit **Save changes** that stays visible while dirty, with Save / Discard / Keep editing when leaving dirty, and failures that keep the edits. Quiet hours with equal start and end are rejected with an explanation. Notification Test says "Test notification sent", never "received". Unpair lists exactly what is erased, including the count of unsent answers and drafts.

## 15. Devices, pairing and installation

Devices: groups This device, Computers, Other paired devices, Revoked. Rows show label, role, trust and "Last seen 12 min ago" (never "Online" without evidence); tapping shows details and the fingerprint with Copy. Phone-side revoke stays desktop-only.

Unpaired welcome: the mark, one sentence, **Scan pairing code** (primary), **Paste pairing link**, then install help and privacy. Pairing keeps its current flow, restyled: the six-digit code large and grouped, read digit by digit to screen readers, "Check that this matches your computer", expiry and Cancel. Revoked: a locked screen with "This device is no longer paired" and Pair again; nothing decrypted stays visible behind it.

## 16. Offline, sync and updates

- Connection lives in the sidebar's foot: a quiet dot and the last sync in normal operation; a tinted block for offline or long reconnects. While the sidebar is closed, the menu button carries a dot for offline, a long reconnect or an update. Polling is not a failure; a WebSocket reconnect is not data loss.
- Offline: saved questions readable; drafts editable; Send queues ("Queued on this device. It will send when you're back online."); dictation unavailable with a reason; relay settings and pairing need a connection.
- New questions arriving while reading or dictating update counts and add a quiet affordance; they never replace the open question, scroll it or interrupt recording.
- Updates: a quiet "Update available" row (the sidebar's foot and About) replaces the banner. **Restart to update** first stops capture, flushes drafts and confirms the outbox is durable, then reloads to the same route and draft. Never reload during capture.
- Unpair and revocation stop capture, sync, retries, file loads and cleanup; revoke object URLs; and guard every late async result by session generation so nothing repopulates the screen.

## 17. Back, focus and keyboard

- Back closes the topmost layer only: menu or confirmation → sheet (choice, All files, editor, Question text) → viewer or comparison → navigator → the question (to its origin: Questions, History or a search) → browser history. A question opened directly goes Back to Questions.
- Opening a page focuses its heading; a sheet or dialog takes focus, contains Tab, and returns focus to its trigger. Returning to a list restores focus to the originating row.
- Changing a file announces "After screenshot, file 2 of 4" without moving focus.
- Never auto-focus a textarea because text arrived.
- Keyboard map: Tab order matches visual order; Escape closes one layer; Enter in the editor is a newline; radio groups use arrows and never submit; viewer keys as in 5.4; the modifier shortcuts in 3.4.

## 18. Accessibility

Target WCAG 2.2 AA with manual checks. The question is the `h1`; the dock is a labelled region whose order matches its visual order; options use radio semantics; every file has its caption or an honest role label (no invented descriptions); the active file is announced; recording state is in words; interim dictation is not announced (start, stop, interruption and readiness are); validation is next to its control and programmatically associated; nothing essential depends on hover, colour, a toast, or precise dragging. 200% text and 320 px reflow keep All Q&A, Dictate and Send reachable. Focus rings are 2 px `--theme-focus-ring` outlines with offset, visible on every surface. Keep `prefers-contrast: more` and `forced-colors: active` handling (status glyphs gain outlines; shadows are replaced by borders).

## 19. Copy

Sentence case; a single "…" character; no exclamation marks; no full stop on short fragments; plain words over protocol terms (no epoch, envelope, injection, socket). Core lines: "Type an answer or dictate." · "Anything the agent should know about your choice?" · "Recording · 00:24" · "Review your answer before sending." · "Tidying wording… · Use original wording" · "Queued on this device. It will send when you're back online." · "Saved on your relay. Waiting for your computer." · "Review the remaining 2 files." · "This file is no longer available." · "Couldn't copy. Select the text to copy it."

## 20. Out of scope (later)

Non-image attachments (PDF, text, code, media) and filename metadata; persisted offline image cache; phone-side revoke, reopen, cancel or delete; multi-select answers; editing a queued answer; cross-device drafts; reveal-slider comparison; spoken editing beyond line breaks; settings compare-and-swap; a native desktop wrapper. None of these appear as controls.

## 21. Build plan

1. **Foundation:** generated Daintree/Bondi tokens, CSS split into layers (`tokens`, `base`, `primitives`, per-area files), primitives (buttons, inputs, option cards, chips, segmented control, sheet, dialog, menu, toast), the shell (tab bar, rail, header with connection status and window-controls overlay), theme preference migration, manifest, icons recoloured, self-hosted JetBrains Mono.
2. **Workspace, dock, composer and dictation:** the grid workspace, header, status line, decision area, dock with its full state table, editor, choice sheet, durable answer and correction drafts, the capture owner that outlives views, live insertion at the caret, early capture, orbit ring, cleanup review, Send gating, delivery stepper, conflicts, model answers and corrections.
3. **Files:** the canonical sequence, inline gallery, viewer mode with the dock, gesture recogniser, compare, Open/Download, presentation-based evidence review.
4. **Lists:** navigator (sheet and rail), Questions screen, History with timeline and search.
5. **Settings and onboarding:** settings index and sections, Devices, welcome and pairing, install help (including desktop), privacy, revoked.
6. **Integration and review:** origin-aware Back and restoration, safe update, accessibility pass, Daintree-parity review against real Daintree screenshots, adversarial code review, updated screenshot suite and docs.

Each stage is checked with the real-system screenshot suite (`e2e/tests/screenshots.test.ts`: real relay, real desktop client, real paired PWA), at 390 × 844 and 1280 × 820 in both themes, and reviewed against this guide before the next.

## 22. Acceptance (abridged)

The full scenario lists in both source specs remain the test plan; these are the ones that must pass before release:

- A 390 × 844 approval question shows the question, a useful preview, All Q&A, the draft field and Dictate without scrolling.
- Every image is reachable inline and in the viewer; a swipe at Fit changes one file; the same swipe zoomed only pans; a pinch tail never changes file.
- Recording continues while swiping, zooming and comparing; Stop is always visible; two fast taps on Stop never send; Send is unavailable while capturing or finishing.
- Words spoken while "Starting microphone…" appear in the transcript.
- Cleanup never overwrites an edit; Use original wording beats a late cleanup.
- Stop & questions then choosing another question leaves the raw words in the first question's draft and nothing in the second.
- Answer and correction drafts (with reason) survive leaving and returning, and app restart.
- Approval Send is blocked until every image has been presented; prefetch alone does not unblock it.
- Queued offline shows "Queued on this device" and never a relay or terminal claim.
- Another device answering first shows both answers and offers Use as correction.
- History search finds text in an earlier correction and labels it.
- Back from a question opened through filtered History restores the query, filters and row.
- Both themes pass AA contrast for text and 3:1 for control boundaries on every surface they use; the focus ring is visible everywhere.
- Reduced motion removes all movement without losing any state signal.
- On desktop (1280 × 820) the sidebar column and workspace coexist, the dock belongs to the workspace column, and the shortcuts in 3.4 work.
- The installed app is no longer locked to portrait.
