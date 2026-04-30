/**
 * SpectrumPinchNavigator.ts
 * **Overlay only:** pinch near the spectrum center, then **rotate** (angle) to select a bar and
 * **radius** for extra semitones — this is **note / bar navigation**, not Lyria stem generation.
 * Exposes {@link getActiveSpectrumSectorIndex} for {@link SpectrumRingReaction} and
 * {@link getOverlayMidiForVisual} / {@link isSpectrumPinchNavigating} for ring hue via
 * {@link MiniMidiAudioSpectacleAdapter}. Optional {@link affectLyriaPadPitch} can retune the **pad**
 * under the selected bar (legacy coupling); default is off.
 */

import { HandInputData } from "SpectaclesInteractionKit/Providers/HandInputData/HandInputData";
import TrackedHand from "SpectaclesInteractionKit/Providers/HandInputData/TrackedHand";
import { ToggleButton } from "SpectaclesInteractionKit/Components/UI/ToggleButton/ToggleButton";
import { DJMidiManager } from "./DJMidiManager";

@component
export class SpectrumPinchNavigator extends BaseScriptComponent {
    @input
    @hint("When affectLyriaPadPitch is ON: DJMidiManager used to retune the pad aligned with the bar index.")
    @allowUndefined
    djMidiManager: DJMidiManager;

    @input
    @hint("If ON, bar index maps to pad[i] and setSpectrumPitchSemitones applies. Default OFF — spectrum is overlay navigation only.")
    affectLyriaPadPitch: boolean = false;

    @input
    @hint("Optional: SIK ToggleButton — when ON, pinch navigation runs. Leave empty to always allow pinch (single mode).")
    @allowUndefined
    spectrumFeatureToggle: ScriptComponent;

    @input
    @hint("World origin of the spectrum disc; local XZ plane is used for angle + radius.")
    spectrumRoot: SceneObject;

    @input
    @hint("Optional: parent whose ordered children are bar meshes (0 = first bar). Highlight scales selected bar.")
    @allowUndefined
    barMarkersParent: SceneObject;

    @input
    @hint("Optional: hide this object (and children) when the feature toggle is OFF.")
    @allowUndefined
    spectrumVisualsRoot: SceneObject;

    @input
    @hint("Number of spectrum bars / note slots around the ring (visual count; independent of Lyria pad count unless affectLyriaPadPitch is ON).")
    barCount: number = 9;

    @input
    @hint("Max distance from spectrum center (cm) for pinch midpoint to count as starting the gesture.")
    pinchStartMaxRadiusFromCenter: number = 14;

    @input
    @hint("Inner radius of the spectrum ring (cm) — at this radius radial semitone offset is 0.")
    spectrumInnerRadius: number = 10;

    @input
    @hint("Outer radius of the spectrum ring (cm).")
    spectrumOuterRadius: number = 38;

    @input
    @hint("Radians added to atan2 before mapping angle → bar (rotate which note slot is at 12 o'clock).")
    angleOffsetRad: number = 0;

    @input
    @hint("If bar semitones CSV is empty: semitone = barIndex × step + rootOffset.")
    spectrumSemitoneStepPerBar: number = 1;

    @input
    @hint("Added to each bar’s discrete semitone when CSV is empty.")
    spectrumRootSemitoneOffset: number = 0;

    @input
    @hint("Optional: comma-separated semitones per bar, e.g. 0,2,4,5,7,9,11,12,14 — overrides step×index if enough values.")
    spectrumBarSemitonesCsv: string = "";

    @input
    @hint("Semitones added from inner→outer radius (theremin sweep).")
    spectrumRadialSemitoneRange: number = 4;

    @input
    @hint("Min pinch strength (0–1) to read the gesture.")
    pinchStrengthThreshold: number = 0.55;

    @input
    @hint("Use dominant hand only; if false, either hand can drive (first valid pinch wins).")
    dominantHandOnly: boolean = true;

    @input
    @hint("Scale multiplier for the highlighted bar mesh.")
    barHighlightScale: number = 1.18;

