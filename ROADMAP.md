# Discord-PM Roadmap

## Vision

Transform Discord-PM from a passive standup recorder into an **active project manager** that facilitates meetings, tracks commitments, and surfaces project health — anchored by a **Discord Activity** that turns standups into a visual, interactive, GitHub-aware experience.

## What Exists Today

| Capability | How |
|---|---|
| Voice standup recording | `/standup start/stop` — per-speaker utterance detection via @discordjs/voice |
| Speech-to-text | Deepgram Nova-3 batch (primary), OpenAI Whisper (fallback), Replicate Whisper (fallback) |
| AI summarization | Claude extracts did / will-do / blockers per participant |
| GitHub issue review | `/review` — kanban-style navigator grouped by SDLC stage |
| Transcript persistence | SQLite + markdown export + password-protected web UI (Hono) |

## The Big Idea: Standup Activity

A **Discord Embedded Activity** that runs inside voice channels. Everyone in the call sees a shared interactive UI showing GitHub issues. Each participant takes the controls for their section. The recorder runs simultaneously, mapping speech to whichever issue is on screen. The result is an **issue-annotated standup transcript** — structured by issue, not just by time.

### Why an Activity

- The **UI is the facilitator** — no awkward text-channel spam or TTS needed initially
- Participants **drive their own section** — natural, not bot-imposed
- Speech-to-issue mapping is **automatic** (whatever's focused when someone talks)
- Produces a **10x richer artifact** than a flat transcript
- Builds directly on existing `/review` data + `/standup` recording

### What the Rich Transcript Looks Like

Instead of flat per-speaker text, each standup produces per-issue segments:

```
Bruno Pires — 3 issues discussed

  #142 Auth refactor [In Progress -> In Progress]
    "About 80% done, just need to finish the token refresh logic"
    -> Action: Finish token refresh (carried forward)

  #155 API caching [In Progress -> In Progress]
    "Haven't started yet, probably tomorrow"
    -> Action: Start API caching work

  #160 Login bug fix [In Review -> Done]
    "Oliver approved it this morning, merging now"
    -> Stage moved during standup
```

---

## Phases

### Phase 1: Crawl — Activity Shell + Visual Standup

**Goal:** Get a working Discord Activity that shows GitHub issues per participant and runs alongside voice recording. No AI facilitation yet — humans drive.

#### 1a. Activity Infrastructure
- [ ] Register app as an Activity in Discord Developer Portal
- [ ] Set up Embedded App SDK (OAuth2 flow, participant presence)
- [ ] Serve the Activity web app from the existing Hono server
- [ ] Basic client-side framework (lightweight — vanilla TS or Preact)
- [ ] Proxy route on Fly deployment for Activity iframe

#### 1b. Visual Standup UI
- [ ] Adapt `/review` GitHub data-fetching for Activity context
- [ ] Render participant list (derived from who's in the voice channel)
- [ ] Per-participant issue view grouped by SDLC stage (reuse existing stage logic)
- [ ] "Take controls" mechanic — active speaker clicks to own the view
- [ ] Issue focus/selection — click an issue to mark it as "being discussed"
- [ ] Navigation: done with my section -> next person

#### 1c. Session State Bridge
- [ ] Shared session state between Activity and recorder (in-memory, same process)
- [ ] Activity emits events: `issue-focused`, `speaker-changed`, `section-complete`
- [ ] Recorder tags utterances with current focused issue ID
- [ ] New transcript storage: utterance segments with `issue_id` + `speaker_id` + `timestamp`

#### 1d. Issue-Aware Transcript Output
- [ ] Extend SQLite schema for issue-tagged utterance segments
- [ ] New summarizer prompt: per-issue summary (what was said, decisions, next action)
- [ ] Updated web UI to render issue-structured transcripts
- [ ] Updated markdown export with issue-linked format

### Phase 2: Walk — Smart Facilitation

**Goal:** The bot starts helping. It surfaces context, tracks commitments, and nudges the meeting along.

#### 2a. Pre-Standup Context
- [ ] Before standup starts, Activity shows: issues updated since last standup, new bugs, PRs awaiting review
- [ ] Highlight issues where the assignee promised action in the previous standup ("you said you'd finish #142")

#### 2b. Action Item Tracking
- [ ] Extract "will_do" items as first-class entities linked to issues
- [ ] Carry forward across standups — surface unfulfilled commitments
- [ ] Persist action items in SQLite with status (open/done/stale)

#### 2c. Blocker Detection + Escalation
- [ ] Flag blockers that persist across 2+ standups
- [ ] Auto-post alerts to a configurable channel
- [ ] Optional: auto-create GitHub issue for persistent blockers

#### 2d. Live Activity Enhancements
- [ ] Real-time "who's speaking" indicator in the Activity UI (WebSocket from recorder)
- [ ] Suggested follow-up questions based on issue state (e.g., "This has been In Review for 5 days — any blockers?")
- [ ] Time-boxing: gentle visual nudge when someone's section runs long

### Phase 3: Run — The Bot Has a Voice

**Goal:** The bot speaks, reacts, and drives. Full conversational PM.

#### 3a. TTS Integration
- [ ] OpenAI TTS API or ElevenLabs for voice synthesis
- [ ] Audio playback into Discord voice channel via `AudioPlayer` + `createAudioResource`
- [ ] Bot narrates transitions: "Moving to Oliver's issues"

#### 3b. Streaming Transcription
- [ ] Replace batch Whisper with streaming transcription (Deepgram or AssemblyAI WebSocket)
- [ ] Sub-2-second latency from speech end to text available
- [ ] Tuned silence detection for conversational turn-taking

#### 3c. Conversational Facilitation Loop
- [ ] Claude-driven response generation: given agenda + transcript-so-far + latest utterance -> decide what to say
- [ ] Follow-up questions: "You mentioned a dependency on the design team — is that blocking you?"
- [ ] Meeting wrap-up: summarize decisions, confirm action items, announce next steps
- [ ] Natural language queries mid-meeting: "What did we say about #142 last time?"

#### 3d. Automated Digests
- [ ] Scheduled daily/weekly summary posted to channel (no command needed)
- [ ] Content: standups held, issues moved, open blockers, stale PRs, velocity trends
- [ ] Pulls from accumulated standup + GitHub data

---

## Technical Considerations

### Discord Activity SDK
- Activities run in an iframe — viewport constraints, limited API surface
- OAuth2 required for user identity within the Activity
- Shared state must be coordinated; all participants see the same app instance
- Worth prototyping the shell early to surface SDK quirks

### Session State Architecture
- Recorder and Activity run in the same Node process on Fly
- Simplest approach: in-memory session state object, no external pubsub
- If Activity needs real-time push (speaking indicators), add a WebSocket from Hono
- For Phase 1, polling or event-driven updates are sufficient

### Transcript Schema Evolution
- Current: single `transcript` text blob per standup
- Target: normalized `utterance_segments` table with `issue_id`, `speaker_id`, `start_time`, `end_time`, `text`
- Migration path: keep existing `transcript` column for backward compat, add new table alongside
- Summarizer shifts from "per-person" to "per-issue" prompt

### Multi-Speaker Edge Cases
- Two people talk at once: focused issue belongs to whoever "has controls"
- Someone talks without any issue focused: tagged as "general discussion"
- Issue focus changes mid-sentence: tag the full utterance to the issue that was focused when it started

---

## Open Questions

1. **Activity hosting**: Same Fly instance or separate? Same Hono server seems simplest but might need CORS/proxy work for the iframe.
2. **Standup configuration**: How does a standup "know" which repo/team to pull issues for? Extend the existing review config, or let users configure per-channel?
3. **Authentication**: The Activity needs GitHub data — does each user auth with GitHub, or does the bot's token suffice (as it does today)?
4. **Offline participants**: If someone is in voice but doesn't join the Activity, their speech still gets recorded but isn't issue-tagged. How to handle?
5. **Mobile**: Discord Activities on mobile have a smaller viewport and different interaction patterns. Design for desktop first, but keep mobile in mind.
