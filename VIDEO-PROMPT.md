# Prompt — Veyra product film

> Hand this file to a video-generation agent. It is self-contained: it carries the
> verified product facts, the proven production route, and the traps that were hit
> while proving it. Everything under **Verified facts** was checked against the
> repository and the host; everything under **Do not claim** is a boundary the film
> must respect.

---

## The task

Produce a **60–75 second product film** for **Veyra**, a persistent engineering-memory
plugin for DeepSeek Harness.

Deliver:

| Artifact | Requirement |
| --- | --- |
| `film.mp4` | 1920×1080, 25 fps, H.264 (`yuv420p`), AAC audio track, `+faststart` |
| `film.srt` | Captions matching the narration, burned-in text also legible without audio |
| `frames/` | The stills actually used, at source resolution |
| `render.sh` | The exact script that rebuilds the film from the stills |

The film is **caption-driven and typography-led**. It must be fully understandable
with the sound off.

---

## Message

**One sentence:** Your agent paid to solve this problem once; Veyra is what makes
that payment survive the session.

**The arc:**

1. **The hole.** A coding agent's context window is a working set, not a store.
   Every session it re-derives the same root cause.
2. **The turn.** At the end of a turn that produced something durable, Veyra
   stores it. At the start of the next turn in the same workspace, it comes back.
3. **The mechanism.** Captured as a candidate → validated into derived knowledge
   → recalled when the situation matches again → a restated root cause merges
   instead of duplicating.
4. **The trust model.** Repository truth always wins. Memory is a claim to
   verify, never a fact to act on. `canonical` is reachable only through an
   explicit human action.
5. **The evidence.** State the measured result plainly and state what is not
   measured just as plainly. The honesty *is* the pitch.
6. **The close.** One install command. No daemon, no API keys, local SQLite.

**Tone:** quiet, precise, engineering-credible. No hype, no stock footage of
people typing, no glowing brains, no "AI-powered" language.

---

## Verified facts

These are the only product claims the film may make. Sources are in the repository.

- **Name:** Veyra. **What it is:** a plugin for DeepSeek Harness.
- **Package:** `@lovedolove/veyra`, version `0.6.0`.
- **Install, verbatim:** `dsh plugin --profile web add @lovedolove/veyra`
  (README.md:50). "Restart DSH. That is the whole setup."
- **Shape:** Local SQLite. Per-workspace isolation. No daemon. No API keys.
  Pure ESM. Node `>=22.12 <25`. Packed size ≈ **273 kB** (README.md:15).
- **Tagline, verbatim:** "Persistent engineering memory for coding agents."
  (README.md:5)
- **Test evidence:** `npm test` → **1173 passing, 0 failing**, 13 suites.
  Re-run and confirm; do not carry the number over unverified.
- **Authority ladder:** `candidate` (auto-captured, not auto-recalled) →
  `derived` (learned or explicitly remembered, auto-recalled) → `canonical`
  (explicitly promoted truth). Promotion to canonical requires a human.
- **The rule:** *repository truth wins*, in both directions. A memory that says
  the code does something is a claim to verify, not a fact to act on.
- **Real recall output** (from `examples/command-output.md`), safe to show
  verbatim on screen:

  ```
  - vey_19a60f100000_5e0a11c0ffee [project/derived] Serialize SQLite writes behind a mutex
  - vey_19a60f200000_0badc0de1234 [project/derived] Set busy_timeout on every connection
  - vey_19a60f300000_42cafe000001 [project/derived] Demo project test command
  ```

- **Real observatory output** exists as box-drawing ASCII
  (`examples/command-output.md`) — use it as a visual texture, not as a
  claim-bearing screen.

### Do not claim

The repository explicitly separates what is measured from what is not
(`docs/WHITEPAPER.md` §12.3–12.4, §13). The film must not:

- claim that an agent **with** Veyra completes real tasks faster or better —
  that paired experiment does not exist;
- quote a quantified auto-recall **noise rate** — noise was observed, no rate
  was measured;
- quote a paraphrase/retrieval **ceiling** — unmeasured without embeddings;
- imply cloud sync, a hosted service, embeddings, a reranker, or an LLM judge —
  retrieval is deterministic and local by design;
- imply the memory ever overrides the code, or that anything is auto-promoted
  to canonical;
- show a fabricated benchmark chart. There is none.

If a beat needs a number that is not in **Verified facts**, cut the number, not
the honesty.

