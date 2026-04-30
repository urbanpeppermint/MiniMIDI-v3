/**
 * CrossfaderController.ts
 * Mixes the two most recently playing pads (A = older deck, B = newer).
 *
 * Slider: increasing value toward the B / "second label" side boosts Track B and reduces A
 * (linear crossfade). Pads no longer on A/B keep whatever volume they last had — we only
 * push volumes for the two deck layers (plus solo 0–100% when only one deck is active).
 *
 * **Spectacles stability:** SIK `onValueUpdate` can fire extremely often and with display-range
 * values (not always 0–1). We normalize using the Slider’s min/max, guard NaN, and use a
 * **stepped + throttled** path during drag (fewer `AudioLayerManager` volume pumps). Slide end
 * still applies immediately.
 */

import { Slider } from "SpectaclesInteractionKit/Components/UI/Slider/Slider";
import { MidiPadController } from "./MidiPadController";
import { AudioLayerManager } from "./AudioLayerManager";

@component
export class CrossfaderController extends BaseScriptComponent {
    @input
    @hint("SceneObject that has the SIK Slider (parent e.g. ContainerFrame is OK — children are searched)")
    @allowUndefined
    crossfaderSlider: ScriptComponent;

    private _slider: Slider | null = null;

    @input
    @hint("Track A label (older deck; quieter as fader moves toward B)")
    @allowUndefined
    trackALabel: Text;

    @input
    @hint("Track B label (newer deck; louder as fader moves toward B / higher slider value)")
    @allowUndefined
    trackBLabel: Text;

    @input("float")
    @hint("During drag: minimum seconds between volume pushes (0 = no time throttle). ~0.04 ≈ 25 Hz.")
    crossfaderDragThrottleSec: number = 0.04;

    @input("float")
    @hint("During drag: only push if normalized crossfade moved by at least this much (0 = no delta gate). ~0.01–0.03.")
    crossfaderMinPushDelta: number = 0.02;

    @input("int")
    @hint("If >= 2, snap normalized crossfade to this many discrete steps (pizza / stepped bypass). 0 = off.")
    crossfaderQuantizeSteps: number = 32;

    private _trackA: MidiPadController | null = null;
    private _trackB: MidiPadController | null = null;
    /** Normalized 0–1; higher → more B, less A when both decks active. */
    private _crossfadeValue: number = 0.5;

    private _ignoreSliderValueUpdates: number = 0;
    /** Last normalized value we actually pushed during drag (step/throttle bypass). */
    private _lastPushedCrossfade01: number = -999;
    private _lastDragPushTimeSec: number = -1;

    private static _instance: CrossfaderController;
    public static getInstance(): CrossfaderController {
        return CrossfaderController._instance;
    }

    onAwake(): void {
        CrossfaderController._instance = this;

        this.createEvent("OnStartEvent").bind(() => {
            this.setupSlider();
        });
    }

    private findSliderUnder(root: SceneObject): Slider | null {
        const stack: SceneObject[] = [root];
        while (stack.length > 0) {
            const obj = stack.pop() as SceneObject;
            const s = obj.getComponent(Slider.getTypeName()) as Slider | null;
            if (s) {
                return s;
            }
            for (let i = 0; i < obj.getChildrenCount(); i++) {
                stack.push(obj.getChild(i));
            }
        }
        return null;
    }

    /** SIK passes display value in [minValue, maxValue], not necessarily 0–1. */
    private displayTo01(displayValue: number): number {
        const s = this._slider;
        if (!s) {
            const v = displayValue;
            return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
        }
        const smin = s.minValue;
        const smax = s.maxValue;
        const span = smax - smin;
        if (!isFinite(displayValue) || !isFinite(smin) || !isFinite(smax) || Math.abs(span) < 1e-9) {
            return 0.5;
        }
        return Math.max(0, Math.min(1, (displayValue - smin) / span));
    }

    private quantize01(t: number): number {
        const n = Math.floor(this.crossfaderQuantizeSteps);
        if (n < 2) {
            return t;
        }
        const q = Math.round(t * (n - 1)) / (n - 1);
        return Math.max(0, Math.min(1, q));
    }

    private setupSlider(): void {
        if (!this.crossfaderSlider) {
            print("[Crossfader] crossfaderSlider not assigned");
            this.pushVolumesToManager(true);
            return;
        }

        const root = this.crossfaderSlider.getSceneObject();
        const slider = this.findSliderUnder(root);

        if (!slider || !slider.onValueUpdate) {
            print(
                "[Crossfader] No SIK Slider under assigned object — assign a parent that contains the Slider."
            );
            this._slider = null;
            this._crossfadeValue = 0.5;
            this.pushVolumesToManager(true);
            return;
        }

        this._slider = slider;

        slider.onValueUpdate.add((value: number) => {
            if (this._ignoreSliderValueUpdates > 0) {
                return;
            }
            let t = this.displayTo01(value);
            t = this.quantize01(t);
            this._crossfadeValue = t;

            const throttle = Math.max(0, this.crossfaderDragThrottleSec);
            const minDelta = Math.max(0, this.crossfaderMinPushDelta);
            const now = getTime();
            const deltaOk = minDelta <= 0 || Math.abs(t - this._lastPushedCrossfade01) >= minDelta;
            const timeOk =
                throttle <= 0 || this._lastDragPushTimeSec < 0 || now - this._lastDragPushTimeSec >= throttle;
            if (!deltaOk && !timeOk) {
                return;
            }
            this._lastPushedCrossfade01 = t;
            this._lastDragPushTimeSec = now;
            this.pushVolumesToManager(false);
        });

        slider.onSlideEnd.add((value: number) => {
            if (this._ignoreSliderValueUpdates > 0) {
                return;
            }
            const t = this.quantize01(this.displayTo01(value));
            this._crossfadeValue = t;
            this._lastPushedCrossfade01 = t;
            this._lastDragPushTimeSec = getTime();
            this.pushVolumesToManager(true);
        });

        this._crossfadeValue = 0.5;
        this._lastPushedCrossfade01 = 0.5;
        this._lastDragPushTimeSec = -1;
        this._ignoreSliderValueUpdates++;
        slider.currentValue = slider.minValue + (slider.maxValue - slider.minValue) * 0.5;
        this._ignoreSliderValueUpdates--;
        this.pushVolumesToManager(true);

        print("[Crossfader] Slider connected — Spectacles-safe drag (normalize + throttle + optional quantize).");
    }