    @input
    @hint("When affectLyriaPadPitch: seconds between resample applies. Also throttles debug prints.")
    applyThrottleSec: number = 0.085;

    @input
    @hint("Print mapping / state changes.")
    debugLog: boolean = false;

    private _enabled: boolean = false;
    private _armed: boolean = false;
    private _toggle: ToggleButton | null = null;
    private _handData: HandInputData | null = null;
    private _parsedBarSemitones: number[] = [];
    private _barObjects: SceneObject[] = [];
    private _barBaseScales: vec3[] = [];
    private _lastApplyTime: number = 0;
    private _lastAppliedSemitones: number = 0;
    /** Bar index under active pinch (for SpectrumRingReaction); -1 = none. */
    private _activeBarIndexForHighlight: number = -1;
    /** Clamped MIDI-ish value (48–84) for ring hue while navigating; independent of Lyria pads. */
    private _overlayMidi: number = 60;
    private _lastDebugLogTime: number = 0;
    /** 0..1 pinch strength on the active gesture hand (for theremin expression). */
    private _leadPinchStrength01: number = 0;

    /**
     * Same name as AETHER LeadSurfaceRayGate — lets SpectrumRingReaction boost the active bar
     * while you pinch-rotate on the ring. Returns null when not pinching / disabled.
     */
    public getActiveSpectrumSectorIndex(): number | null {
        if (!this._enabled) {
            return null;
        }
        if (this._activeBarIndexForHighlight < 0) {
            return null;
        }
        return this._activeBarIndexForHighlight;
    }

    /** Synthetic MIDI for {@link MiniMidiAudioSpectacleAdapter} / ring hue while pinching the spectrum. */
    public getOverlayMidiForVisual(): number {
        return this._overlayMidi;
    }

    /** True while a valid pinch gesture is driving bar selection (after arm near center). */
    public isSpectrumPinchNavigating(): boolean {
        return this._enabled && this._armed && this._activeBarIndexForHighlight >= 0;
    }

    /** Normalized pinch strength (0..1) for the hand driving the spectrum; 0 when not navigating. */
    public getLeadPinchStrength01(): number {
        if (!this.isSpectrumPinchNavigating()) {
            return 0;
        }
        return Math.max(0, Math.min(1, this._leadPinchStrength01));
    }

    onAwake(): void {
        this._parsedBarSemitones = this.parseBarSemitonesCsv(this.spectrumBarSemitonesCsv);
        this.createEvent("OnStartEvent").bind(() => {
            this._handData = HandInputData.getInstance();
            this.collectBarMarkers();
            if (this.spectrumFeatureToggle) {
                const so = this.spectrumFeatureToggle.getSceneObject();
                this._toggle = so.getComponent(ToggleButton.getTypeName()) as ToggleButton;
                if (this._toggle) {
                    this._enabled = this._toggle.isToggledOn;
                    this.applyVisualRootEnabled();
                    this._toggle.onStateChanged.add((on: boolean) => {
                        this.setFeatureEnabled(on);
                    });
                } else {
                    print("[SpectrumPinch] spectrumFeatureToggle has no ToggleButton on that SceneObject.");
                }
            } else {
                this._enabled = true;
                print("[SpectrumPinch] No toggle — pinch navigation always ON.");
            }
            if (this.debugLog) {
                print(
                    `[SpectrumPinch] Ready (bars=${Math.floor(this.barCount)}, throttle=${this.applyThrottleSec}s). Toggle: ${this._toggle ? "OK" : "missing"}.`
                );
            }
            if (this.affectLyriaPadPitch && !this.djMidiManager) {
                print("[SpectrumPinch] affectLyriaPadPitch is ON but djMidiManager is missing — overlay only.");
            }
        });

        this.createEvent("UpdateEvent").bind(() => {
            if (!this._enabled || !this._handData || !this.spectrumRoot) {
                if (!this._enabled) {
                    this._activeBarIndexForHighlight = -1;
                }
                return;
            }
            this.updateGesture();
        });
    }

