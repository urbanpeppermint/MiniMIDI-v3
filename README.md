# MiNiMIDI — Spectacles DJ Lens

**MiNiMIDI** is a **Snap Spectacles** experience built in **Lens Studio**: a compact **nine-pad MIDI deck** with **Lyria**-driven stems, **genre** kits, **BPM** control, **crossfader** mixing, a **spectrum ring** for pinch navigation and **theremin**-style voices, and an **equalizer** mesh whose look reacts to real pad playback.

This README summarizes what the project is, what we shipped in the current iteration, what we are proud of, where the rough edges are, and who contributed 3D design.

---

## What You Get

| Area | Behavior |
|------|------------|
| **Genres** | Five modes (e.g. Electronic, Hip Hop, Lofi Jazz, House, Rock) via `MidiControllerMenu` + `GenreInstrumentData`. |
| **Pads** | One **shared 9-pad grid** (`DJMidiManager` + `MidiPadController`) reconfigured per genre — not nine separate scenes per style. |
| **Lyria** | Stems are chosen in a **second “round”** in the menu: toggles + **Confirm** (generate) or **Back** (return to genres) — **no** Lyria job until **Confirm** (`MidiControllerMenu`). |
| **BPM** | Optional **SIK slider** tweaks **per-stem** tempo relative to the genre BPM: label updates while dragging; **heavy resample is debounced** and flushes **on release** (`DJMidiManager`). |
| **Crossfader** | **Two-deck** model (A = older, B = newer): slider toward B favors the newer playing pad. **Drag** uses debounced layer volumes; **slide end** and pad events **apply immediately** (`CrossfaderController` + `AudioLayerManager`). |
| **Spectrum ring** | `SpectrumRingReaction` drives bar motion, hue, and pinch highlight; layout supports **pizza-from-center** slices, optional **Theremin holder** pose sync, and robust bar discovery via **`spectrumBarsParent`** (`SpectrumRing`). |
| **Pinch overlay** | `SpectrumPinchNavigator` maps pinch position to **bar / semitone overlay** (optional Lyria pad pitch coupling is **off** by default). |
| **Theremin** | `SpectrumThereminVoice` crossfades **looped** `AudioComponent` tracks per spectrum sector while navigating. |
| **Spectrum ↔ visuals** | `MiniMidiAudioSpectacleAdapter` registers `SpectrumAudioPort` in `ServiceLocator` so the ring can follow **overlay MIDI** while pinching, otherwise **pad / BPM**-derived hue. |
| **Equalizer** | `EqualizerVisualDriver` clones materials, drives **`padPlaybackGate`** when pads play, and can **swap** between a **static** and an **animated** shader material while audio is live. |
| **Hints** | `Hint.js` shows a short onboarding string (BPM, crossfade, optional theremin) on a `Text` component. |

---

## Architecture (Scripts You Care About)

- **`DJMidiManager.ts`** — Lyria calls, pad grid, genre switches, BPM slider wiring, status line, coordination with `AudioLayerManager` and crossfader.
- **`MidiControllerMenu.ts`** — Genre UI, **stem round** visibility, **Confirm / Back**, pad grid reference alignment with `DJMidiManager`.
- **`MidiPadController.ts`** — Per-pad state machine (`PadState`), PCM, Lyria playback, visuals, `onPadToggled` hooks.
- **`AudioLayerManager.ts`** — Layer pool, **debounced** `setLayerVolume` vs **`applyLayerVolumeNow`** for responsive faders.
- **`CrossfaderController.ts`** — Deck A/B registration from playing pads, SIK slider, solo vs dual-deck gain law.
- **`CrossfaderController` / BPM** — Stability comes from **not** hammering the audio thread: debounce while dragging, **commit** on gesture end.
- **`SpectrumPinchNavigator.ts`** — Hand pinch → sector index, optional highlight scales, overlay MIDI for visuals.
- **`SpectrumRingReaction.ts`** — Radial / hub layout, material clones, pinch sector boost, optional **`thereminTrackHoldersParent`** world-pose sync.
- **`SpectrumThereminVoice.ts`** — Theremin bus: which loop fades in when the spectrum gesture is active.
- **`MiniMidiAudioSpectacleAdapter.ts`** — `SpectrumAudioPort` implementation for the ring + expression.
- **`EqualizerVisualDriver.ts`** — Gate + optional **idle vs animated** material swap when pads play with ready audio.
- **`MIDIPositionLock.ts`** — Optional spatial lock UX for the deck (SIK).
- **`GenreInstrumentData.ts`**, **`PcmResampler.ts`**, **`TrackColorManager.ts`**, **`DotPoolVisualizer.ts`**, **`vfx.ts`** — Supporting data, audio DSP, and polish.

---

## BPM Solution (Why It Feels Stable)

- BPM is presented as a **bounded offset** from the genre default (`bpmTweakAtMin` / `bpmTweakAtMax`).
- While the **SIK slider** moves, the UI can update quickly, but **stem time-stretch / resample** work is **debounced** (`bpmTweakDebounceSec`) so scrubbing does not queue overlapping heavy work.
- On **slide end**, pending work is flushed so the **heard** tempo matches the knob **immediately**.
- The **last started pad** selects which stem receives BPM edits (`_bpmEditPadIndex`), keeping multi-stem sessions intentional rather than random.

