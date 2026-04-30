import { HandInputData } from "SpectaclesInteractionKit/Providers/HandInputData/HandInputData";
import TrackedHand from "SpectaclesInteractionKit/Providers/HandInputData/TrackedHand";
import { ServiceLocator, SERVICE_KEYS } from "./Core/ServiceLocator";
import type { SpectrumAudioPort } from "./Core/SpectrumAudioPort";
import { SpectrumPinchNavigator } from "./SpectrumPinchNavigator";

type SectorHighlightSource = { getActiveSpectrumSectorIndex(): number | null };

const MAX_SPECTRUM_BARS = 32;

/**
 * Spectrum ring: simulated harmonic bar motion + MIDI hue + expression (via {@link SpectrumAudioPort}).
 *
 * **Pinch bar boost (MiNiMIDI):** set `usePinchBarHighlight` and assign **`spectrumPinchNavigator`**
 * to the **ScriptComponent** on the same SceneObject as {@link SpectrumPinchNavigator} (drag the
 * component from the Inspector). That script exposes `getActiveSpectrumSectorIndex()` while you
 * pinch-rotate on the ring — no AETHER “LeadSurfaceRayGate” / ray stack.
 *
 * **Spectrum vs Lyria:** Pinch bar selection is an **overlay** that navigates discrete bars / semitones
 * (see {@link SpectrumPinchNavigator}); it is **not** the same as the nine Lyria stem pads unless you
 * explicitly enable pad pitch on that script. **Lyria** audio still flows from `DJMidiManager` /
 * `MidiPadController` and **AudioLayerManager**; this component only **visualizes** energy, hue, and
 * pinch-highlighted bars via {@link SpectrumAudioPort}.
 *
 * **Pizza from center:** `spectrumSlicesMeetAtCenter` keeps position at origin and spins each bar
 * with `quat.angleAxis` around parent Z over 360° (use `spectrumPlaceAtSectorCenters` for (i+0.5)/n).
 * Tweak facing with `spectrumLayoutRotationOffsetDeg`. When `spectrumBarsParent` has children (e.g.
 * SpectrumRing), their order is used for layout; otherwise the `spectrumBars` list is used.
 */
@component
export class SpectrumRingReaction extends BaseScriptComponent {
    @input
    @hint("Bar roots in ring order (spectrum note slots / SpecBars; count need not match Lyria pads).")
    spectrumBars: SceneObject[] = [];
    @input
    @allowUndefined
    @hint("When set and has children, their hierarchy order drives layout (recommended: SpectrumRing). Otherwise `spectrumBars` is used.")
    spectrumBarsParent: SceneObject;
    @input
    @hint("Optional RenderMeshVisual per bar (same order as spectrumBars).")
    @allowUndefined
    spectrumBarVisuals: RenderMeshVisual[] = [];
    @input("float")
    spectrumBaseHeight: number = 0.6;
    @input("float")
    spectrumPeakHeight: number = 5.5;
    @input("float")
    spectrumThickness: number = 0.35;
    @input("float")
    spectrumDecaySpeed: number = 0.18;
    @input("bool")
    layoutSpectrumRadialOnStart: boolean = true;
    @input("float")
    spectrumRingRadius: number = 12;
    @input("bool")
    @hint("If true, bars keep local position (0,0,0); each slice rotates so its outward bisector steps over 360° with tips meeting at the parent origin (pizza hub). Ring radius is ignored for placement.")
    spectrumSlicesMeetAtCenter: boolean = false;
    @input("bool")
    @hint("If true, each bar angle uses sector center (i+0.5)/count — matches SpectrumPinchNavigator’s floor(angle→bar) sectors.")
    spectrumPlaceAtSectorCenters: boolean = false;
    @input("bool")
    @hint("If true, bar rotation faces mesh +Z toward ring outward (typical pizza wedge). Ignored when spectrumSlicesMeetAtCenter is on (hub layout always uses that facing).")
    spectrumRadialSliceOrientation: boolean = false;
    @input("float")
    @hint("Extra degrees around world Z after base bar rotation (tweak wedge mesh facing).")
    spectrumLayoutRotationOffsetDeg: number = 0;
    @input
    @allowUndefined
    @hint("Optional: parent whose direct children (bar order 0…) copy each spectrum bar’s world position/rotation — e.g. ThereminTrackHolders under ThereminVoiceBus.")
    thereminTrackHoldersParent: SceneObject;
    @input("int")
    @hint("Number of bars (match SpectrumPinchNavigator.barCount and scene SpecBar count).")
    spectrumBarCount: number = 15;
    @input("bool")
    @hint("Boost the bar index returned by SpectrumPinchNavigator while pinching.")
    usePinchBarHighlight: boolean = true;
    @input("float")
    sectorHighlightBoost: number = 1.5;
    @input("bool")
    debugLogs: boolean = false;
    @input("bool")
    @hint("Fade spectrum when neither hand is tracked (SIK).")
    dimWhenNoHandTracked: boolean = false;
    @input
    @allowUndefined
    @hint("Drag the ScriptComponent that has SpectrumPinchNavigator (same object). Powers bar boost + must match bar order.")
    spectrumPinchNavigator: ScriptComponent;