    private pushVolumesToManager(immediate: boolean): void {
        const manager = AudioLayerManager.getInstance();
        if (!manager) return;

        const hasA = this._trackA !== null;
        const hasB = this._trackB !== null;
        const rawT = this._crossfadeValue;
        const t = isFinite(rawT) ? Math.max(0, Math.min(1, rawT)) : 0.5;

        let volumeA = 0;
        let volumeB = 0;
        if (hasA && hasB) {
            volumeA = 1.0 - t;
            volumeB = t;
        } else if (hasA) {
            volumeA = t;
        } else if (hasB) {
            volumeB = t;
        }

        const push = (pad: MidiPadController, vol: number) => {
            if (!isFinite(vol)) return;
            const layerIndex = manager.getLayerForOwner(pad.getOwnerId());
            if (layerIndex < 0) return;
            const v = Math.max(0, Math.min(1, vol));
            if (immediate) {
                manager.applyLayerVolumeNow(layerIndex, v);
            } else {
                manager.setLayerVolume(layerIndex, v);
            }
        };

        if (this._trackA) {
            push(this._trackA, volumeA);
        }
        if (this._trackB) {
            push(this._trackB, volumeB);
        }
    }

    private setCrossfadeValueProgrammatic(value: number): void {
        const v = isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
        this._crossfadeValue = v;
        this._lastPushedCrossfade01 = v;
        this._lastDragPushTimeSec = getTime();
        if (this._slider) {
            const smin = this._slider.minValue;
            const smax = this._slider.maxValue;
            const span = smax - smin;
            const raw = Math.abs(span) < 1e-9 ? smin : smin + v * span;
            this._ignoreSliderValueUpdates++;
            this._slider.currentValue = raw;
            this._ignoreSliderValueUpdates--;
        }
        this.pushVolumesToManager(true);
    }

    public refreshDeckLabels(): void {
        this.updateLabels();
    }

    public registerPlayingPad(pad: MidiPadController): void {
        if (!pad) return;

        if (this._trackA === pad || this._trackB === pad) {
            this.updateLabels();
            this.pushVolumesToManager(true);
            return;
        }

        if (this._trackA === null && this._trackB === null) {
            this._trackA = pad;
            this.updateLabels();
            this.pushVolumesToManager(true);
        } else if (this._trackB === null) {
            this._trackB = pad;
            this.updateLabels();
            this.setCrossfadeValueProgrammatic(0.5);
        } else {
            this._trackA = this._trackB;
            this._trackB = pad;
            this.updateLabels();
            this.setCrossfadeValueProgrammatic(0.5);
        }

        print(
            `[Crossfader] Decks: A=${this._trackA?.getPadDisplayTitle() ?? "-"} B=${this._trackB?.getPadDisplayTitle() ?? "-"}`
        );
    }

    public unregisterPad(pad: MidiPadController): void {
        if (!pad) return;

        if (this._trackA === pad) {
            print(`[Crossfader] Unregistered Track A: ${pad.getPadDisplayTitle()}`);
            this._trackA = null;
        }

        if (this._trackB === pad) {
            print(`[Crossfader] Unregistered Track B: ${pad.getPadDisplayTitle()}`);
            this._trackB = null;
        }

        this.updateLabels();
        this.pushVolumesToManager(true);
    }

    public unregisterAll(): void {
        if (this._trackA) {
            print(`[Crossfader] Unregistering Track A: ${this._trackA.getPadDisplayTitle()}`);
        }
        if (this._trackB) {
            print(`[Crossfader] Unregistering Track B: ${this._trackB.getPadDisplayTitle()}`);
        }

        this._trackA = null;
        this._trackB = null;

        this.updateLabels();
        print(`[Crossfader] All tracks unregistered`);
    }

    private updateLabels(): void {
        if (this.trackALabel) {
            this.trackALabel.text = this._trackA ? this._trackA.getPadDisplayTitle() : "---";
        }
        if (this.trackBLabel) {
            this.trackBLabel.text = this._trackB ? this._trackB.getPadDisplayTitle() : "---";
        }
    }

    public getTrackA(): MidiPadController | null {
        return this._trackA;
    }

    public getTrackB(): MidiPadController | null {
        return this._trackB;
    }
}