---

## Production route — do not substitute

**Use HTML → stills → ffmpeg. Do not use a text-to-video model.**

Reason: the film's payload is legible terminal text, memory identifiers, and UI
detail. A text-to-video model renders that text as convincing-looking garbage.
A headless browser renders it as *actual text*, identically every time.

This route was executed end to end on the target host before this prompt was
written:

- A 1920×1080 frame renders from HTML in **0.7 s**.
- Two renders of the same HTML are **byte-identical** (verified by matching
  MD5 across runs) — the pipeline is deterministic, so a frame can be re-cut
  without drift.
- Three stills → crossfade → H.264 mp4 encodes correctly, **195 frames over
  7.8 s**.

### Rendering a still

```sh
/usr/bin/google-chrome --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1920,1080 \
  --virtual-time-budget=600 \
  --screenshot=frames/007.png file:///absolute/path/to/scene-007.html
```

Use `--virtual-time-budget` rather than a sleep: it lets fonts and layout settle
and then shoots, which is what makes the output deterministic.

### Encoding the film

```sh
ffmpeg -y -hide_banner -loglevel error \
  -i frames/001.png -i frames/002.png -i frames/003.png \
  -filter_complex "\
[0:v]scale=2400:-1,zoompan=z='min(zoom+0.0006,1.12)':d=75:s=1920x1080:fps=25,setsar=1[v0];\
[1:v]scale=2400:-1,zoompan=z='min(zoom+0.0006,1.12)':d=75:s=1920x1080:fps=25,setsar=1[v1];\
[2:v]scale=2400:-1,zoompan=z='min(zoom+0.0006,1.12)':d=75:s=1920x1080:fps=25,setsar=1[v2];\
[v0][v1]xfade=transition=fade:duration=0.6:offset=2.4[x1];\
[x1][v2]xfade=transition=fade:duration=0.6:offset=4.8[out]" \
  -map "[out]" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 25 \
  -movflags +faststart film.mp4
```

**Trap — this cost a full render cycle.** Feeding `-loop 1 -t 3 -i scene.png`
into `zoompan` makes `zoompan` emit `d` frames *per input frame*: 75 input
frames × `d=75` = **5625 frames / 229.8 s** for a scene that should last 3 s.
Pass each still as a **single-frame input** and let `zoompan`'s `d` generate the
duration. The corrected form above yields the intended length.

Check the result before moving on:

```sh
ffprobe -v error -show_entries format=duration,size \
  -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames \
  -of default=noprint_wrappers=1 film.mp4
```

Duration must equal `sum(scene durations) - sum(crossfade overlaps)`, within one
frame. If it is off by multiples, you hit the `zoompan` trap.

### Pin the fonts — do not rely on the default stack

The host has **only** these families: `Liberation Sans`, `Liberation Serif`,
`Liberation Mono`, `FreeMono`, `WenQuanYi Zen Hei Mono`, `Noto Color Emoji`.
There is **no Inter, no JetBrains Mono, no Fira Code, no SF Mono.**

The generic `ui-monospace` stack resolves to `WenQuanYi Zen Hei Mono` here. That
is still monospace and still legible, so it does not garble text — but it means
the typeface is *whatever the host happens to have*, and the same HTML renders
differently on another machine. Name the fonts explicitly:

```css
:root{
  --bg:#0a0f0c; --panel:#0d1410; --line:#1d2a22;
  --ink:#e8f0ea; --muted:#7f9188;
  --accent:#16a34a; --bright:#22c55e;
  --sans:"Liberation Sans",sans-serif;
  --mono:"Liberation Mono",monospace;
}
```

Set the font on `body` too, not only on components, so nothing silently falls
back. Verify by rendering one frame and *looking at it* before building the
whole film.

### Audio

There is **no TTS engine on this host** — no `espeak`, `espeak-ng`, `piper`,
`festival`, or `say`. A synthesized voiceover cannot be produced locally.

Therefore:

- The film must read completely as **typography + captions**.
- Ship `film.srt` and burn the key line of each beat into the frame itself.
- Leave the audio track **silent but present** (AAC) so the file is
  player-compatible.
- Write the narration into `film.srt` and into a `voiceover` slot the user can
  fill later with a real voice. Do not fake a voice with beeps, drones, or
  robotic cadences and call it narration.
- Music, if any, must be royalty-free, low, and mixed at −18 LUFS or quieter.

---

## Shot list