    private audio: SpectrumAudioPort | null = null;
    private pinchSource: SectorHighlightSource | null = null;
    private spectrumMats: Material[] = [];
    private spectrumValues: number[] = new Array(MAX_SPECTRUM_BARS).fill(0);

    private timeAcc: number = 0;
    /** Re-apply radial layout for a few frames (OnStart can run before references are ready). */
    private _radialLayoutWarmupFrames = 0;
    private static readonly RADIAL_LAYOUT_WARMUP_MAX = 5;

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.onStart());
        this.createEvent("UpdateEvent").bind(() => this.onUpdate());
    }

    private onStart(): void {
        this.audio = ServiceLocator.instance.get<SpectrumAudioPort>(SERVICE_KEYS.audio);
        this.resolvePinchHighlightSource();
        if (!this.audio) {
            const d = this.createEvent("DelayedCallbackEvent");
            d.bind(() => {
                this.audio = ServiceLocator.instance.get<SpectrumAudioPort>(SERVICE_KEYS.audio);
                this.resolvePinchHighlightSource();
            });
            d.reset(0);
        }
        this.cloneSpectrumMaterials();
        this.applySpectrumRadialLayout();
        this._radialLayoutWarmupFrames = 0;
        const d2 = this.createEvent("DelayedCallbackEvent");
        d2.bind(() => this.applySpectrumRadialLayout());
        d2.reset(0.05);
    }

    /** Explicit `spectrumBars` list, or — when `spectrumBarsParent` has children — its ordered children (preferred). */
    private getSpectrumBarRoots(): SceneObject[] {
        if (this.spectrumBarsParent && this.spectrumBarsParent.getChildrenCount() > 0) {
            const out: SceneObject[] = [];
            const c = this.spectrumBarsParent.getChildrenCount();
            for (let i = 0; i < c; i++) {
                const ch = this.spectrumBarsParent.getChild(i);
                if (ch) {
                    out.push(ch);
                }
            }
            return out;
        }
        const fromInput: SceneObject[] = [];
        if (this.spectrumBars) {
            for (let i = 0; i < this.spectrumBars.length; i++) {
                const so = this.spectrumBars[i];
                if (so) {
                    fromInput.push(so);
                }
            }
        }
        return fromInput;
    }

    private resolvePinchHighlightSource(): void {
        this.pinchSource = null;
        if (!this.usePinchBarHighlight || !this.spectrumPinchNavigator) {
            return;
        }
        const so = this.spectrumPinchNavigator.getSceneObject();
        const nav = so.getComponent(SpectrumPinchNavigator.getTypeName()) as SpectrumPinchNavigator;
        if (nav) {
            this.pinchSource = nav;
            return;
        }
        const duck = this.spectrumPinchNavigator as unknown as SectorHighlightSource;
        if (typeof duck.getActiveSpectrumSectorIndex === "function") {
            this.pinchSource = duck;
        }
    }

    private cloneSpectrumMaterials(): void {
        this.spectrumMats = [];
        for (let i = 0; i < this.spectrumBarVisuals.length; i++) {
            const v = this.spectrumBarVisuals[i];
            if (!v || !v.mainMaterial) continue;
            const c = v.mainMaterial.clone();
            v.mainMaterial = c;
            this.spectrumMats.push(c);
        }
    }

    private applySpectrumRadialLayout(): void {
        const bars = this.getSpectrumBarRoots();
        if (!this.layoutSpectrumRadialOnStart || bars.length === 0) {
            return;
        }
        const count = Math.max(1, Math.min(MAX_SPECTRUM_BARS, Math.floor(this.spectrumBarCount)));
        const n = Math.min(bars.length, count);
        const R = this.spectrumRingRadius;
        const axisZ = new vec3(0, 0, 1);
        const offRad = (this.spectrumLayoutRotationOffsetDeg * Math.PI) / 180;
        for (let i = 0; i < n; i++) {
            const t = this.spectrumPlaceAtSectorCenters ? (i + 0.5) / count : i / count;
            const theta = t * Math.PI * 2;
            const so = bars[i];
            if (!so) continue;
            const tr = so.getTransform();
            if (this.spectrumSlicesMeetAtCenter) {
                tr.setLocalPosition(new vec3(0, 0, 0));
                // Pure spin around parent Z so slices fan 360° (pizza hub). Tweak with spectrumLayoutRotationOffsetDeg.
                tr.setLocalRotation(quat.angleAxis(theta + offRad, axisZ));
                continue;
            }
            tr.setLocalPosition(new vec3(R * Math.cos(theta), R * Math.sin(theta), 0));
            if (this.spectrumRadialSliceOrientation) {
                tr.setLocalRotation(quat.angleAxis(theta + offRad, axisZ));
            } else {
                tr.setLocalRotation(quat.angleAxis(theta - Math.PI / 2 + offRad, axisZ));
            }
        }
        this.syncThereminHoldersToBars(bars, n);
    }

    /** Copy world pose from spectrum bar i to holder child i (different parent chain than SpectrumRing). */
    private syncThereminHoldersToBars(bars: SceneObject[], barCount: number): void {
        const parent = this.thereminTrackHoldersParent;
        if (!parent) {
            return;
        }
        const hn = parent.getChildrenCount();
        const m = Math.min(barCount, hn, bars.length);
        for (let i = 0; i < m; i++) {
            const bar = bars[i];
            const holder = parent.getChild(i);
            if (!bar || !holder) {
                continue;
            }
            const bt = bar.getTransform();
            const ht = holder.getTransform();
            ht.setWorldPosition(bt.getWorldPosition());
            ht.setWorldRotation(bt.getWorldRotation());
        }
    }

    private anyHandTracked(): boolean {
        try {
            const h = HandInputData.getInstance();
            const L = h.getHand("left") as TrackedHand;
            const R = h.getHand("right") as TrackedHand;
            return L.isTracked() || R.isTracked();
        } catch (_) {
            return true;
        }
    }

    private onUpdate(): void {
        if (this.layoutSpectrumRadialOnStart && this._radialLayoutWarmupFrames < SpectrumRingReaction.RADIAL_LAYOUT_WARMUP_MAX) {
            this.applySpectrumRadialLayout();
            this._radialLayoutWarmupFrames++;
        }
        if (!this.audio) return;
        const dt = getDeltaTime();
        this.timeAcc += dt;

        const barCap = Math.max(1, Math.min(MAX_SPECTRUM_BARS, Math.floor(this.spectrumBarCount)));
        const denom = Math.max(1, barCap - 1);

        const midi = this.audio.getMidi();
        let handsTracked = true;
        if (this.dimWhenNoHandTracked) {
            handsTracked = this.anyHandTracked();
        }
        const isPlaying = this.audio.isNoteOn() && !this.audio.isMuted() && handsTracked;
        const expr = this.audio.getExpression ? this.audio.getExpression() : { left: 0, right: 0 };
        const exprMax = Math.max(expr.left || 0, expr.right || 0);
        const activeSector =
            this.usePinchBarHighlight && isPlaying && this.pinchSource
                ? this.pinchSource.getActiveSpectrumSectorIndex()
                : null;

        const pitchHue = ((midi - 48) / 36) % 1;
        const pitchRgb = this.hsvToRgb((pitchHue + 1) % 1, 0.85, 1.0);

        const bars = this.getSpectrumBarRoots();
        for (let i = 0; i < bars.length && i < barCap; i++) {
            const so = bars[i];
            if (!so) continue;
            const harmonicIdx = i + 1;
            const phase = this.timeAcc * (1.5 + harmonicIdx * 0.3) + i * 0.4 + midi * 0.05;
            let energy = 0;
            if (isPlaying) {
                energy = Math.max(0, 0.55 + 0.45 * Math.sin(phase));
                const pitchT = (midi - 48) / 36;
                const tilt = 1 - Math.abs(i / denom - pitchT);
                energy *= 0.4 + 0.6 * Math.max(0, tilt);
                energy *= 0.6 + 0.4 * exprMax;
                if (activeSector === i) {
                    energy *= this.sectorHighlightBoost;
                }
            }
            const decayAlpha = isPlaying
                ? Math.max(0, Math.min(1, this.spectrumDecaySpeed))
                : Math.max(0, Math.min(1, Math.min(0.92, this.spectrumDecaySpeed * 6)));
            this.spectrumValues[i] = this.spectrumValues[i] * (1 - decayAlpha) + energy * decayAlpha;
            const h =
                this.spectrumBaseHeight + this.spectrumValues[i] * (this.spectrumPeakHeight - this.spectrumBaseHeight);
            so.getTransform().setLocalScale(new vec3(this.spectrumThickness, h, this.spectrumThickness));

            if (i < this.spectrumMats.length) {
                const mat = this.spectrumMats[i];
                try {
                    const v = this.spectrumValues[i];
                    const al = 0.25 + v * 0.75;
                    (mat.mainPass as any).baseColor = new vec4(pitchRgb.x, pitchRgb.y, pitchRgb.z, al);
                } catch (_) {}
            }
        }
    }

    private hsvToRgb(h: number, s: number, v: number): vec3 {
        const i = Math.floor(h * 6);
        const f = h * 6 - i;
        const p = v * (1 - s);
        const q = v * (1 - f * s);
        const t = v * (1 - (1 - f) * s);
        let r = 0,
            g = 0,
            b = 0;
        switch (i % 6) {
            case 0:
                r = v;
                g = t;
                b = p;
                break;
            case 1:
                r = q;
                g = v;
                b = p;
                break;
            case 2:
                r = p;
                g = v;
                b = t;
                break;
            case 3:
                r = p;
                g = q;
                b = v;
                break;
            case 4:
                r = t;
                g = p;
                b = v;
                break;
            case 5:
                r = v;
                g = p;
                b = q;
                break;
        }
        return new vec3(r, g, b);
    }
}
