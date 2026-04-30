/**
 * CrossfaderController.ts
 * Mixes the two most recently playing pads (A = older deck, B = newer).
 *
 * Slider: increasing value toward the B / "second label" side boosts Track B and reduces A
 * (linear crossfade). Pads no longer on A/B keep whatever volume they last had — we only
 * push volumes for the two deck layers (plus solo 0–100% when only one deck is active).
 *
 * Drag uses debounced setLayerVolume; slide end and pad events use applyLayerVolumeNow.
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
    
    private _trackA: MidiPadController | null = null;
    private _trackB: MidiPadController | null = null;
    /** SIK displayValue 0–1; higher → more B, less A when both decks active. */
    private _crossfadeValue: number = 0.5;
    
    private _ignoreSliderValueUpdates: number = 0;
    
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
            this._crossfadeValue = value;
            this.pushVolumesToManager(false);
        });
        
        slider.onSlideEnd.add((value: number) => {
            if (this._ignoreSliderValueUpdates > 0) {
                return;
            }
            this._crossfadeValue = value;
            this.pushVolumesToManager(true);
        });
        
        this._crossfadeValue = 0.5;
        this._ignoreSliderValueUpdates++;
        slider.currentValue = 0.5;
        this._ignoreSliderValueUpdates--;
        this.pushVolumesToManager(true);
        
        print("[Crossfader] Slider connected — toward B = more B; solo = fader as 0–100%");
    }
    
    private pushVolumesToManager(immediate: boolean): void {
        const manager = AudioLayerManager.getInstance();
        if (!manager) return;
        
        const hasA = this._trackA !== null;
        const hasB = this._trackB !== null;
        const t = Math.max(0, Math.min(1, this._crossfadeValue));
        
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
        
        const push = (layerIndex: number, vol: number) => {
            if (layerIndex < 0) return;
            if (immediate) {
                manager.applyLayerVolumeNow(layerIndex, vol);
            } else {
                manager.setLayerVolume(layerIndex, vol);
            }
        };
        
        if (this._trackA) {
            push(this._trackA.getLayerIndex(), volumeA);
        }
        if (this._trackB) {
            push(this._trackB.getLayerIndex(), volumeB);
        }
    }
    
    private setCrossfadeValueProgrammatic(value: number): void {
        const v = Math.max(0, Math.min(1, value));
        this._crossfadeValue = v;
        if (this._slider) {
            this._ignoreSliderValueUpdates++;
            this._slider.currentValue = v;
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
        
        print(`[Crossfader] Decks: A=${this._trackA?.getPadDisplayTitle() ?? "-"} B=${this._trackB?.getPadDisplayTitle() ?? "-"}`);
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