    private setFeatureEnabled(on: boolean): void {
        if (this._enabled === on) {
            this.applyVisualRootEnabled();
            return;
        }
        this._enabled = on;
        this._armed = false;
        this._activeBarIndexForHighlight = -1;
        if (!on) {
            if (this.affectLyriaPadPitch) {
                this.clearAllPadSpectrumPitch();
            }
            this.setBarHighlight(-1);
        }
        this.applyVisualRootEnabled();
        if (this.debugLog) {
            print(`[SpectrumPinch] Feature ${on ? "ON" : "OFF"}`);
        }
    }

    private applyVisualRootEnabled(): void {
        if (!this.spectrumVisualsRoot) {
            return;
        }
        this.spectrumVisualsRoot.enabled = this._enabled;
    }

    private parseBarSemitonesCsv(csv: string): number[] {
        const raw = (csv || "").trim();
        if (!raw.length) {
            return [];
        }
        const parts = raw.split(/[,;\s]+/);
        const out: number[] = [];
        for (let i = 0; i < parts.length; i++) {
            const t = parts[i].trim();
            if (!t.length) {
                continue;
            }
            const n = Number(t);
            if (!isNaN(n)) {
                out.push(n);
            }
        }
        return out;
    }

    private collectBarMarkers(): void {
        this._barObjects = [];
        this._barBaseScales = [];
        if (!this.barMarkersParent) {
            return;
        }
        const n = this.barMarkersParent.getChildrenCount();
        for (let i = 0; i < n; i++) {
            const c = this.barMarkersParent.getChild(i);
            if (c) {
                this._barObjects.push(c);
                this._barBaseScales.push(c.getTransform().getLocalScale());
            }
        }
    }

    private clearAllPadSpectrumPitch(): void {
        if (!this.djMidiManager) {
            return;
        }
        const pads = this.djMidiManager.getPadsForCurrentMode();
        for (let i = 0; i < pads.length; i++) {
            const p = pads[i];
            if (p && Math.abs(p.getSpectrumPitchSemitones()) > 1e-4) {
                p.setSpectrumPitchSemitones(0);
            }
        }
    }

    private discreteSemitoneForBar(barIndex: number): number {
        const custom = this._parsedBarSemitones;
        if (custom.length > barIndex) {
            return custom[barIndex];
        }
        return this.spectrumRootSemitoneOffset + barIndex * this.spectrumSemitoneStepPerBar;
    }

    private worldPinchMidpoint(hand: TrackedHand): vec3 | null {
        if (!hand.isTracked() || !hand.isPinching()) {
            return null;
        }
        const str = hand.getPinchStrength();
        if (str === null || str < this.pinchStrengthThreshold) {
            return null;
        }
        const it = hand.indexTip.position;
        const tt = hand.thumbTip.position;
        return it.add(tt).uniformScale(0.5);
    }

    private pickActiveHand(): TrackedHand | null {
        if (!this._handData) {
            return null;
        }
        if (this.dominantHandOnly) {
            const d = this._handData.getDominantHand() as TrackedHand;
            if (this.worldPinchMidpoint(d)) {
                return d;
            }
            return null;
        }
        const r = this._handData.getHand("right") as TrackedHand;
        const l = this._handData.getHand("left") as TrackedHand;
        if (this.worldPinchMidpoint(r)) {
            return r;
        }
        if (this.worldPinchMidpoint(l)) {
            return l;
        }
        return null;
    }

    private toSpectrumLocal(world: vec3): vec3 {
        const inv = this.spectrumRoot.getTransform().getInvertedWorldTransform();
        return inv.multiplyPoint(world);
    }