Scene lengths sum to **68 s**; with seven 0.6 s crossfades the finished film runs
**63.8 s**. The "Start" column is the cumulative start point of each scene on the
final timeline, so scene 8 begins at 1:02 and the film ends at 1:03.8 — inside the
60–75 s target.

| # | Start | Length | Beat | On screen |
| --- | --- | --- | --- | --- |
| 1 | 0:00 | 6 s | **The hole** | Black. Terminal text alone drifts in: `Session 1 — root cause found`. Holds. Then a hard cut to the same line, greyed: `Session 2 — root cause found. Again.` |
| 2 | 0:06 | 8 s | **Name the failure** | `A context window is a working set, not a store.` Fades up over the second grey line. Accent rule draws left→right. |
| 3 | 0:14 | 9 s | **The turn** | Title card: **Veyra** — `Persistent engineering memory for coding agents.` |
| 4 | 0:23 | 12 s | **Capture → validate → recall** | Three-step diagram drawn in type, not icons. Each step a monospace block: `candidate` → `derived` → recalled. Show the real `vey_` recall lines verbatim. |
| 5 | 0:35 | 9 s | **Merge, not duplicate** | Two near-identical records slide together and collapse into one. Caption: `A restated root cause merges.` |
| 6 | 0:44 | 10 s | **Trust model** | The ladder: `candidate` / `derived` / `canonical`, with the last one marked *explicit human action*. Caption: `Repository truth wins.` |
| 7 | 0:54 | 8 s | **Evidence, honestly** | `1173 tests. 13 suites. 0 failing.` — then, smaller, `Unproven: whether agents finish real tasks faster. That needs a paired experiment.` |
| 8 | 1:02 | 6 s | **Close** | The install command, verbatim, in mono. Under it: `Local SQLite · No daemon · No API keys · 273 kB`. Hold on black. |

Beat 7 is the film's credibility. Do not rush it and do not trim the unproven
line — the admission is the strongest claim in the piece.

---

## Visual system

- **Palette:** near-black green background `#0a0f0c`, panel `#0d1410`, hairline
  `#1d2a22`, ink `#e8f0ea`, muted `#7f9188`, accent `#16a34a`, bright `#22c55e`.
- **Type:** `Liberation Sans` for display, `Liberation Mono` for anything that is
  meant to be product output. Display sizes 96–120 px; body 32–38 px; mono
  captions 22–24 px with `0.08em` tracking.
- **Motion:** slow. A 6–12 % zoom over each scene (`zoompan` as above), 0.6 s
  crossfades, and text that fades rather than slides. Nothing bounces.
- **Texture:** one soft radial accent glow at 8–10 % opacity. No particles, no
  lens flares, no grid overlays.
- **Consistency:** the accent green means "this is real product output". Never
  use it for decoration.

---

## Acceptance criteria

The film is done when every line below is true:

1. `ffprobe` reports 1920×1080, 25 fps, H.264, `yuv420p`, an AAC track, and a
   duration within one frame of the shot-list arithmetic.
2. `npm test` in the repository still reports **1173 pass / 0 fail**; if it does
   not, the number in beat 7 is corrected to whatever is true.
3. Every product string on screen appears verbatim in this prompt's
   **Verified facts** section or in `examples/command-output.md`.
4. No claim from the **Do not claim** list appears anywhere in the film, the
   captions, or the narration.
5. The film is fully understandable with the audio muted.
6. `render.sh` rebuilds `film.mp4` from `frames/` and the rebuild passes check 1.
7. Fonts are explicitly named; rendering the same still twice produces
   byte-identical PNGs.

## Deliverable hygiene

Keep generated media **out of the published package**. `package.json`'s `files`
whitelist is `src`, `skills`, `client.js`, `cordis.patch.yml`, `LICENSE`,
`README.md`, `CHANGELOG.md`, `THIRD_PARTY.md` — a film placed beside those is
fine at the repo root because the whitelist excludes it, but never add video
assets under `src/` or `skills/`. Confirm with:

```sh
npm run pack:check
```

The tarball must stay at **51 files, ≈273 kB** (verified on `@lovedolove/veyra`
0.6.0: `package size 273.7 kB`, `total files 51`). Note that
`docs/WHITEPAPER.md` §12.3 still says "a valid 52-file tarball" — that line is out
of date; trust `npm run pack:check`, not the document. If the count moved, the
film put an asset in the wrong place.