---

## Crossfader & Fader Stability

- **During drag:** `setLayerVolume` → **debounced** application in `AudioLayerManager` (smoother, fewer glitches under load).
- **On slide end / deck changes:** `applyLayerVolumeNow` so the mix **snaps** correctly when you let go or when a new pad promotes to deck B.
- **CrossfaderController** ignores programmatic slider writes (`_ignoreSliderValueUpdates`) when syncing the SIK control to deck changes so you do not get feedback loops or double updates.

---

## Spectrum & Theremin

- **Pinch** is treated as an **overlay**: bar index and radial semitone offset can drive **ring color / highlight** via `SpectrumPinchNavigator` + `MiniMidiAudioSpectacleAdapter`, **without** implying that the nine Lyria pads are the same thing unless you explicitly wire pitch coupling.
- **`SpectrumRingReaction`** lays out bars (including **pizza-hub** mode: slices meet at the ring center with **Z-axis** fanning), optionally syncs **theremin track holder** transforms to bar **world** poses, and warms layout over the first frames so Lens reference timing does not leave everything at identity rotation.
- **`SpectrumThereminVoice`** listens for active spectrum navigation and **crossfades** between pre-authored **looped** theremin clips per bar index.

---

## Menu Flow & Project Stability

- **Genre first → stem toggles → Confirm or Back** reduces accidental Lyria spend and keeps mental model linear (`MidiControllerMenu`).
- **Single pad grid** + explicit **genre apply** paths avoid duplicating nine pads per genre in the scene hierarchy.
- **Service locator** pattern for spectrum audio (`ServiceLocator` + `SpectrumAudioPort`) keeps the ring decoupled from Lyria internals while still reflecting performance state.

---

## MIDI Deck & Equalizer (Look & Shader)

- The **deck** is built as a **Spectacles-native** layout: SIK **sliders**, **interactables**, and spatial hierarchy suitable for **hand** and **device** framing — a **futuristic** read: bold grouping of **genre**, **stems**, **pads**, **BPM**, **crossfader**, and **spectrum / theremin** as one instrument.
- The **equalizer** uses a **dedicated driver** (`EqualizerVisualDriver`):
  - Clones materials so runtime writes hit the **instance** the mesh uses.
  - Supports **`padPlaybackGate`** (and common alias names) for shader graphs that animate on “music is actually playing”.
  - Supports a **second material** (`equalizerMaterialAnimated`) so you can keep a **clean static** look at idle and **swap to the full animated graph** only when a pad is **playing** with **ready** PCM (`hasAudio`, not loading/error).

---

## What We’re Proud Of

- **Cohesive DJ flow** on-device: genre → stems → pads → mix → expressive spectrum, without treating every feature as the same abstraction.
- **Performance-aware BPM** and **crossfader** design: musicians notice when sliders “fight” the engine — debounce + explicit commit was the right split.
- **Spectrum as a performance surface**: pinch navigation, optional theremin bed, and **shared** visual/audio metaphors (ring hue, pinch strength).
- **Equalizer honesty**: the mesh reacts when **audio is really playing**, with an optional **material swap** so art direction stays crisp when idle.
- **Maintainable scripts**: small focused components (`EqualizerVisualDriver`, `SpectrumThereminVoice`, `MiniMidiAudioSpectacleAdapter`) instead of one god object.

---

## Pain Points & Gotchas

- **Lens Studio wiring** — Many behaviors depend on **inspector references** (grid root, spectrum root, pinch navigator component, material assets). A missing reference often fails **silently** until you read logs; use the component hints in TypeScript `@hint` text as a checklist.
- **Shader property names** — Custom graphs must expose a **Script/Dynamic** float compatible with names like `padPlaybackGate` (the driver tries several spellings). Mismatched names = static look even when logic runs.
- **Spectrum vs pinch coordinates** — The ring layout is in the **pad / viz** hierarchy; pinch uses **`spectrumRoot`’s local XZ** in `SpectrumPinchNavigator`. If those spaces diverge, sector index and visuals can disagree until transforms are aligned.
- **Lyria latency & quotas** — Cloud generation is inherently variable; the menu’s **Confirm** gate helps but does not remove network or quota issues.
- **Material clones** — Swapping idle/animated materials is correct for visuals but **two** shader graphs must be authored consistently if both should respond to the same control names.

---

## Requirements & Build

- **Lens Studio** (project targets **Spectacles**; uses **Spectacles Interaction Kit** under `Assets/SpectaclesInteractionKit` and related packages).
- **Internet** where Lyria / remote services are used (project settings must allow it for those code paths).
- Open **`Assets/Scene.scene`** (or your active scene), ensure **Script Components** match the references described in each script’s `@input` hints.

---

## Credits

**3D design** — **[Forouzan Salsabili](https://github.com/forouzan1990)**  
Portfolio: [forouzan.artstation.com](https://forouzan.artstation.com/) · GitHub: [@forouzan1990](https://github.com/forouzan1990)

---

*Last updated to reflect the current MiNiMIDI script set (BPM debounce, crossfader stability, stem menu flow, spectrum / theremin stack, equalizer dual-material driver, and spectrum ring layout improvements).*