    private updateGesture(): void {
        const hand = this.pickActiveHand();
        if (!hand) {
            this._armed = false;
            this._activeBarIndexForHighlight = -1;
            this._leadPinchStrength01 = 0;
            return;
        }
        const mid = this.worldPinchMidpoint(hand);
        if (!mid) {
            this._armed = false;
            this._activeBarIndexForHighlight = -1;
            this._leadPinchStrength01 = 0;
            return;
        }
        const ps = hand.getPinchStrength();
        this._leadPinchStrength01 = ps !== null ? Math.max(0, Math.min(1, ps)) : 0;

        const local = this.toSpectrumLocal(mid);
        const lx = local.x;
        const lz = local.z;
        const dist = Math.sqrt(lx * lx + lz * lz);

        if (!this._armed) {
            if (dist <= this.pinchStartMaxRadiusFromCenter) {
                this._armed = true;
            } else {
                this._activeBarIndexForHighlight = -1;
                return;
            }
        }

        const bars = Math.max(1, Math.min(32, Math.floor(this.barCount)));
        let ang = Math.atan2(lx, lz) + this.angleOffsetRad;
        const twoPi = Math.PI * 2;
        while (ang < 0) {
            ang += twoPi;
        }
        while (ang >= twoPi) {
            ang -= twoPi;
        }
        const barIndex = Math.min(bars - 1, Math.floor((ang / twoPi) * bars));
        this._activeBarIndexForHighlight = barIndex;

        const inner = Math.max(0.5, this.spectrumInnerRadius);
        const outer = Math.max(inner + 0.5, this.spectrumOuterRadius);
        let radialT = (dist - inner) / (outer - inner);
        if (radialT < 0) {
            radialT = 0;
        }
        if (radialT > 1) {
            radialT = 1;
        }
        const radialSemi = radialT * this.spectrumRadialSemitoneRange;
        const discrete = this.discreteSemitoneForBar(barIndex);
        const totalSemi = discrete + radialSemi;

        this.setBarHighlight(barIndex);
        this._overlayMidi = Math.max(48, Math.min(84, Math.round(60 + totalSemi)));

        if (this.affectLyriaPadPitch && this.djMidiManager) {
            const now = getTime();
            const dtApply = now - this._lastApplyTime;
            const semiDelta = Math.abs(totalSemi - this._lastAppliedSemitones);
            if (dtApply < this.applyThrottleSec && semiDelta < 0.12) {
                return;
            }

            const pads = this.djMidiManager.getPadsForCurrentMode();
            if (barIndex < 0 || barIndex >= pads.length) {
                return;
            }
            const pad = pads[barIndex];
            if (!pad || !pad.hasAudio()) {
                return;
            }

            pad.setSpectrumPitchSemitones(totalSemi);
            this._lastApplyTime = now;
            this._lastAppliedSemitones = totalSemi;

            if (this.debugLog) {
                const t = getTime();
                if (t - this._lastDebugLogTime >= this.applyThrottleSec) {
                    this._lastDebugLogTime = t;
                    print(
                        `[SpectrumPinch] bar=${barIndex} dist=${dist.toFixed(1)} semi=${totalSemi.toFixed(2)} pad=${pad.getInstrumentName()}`
                    );
                }
            }
        } else if (this.debugLog) {
            const t = getTime();
            if (t - this._lastDebugLogTime >= this.applyThrottleSec) {
                this._lastDebugLogTime = t;
                print(
                    `[SpectrumPinch] overlay bar=${barIndex} dist=${dist.toFixed(1)} semi=${totalSemi.toFixed(2)} midi=${this._overlayMidi}`
                );
            }
        }
    }

    private setBarHighlight(index: number): void {
        if (this._barObjects.length === 0) {
            return;
        }
        const hs = this.barHighlightScale;
        for (let i = 0; i < this._barObjects.length; i++) {
            const obj = this._barObjects[i];
            if (!obj) {
                continue;
            }
            const base = i < this._barBaseScales.length ? this._barBaseScales[i] : new vec3(1, 1, 1);
            if (i === index) {
                obj.getTransform().setLocalScale(new vec3(base.x * hs, base.y * hs, base.z * hs));
            } else {
                obj.getTransform().setLocalScale(base);
            }
        }
    }
}
