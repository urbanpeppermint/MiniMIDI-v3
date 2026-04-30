/**
 * DJMidiManager.ts
 * Main controller for DJ MIDI with Lyria generation
 * Handles dynamic layer allocation and genre switching
 */

import { Lyria } from "RemoteServiceGateway.lspkg/HostedExternal/Lyria";
import { GoogleGenAITypes } from "RemoteServiceGateway.lspkg/HostedExternal/GoogleGenAITypes";
import { Slider } from "SpectaclesInteractionKit/Components/UI/Slider/Slider";
import { MidiPadController, PadState } from "./MidiPadController";
import { CrossfaderController } from "./CrossfaderController";
import { AudioLayerManager } from "./AudioLayerManager";
import { DotPoolVisualizer } from './DotPoolVisualizer';
import {
    GenreConfig,
    getGenreByMode,
    buildSafePrompt,
    getGenreCount,
} from "./GenreInstrumentData";

@component
export class DJMidiManager extends BaseScriptComponent {
    
    // ═══════════════════════════════════════════════════════════════
    // INPUTS - PAD GRID (one holder, 9 children with MidiPadController)
    // ═══════════════════════════════════════════════════════════════
    
    @input
    @hint("Single SceneObject parent whose direct children are the 9 pads. Same grid is re-used for every genre; labels and Lyria clips update when you switch genre.")
    midiPadGrid: SceneObject;
    
    // ═══════════════════════════════════════════════════════════════
    // INPUTS - UI
    // ═══════════════════════════════════════════════════════════════
    
    @input
    @allowUndefined
    statusText: Text;
    
    @input
    @allowUndefined
    genreLabel: Text;
    
    @input
    @allowUndefined
    bpmLabel: Text;
    
    @input
    @hint("Optional: SIK Slider — per-stem BPM (tap pad to choose). Offset/label update while dragging; heavy resample is debounced and runs immediately when you release the knob.")
    @allowUndefined
    bpmTweakSliderRoot: ScriptComponent;
    
    @input
    @hint("BPM at slider minimum (relative offset from genre BPM, e.g. -6)")
    bpmTweakAtMin: number = -6;
    
    @input
    @hint("BPM at slider maximum (relative offset from genre BPM, e.g. +6)")
    bpmTweakAtMax: number = 6;
    
    @input
    @hint("Debounce (seconds) while dragging BPM tweak slider — label updates immediately; heavy resample runs after you pause or on slide end.")
    bpmTweakDebounceSec: number = 0.18;
    
    @input
    @hint("Optional: parent for SIK Slider — linear tempo on already-generated clips (pitch follows). Center = 1.0×.")
    @allowUndefined
    playbackRateSliderRoot: ScriptComponent;
    
    @input
    @hint("Playback speed at slider minimum (e.g. 0.92 = slower)")
    playbackRateAtMin: number = 0.92;
    
    @input
    @hint("Playback speed at slider maximum (e.g. 1.08 = faster)")
    playbackRateAtMax: number = 1.08;
    
    @input
    @hint("Debounce (seconds) while dragging playback-rate slider (heavy resample per loaded pad).")
    playbackRateDebounceSec: number = 0.45;
    
    // ═══════════════════════════════════════════════════════════════
    // INPUTS - CROSSFADER
    // ═══════════════════════════════════════════════════════════════
    
    @input
    @hint("CrossfaderController for mixing")
    @allowUndefined
    crossfaderController: CrossfaderController;
    
    // ═══════════════════════════════════════════════════════════════
    // SETTINGS
    // ═══════════════════════════════════════════════════════════════
    
    @input
    @hint("Delay between generating each track (ms)")
    delayBetweenTracks: number = 2500;
    
    @input
    @hint("When true, automatically plays pad 0 after the first Lyria clip loads (preview).")
    autoPlayFirstGeneratedTrack: boolean = true;

    // ═══════════════════════════════════════════════════════════════
    // PRIVATE STATE
    // ═══════════════════════════════════════════════════════════════
    
    private padsByGenre: { [key: number]: MidiPadController[] } = {};
    private isGenerating: { [key: number]: boolean } = {};
    private generatedGenres: { [key: number]: boolean } = {};
    private currentMode: number = 0;
    /**
     * Bumped when layers are fully torn down (genre switch / release) or stopAll.
     * Cancels delayed "autoplay first track" so it cannot fire after user moved on.
     */
    private _playbackSessionId: number = 0;
    
    /** BPM offset from genre default, driven by bpm tweak slider (rounded for prompts). */
    private _bpmOffset: number = 0;
    private _ignoreBpmSliderUpdates: number = 0;
    /** Pad index (0–8) whose stem BPM the slider updates when moved (last pad you started). */
    private _bpmEditPadIndex: number = 0;
    /** SIK BPM slider instance (for debounced resample flush). */
    private _bpmTweakSlider: Slider | null = null;
    /** Cancels pending BPM stem resample when the knob moves again or on slide end. */
    private _bpmStemResampleToken: number = 0;
    
    /** 0–1 from playback-rate SIK slider (center = 1.0× speed). */
    private _playbackSliderT: number = 0.5;
    private _playbackApplyToken: number = 0;
    private _ignorePlaybackSliderUpdates: number = 0;
    /** Cancels in-flight staggered resamples when the playback slider fires again. */
    private _playbackResampleStaggerToken: number = 0;
    
    // ═══════════════════════════════════════════════════════════════
    // SINGLETON
    // ═══════════════════════════════════════════════════════════════
    
    private static _instance: DJMidiManager;
    public static getInstance(): DJMidiManager {
        return DJMidiManager._instance;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ═══════════════════════════════════════════════════════════════
    
    onAwake(): void {
        DJMidiManager._instance = this;
        
        this.createEvent("OnStartEvent").bind(() => {
            this.setupBpmSlider();
            this.setupPlaybackRateSlider();
            this.initialize();
        });
    }
    
    private initialize(): void {
        print("[DJMidiManager] Initializing...");
        this.waitForAudioLayerManager();
    }
    
    private waitForAudioLayerManager(): void {
        const manager = AudioLayerManager.getInstance();
        
        if (manager && manager.isReady()) {
            this.setupPads();
        } else {
            print("[DJMidiManager] Waiting for AudioLayerManager...");
            const event = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
            event.bind(() => this.waitForAudioLayerManager());
            event.reset(0.2);
        }
    }
    
    private setupPads(): void {
        // Initialize state for all genres
        for (let i = 1; i <= getGenreCount(); i++) {
            this.isGenerating[i] = false;
            this.generatedGenres[i] = false;
            this.padsByGenre[i] = [];
        }
        
        const gridPads = this.collectPadsFromGrid(this.midiPadGrid);
        
        if (!gridPads.length) {
            print("[DJMidiManager] ERROR: midiPadGrid is missing or has no MidiPadController children. Assign the pad holder SceneObject.");
        }
        
        for (let i = 1; i <= getGenreCount(); i++) {
            this.padsByGenre[i] = gridPads;
        }
        
        if (gridPads.length > 0) {
            print(`[DJMidiManager] Single pad grid: ${gridPads.length} pads for all genres`);
        }
        
        // Configure initial labels for genre 1 only (others apply on genre select)
        for (let i = 1; i <= getGenreCount(); i++) {
            const genre = getGenreByMode(i);
            if (!genre) {
                continue;
            }
            const pads = this.padsByGenre[i];
            if (i === 1) {
                this.applyGenreIdToPads(pads, 1);
                this.configurePadsForGenre(pads, genre);
            }
            print(`[DJMidiManager] Genre ${i}: ${pads.length} pads`);
        }
        
        this.updateStatus("Select a genre to start");
        print("[DJMidiManager] Ready!");
    }
    
    private applyGenreIdToPads(pads: MidiPadController[], genreId: number): void {
        if (!pads || pads.length === 0) {
            return;
        }
        pads.forEach(p => p.setActiveGenreId(genreId));
    }
    
    private collectPadsFromGrid(grid: SceneObject): MidiPadController[] {
        const pads: MidiPadController[] = [];
        if (!grid) return pads;
        
        const childCount = grid.getChildrenCount();
        for (let i = 0; i < childCount; i++) {
            const child = grid.getChild(i);
            const pad = child.getComponent(MidiPadController.getTypeName()) as MidiPadController;
            
            if (pad) {
                pads.push(pad);
                
                // Setup callback for play/stop events
                pad.onPadToggled.push((padIndex, isPlaying, padRef) => {
                    this.onPadToggled(padIndex, isPlaying, padRef);
                });
            }
        }
        
        // Sort by pad index
        pads.sort((a, b) => a.getPadIndex() - b.getPadIndex());
        return pads;
    }
    
    private configurePadsForGenre(pads: MidiPadController[], genre: GenreConfig): void {
        for (let i = 0; i < pads.length && i < genre.instruments.length; i++) {
            const inst = genre.instruments[i];
            pads[i].configure(inst.id, inst.name, inst.emoji);
        }
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
    
    /**
     * SIK Slider onValueUpdate / onSlideEnd pass the display value in [minValue, maxValue], not 0–1.
     */
    private static sliderDisplayTo01(slider: Slider, displayValue: number): number {
        const smin = slider.minValue;
        const smax = slider.maxValue;
        const span = smax - smin;
        if (Math.abs(span) < 1e-9) {
            return 0.5;
        }
        return Math.max(0, Math.min(1, (displayValue - smin) / span));
    }
    
    private setupBpmSlider(): void {
        if (!this.bpmTweakSliderRoot) {
            print("[DJMidiManager] BPM tweak slider not assigned (optional) — Lyria uses genre default BPM.");
            this.updateBpmLabelText(null);
            return;
        }
        
        const slider = this.findSliderUnder(this.bpmTweakSliderRoot.getSceneObject());
        if (!slider || !slider.onValueUpdate) {
            print("[DJMidiManager] No SIK Slider under bpmTweakSliderRoot — assign a parent that contains the Slider.");
            this.updateBpmLabelText(null);
            return;
        }
        
        this._bpmTweakSlider = slider;
        
        const applyBpmOffsetAndLabelOnly = (displayValue: number) => {
            const lo = Math.min(this.bpmTweakAtMin, this.bpmTweakAtMax);
            const hi = Math.max(this.bpmTweakAtMin, this.bpmTweakAtMax);
            const t = DJMidiManager.sliderDisplayTo01(slider, displayValue);
            this._bpmOffset = lo + t * (hi - lo);
            this.updateBpmLabelText(null);
        };
        
        const scheduleBpmStemResampleDebounced = () => {
            this._bpmStemResampleToken++;
            const token = this._bpmStemResampleToken;
            const debounce = Math.max(0.08, this.bpmTweakDebounceSec);
            const ev = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
            ev.bind(() => {
                if (token !== this._bpmStemResampleToken) {
                    return;
                }
                this.flushBpmStemResample(false);
            });
            ev.reset(debounce);
        };
        
        slider.onValueUpdate.add((value: number) => {
            if (this._ignoreBpmSliderUpdates > 0) {
                return;
            }
            applyBpmOffsetAndLabelOnly(value);
            scheduleBpmStemResampleDebounced();
        });
        
        if (slider.onSlideEnd) {
            slider.onSlideEnd.add((value: number) => {
                if (this._ignoreBpmSliderUpdates > 0) {
                    return;
                }
                this._bpmStemResampleToken++;
                applyBpmOffsetAndLabelOnly(value);
                this.flushBpmStemResample(true);
            });
        }
        
        const start = slider.currentValue;
        const raw0 =
            start !== null && start !== undefined
                ? start
                : (slider.minValue + slider.maxValue) * 0.5;
        this._ignoreBpmSliderUpdates++;
        slider.currentValue = raw0;
        this._ignoreBpmSliderUpdates--;
        applyBpmOffsetAndLabelOnly(raw0);
        
        const lo = Math.min(this.bpmTweakAtMin, this.bpmTweakAtMax);
        const hi = Math.max(this.bpmTweakAtMin, this.bpmTweakAtMax);
        print(
            `[DJMidiManager] BPM tweak slider OK (SIK ${slider.minValue}…${slider.maxValue} → offset ${lo}…${hi} BPM; resample debounce ${this.bpmTweakDebounceSec}s, instant on slide end)`
        );
    }
    
    /** Stem lock + single-pad resample using current _bpmOffset (call after debounce or on slide end). */
    private flushBpmStemResample(verboseLog: boolean): void {
        const slider = this._bpmTweakSlider;
        if (!slider) {
            return;
        }
        const genre =
            this.currentMode >= 1 && this.currentMode <= getGenreCount()
                ? getGenreByMode(this.currentMode)
                : null;
        if (!genre) {
            return;
        }
        const pads = this.padsByGenre[this.currentMode] || [];
        if (pads.length === 0) {
            return;
        }
        const idx = Math.max(0, Math.min(pads.length - 1, Math.floor(this._bpmEditPadIndex)));
        const target = pads[idx];
        if (!target) {
            return;
        }
        const locked = this.getEffectiveBpm(genre);
        target.setStemEffectiveBpm(locked);
        const heard = this.getCombinedPlaybackSpeedForPad(target, genre);
        this.applyPlaybackSpeedToLoadedPads(true, target);
        
        if (verboseLog) {
            const cv = slider.currentValue;
            const disp = cv !== null && cv !== undefined ? cv : 0;
            const t = DJMidiManager.sliderDisplayTo01(slider, disp);
            const eff = this.getEffectiveBpm(genre);
            const lockedBpm = target.getStemEffectiveBpm();
            const stemTag =
                lockedBpm !== null
                    ? ` | stem ${idx} (${target.getInstrumentName()}) locked ${lockedBpm} BPM`
                    : "";
            print(
                `[DJMidiManager] BPM tweak (commit): display=${disp.toFixed(3)} → t=${t.toFixed(3)} offset=${this._bpmOffset.toFixed(1)} BPM (Lyria ${eff} BPM)${stemTag} | heard ${heard.toFixed(3)}×`
            );
        }
    }
    
    private setupPlaybackRateSlider(): void {
        if (!this.playbackRateSliderRoot) {
            print("[DJMidiManager] Playback-rate slider not assigned (optional) — pads keep generated tempo until you add one.");
            return;
        }
        
        const slider = this.findSliderUnder(this.playbackRateSliderRoot.getSceneObject());
        if (!slider || !slider.onValueUpdate) {
            print("[DJMidiManager] No SIK Slider under playbackRateSliderRoot.");
            return;
        }
        
        const applySpeedFromDisplayValue = (displayValue: number) => {
            this._playbackSliderT = DJMidiManager.sliderDisplayTo01(slider, displayValue);
            this._playbackApplyToken++;
            const token = this._playbackApplyToken;
            const debounce = Math.max(0.1, this.playbackRateDebounceSec);
            const ev = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
            ev.bind(() => {
                if (token !== this._playbackApplyToken) {
                    return;
                }
                this.applyPlaybackSpeedToLoadedPads(true);
            });
            ev.reset(debounce);
        };
        
        slider.onValueUpdate.add((value: number) => {
            if (this._ignorePlaybackSliderUpdates > 0) {
                return;
            }
            applySpeedFromDisplayValue(value);
        });
        
        slider.onSlideEnd.add((value: number) => {
            if (this._ignorePlaybackSliderUpdates > 0) {
                return;
            }
            this._playbackSliderT = DJMidiManager.sliderDisplayTo01(slider, value);
            this._playbackApplyToken++;
            this.applyPlaybackSpeedToLoadedPads(true);
        });
        
        const start = slider.currentValue;
        const raw0 =
            start !== null && start !== undefined
                ? start
                : (slider.minValue + slider.maxValue) * 0.5;
        this._ignorePlaybackSliderUpdates++;
        slider.currentValue = raw0;
        this._ignorePlaybackSliderUpdates--;
        this._playbackSliderT = DJMidiManager.sliderDisplayTo01(slider, raw0);
        this.applyPlaybackSpeedToLoadedPads(true);
        
        print(
            `[DJMidiManager] Playback-rate slider OK (linear resample; min=${Math.min(this.playbackRateAtMin, this.playbackRateAtMax)} max=${Math.max(this.playbackRateAtMin, this.playbackRateAtMax)}×; combined with BPM tweak)`
        );
    }
    
    private applyPlaybackSpeedToLoadedPads(
        allowDuringLyriaGeneration: boolean = false,
        restrictToPad: MidiPadController | null = null
    ): void {
        if (!allowDuringLyriaGeneration && this.isAnyGenreGenerating()) {
            return;
        }
        const mode = this.currentMode >= 1 ? this.currentMode : 1;
        const genre = getGenreByMode(mode);
        if (!genre) {
            return;
        }
        
        this._playbackResampleStaggerToken++;
        const token = this._playbackResampleStaggerToken;
        
        if (restrictToPad !== null) {
            const pad = restrictToPad;
            if (pad.hasStoredSourcePcm()) {
                const speed = this.getCombinedPlaybackSpeedForPad(pad, genre);
                if (pad.isPlaying()) {
                    pad.setPlaybackSpeedRate(speed);
                } else {
                    pad.setPlaybackSpeedTargetOnly(speed);
                }
            }
            return;
        }
        
        const pads = this.padsByGenre[mode] || [];
        
        const playing: { pad: MidiPadController; speed: number }[] = [];
        let idleCount = 0;
        for (let i = 0; i < pads.length; i++) {
            const pad = pads[i];
            if (!pad.hasStoredSourcePcm()) {
                continue;
            }
            const speed = this.getCombinedPlaybackSpeedForPad(pad, genre);
            if (pad.isPlaying()) {
                playing.push({ pad, speed });
            } else {
                pad.setPlaybackSpeedTargetOnly(speed);
                idleCount++;
            }
        }
        
        const staggerSec = 0.35;
        const leadInSec = 0.06;
        
        const finishLog = () => {
            const n = idleCount + playing.length;
            if (n > 0) {
                print(
                    `[DJMidiManager] Playback speed per stem (${n} pad(s)) — ${idleCount} ready, ${playing.length} playing (staggered)`
                );
            }
        };
        
        if (playing.length === 0) {
            finishLog();
            return;
        }
        
        const applyPlayingAt = (idx: number) => {
            if (token !== this._playbackResampleStaggerToken) {
                return;
            }
            if (idx >= playing.length) {
                finishLog();
                return;
            }
            playing[idx].pad.setPlaybackSpeedRate(playing[idx].speed);
            if (idx + 1 < playing.length) {
                const ev = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
                ev.bind(() => applyPlayingAt(idx + 1));
                ev.reset(staggerSec);
            } else {
                finishLog();
            }
        };
        
        const kick = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        kick.bind(() => applyPlayingAt(0));
        kick.reset(leadInSec);
    }
    
    private getLinearPlaybackSliderFactor(): number {
        const lo = Math.min(this.playbackRateAtMin, this.playbackRateAtMax);
        const hi = Math.max(this.playbackRateAtMin, this.playbackRateAtMax);
        return lo + this._playbackSliderT * (hi - lo);
    }
    
    /** Per-pad: (stem BPM / genre BPM) × playback-rate slider, clamped for resampler. */
    private getCombinedPlaybackSpeedForPad(pad: MidiPadController, genre: GenreConfig): number {
        if (!genre || genre.bpm <= 0) {
            return Math.max(0.5, Math.min(2.0, this.getLinearPlaybackSliderFactor()));
        }
        const stem = pad.getStemEffectiveBpm();
        const eff = stem !== null && stem > 0 ? stem : genre.bpm;
        const bpmRatio = Math.max(0.25, Math.min(4.0, eff / genre.bpm));
        const linear = this.getLinearPlaybackSliderFactor();
        return Math.max(0.5, Math.min(2.0, bpmRatio * linear));
    }
    
    private isAnyGenreGenerating(): boolean {
        for (let m = 1; m <= getGenreCount(); m++) {
            if (this.isGenerating[m]) {
                return true;
            }
        }
        return false;
    }
    
    /** BPM sent to Lyria for this genre (genre default + slider offset, clamped). */
    private getEffectiveBpm(genre: GenreConfig): number {
        const raw = genre.bpm + this._bpmOffset;
        return Math.max(60, Math.min(220, Math.round(raw)));
    }
    
    private updateBpmLabelText(genreOverride: GenreConfig | null | undefined): void {
        if (!this.bpmLabel) {
            return;
        }
        const genre =
            genreOverride !== undefined && genreOverride !== null
                ? genreOverride
                : this.currentMode >= 1 && this.currentMode <= getGenreCount()
                  ? getGenreByMode(this.currentMode)
                  : null;
        if (!genre) {
            this.bpmLabel.text = "BPM";
            return;
        }
        const eff = this.getEffectiveBpm(genre);
        const base = genre.bpm;
        const delta = Math.round(eff - base);
        const pads = this.padsByGenre[this.currentMode] || [];
        const ei = Math.max(0, Math.min(pads.length - 1, Math.floor(this._bpmEditPadIndex)));
        const ep = pads[ei];
        const locked = ep ? ep.getStemEffectiveBpm() : null;
        const slot =
            ep && (ep.getInstrumentName() || "").trim().length > 0
                ? ep.getInstrumentName()
                : `Stem ${ei + 1}`;
        if (locked !== null) {
            const ld = Math.round(locked - base);
            const sgn = ld > 0 ? "+" : "";
            this.bpmLabel.text = `Slider ${eff} BPM (${delta > 0 ? "+" : ""}${delta}) · ${slot}: ${locked} BPM (${sgn}${ld})`;
        } else if (delta === 0) {
            this.bpmLabel.text = `${eff} BPM · ${slot} (tap to lock)`;
        } else {
            const sign = delta > 0 ? "+" : "";
            this.bpmLabel.text = `${eff} BPM (${sign}${delta} vs ${base}) · ${slot}`;
        }
    }
    
    /** Prefer wired reference; fall back to singleton if inspector link is missing. */
    private getCrossfader(): CrossfaderController | null {
        return this.crossfaderController ?? CrossfaderController.getInstance();
    }
    
    private onPadToggled(padIndex: number, isPlaying: boolean, pad: MidiPadController): void {
        const xf = this.getCrossfader();
        if (xf) {
            if (isPlaying) {
                xf.registerPlayingPad(pad);
            } else {
                xf.unregisterPad(pad);
            }
        }
        
        print(`[DJMidiManager] Pad ${padIndex} ${isPlaying ? "PLAYING" : "STOPPED"}`);
        if (isPlaying) {
            this._bpmEditPadIndex = Math.max(0, Math.min(8, Math.floor(padIndex)));
            this.updateBpmLabelText(null);
        }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // PUBLIC API - GENRE SELECTION
    // ═══════════════════════════════════════════════════════════════
    
    public onGenreSelected(mode: number): void {
        if (mode < 1 || mode > getGenreCount()) {
            print(`[DJMidiManager] Invalid mode: ${mode}`);
            return;
        }

        print(`[DJMidiManager] ═══════════════════════════════════════`);
        print(`[DJMidiManager] Switching to mode ${mode}`);
        
        // ═══════════════════════════════════════════════════════════
        // STEP 1: Stop and release ALL layers from ALL genres
        // ═══════════════════════════════════════════════════════════
        
        this.releaseAllPadsAndLayers();
        
        // ═══════════════════════════════════════════════════════════
        // STEP 2: Clear visualizer
        // ═══════════════════════════════════════════════════════════
        
        const visualizer = DotPoolVisualizer.getInstance();
        if (visualizer) {
            visualizer.clearAllTracks();
        }
        
        // ═══════════════════════════════════════════════════════════
        // STEP 3: Set current mode and update UI
        // ═══════════════════════════════════════════════════════════
        
        this.currentMode = mode;
        const genre = getGenreByMode(mode);
        if (!genre) return;
        
        this._bpmEditPadIndex = 0;
        
        print(
            `[DJMidiManager] Selected: ${genre.emoji} ${genre.name} @ ${this.getEffectiveBpm(genre)} BPM (base ${genre.bpm})`
        );
        
        if (this.genreLabel) this.genreLabel.text = `${genre.emoji} ${genre.name}`;
        this.updateBpmLabelText(genre);
        
        // ═══════════════════════════════════════════════════════════
        // STEP 3.5: Reconfigure the single pad grid for the selected genre
        // ═══════════════════════════════════════════════════════════
        
        const pads = this.padsByGenre[mode] || [];
        this.applyGenreIdToPads(pads, mode);
        this.configurePadsForGenre(pads, genre);
        this.getCrossfader()?.refreshDeckLabels();
        print(`[DJMidiManager] Configured ${pads.length} pads for ${genre.name}`);
        
        // Log available layers
        const manager = AudioLayerManager.getInstance();
        if (manager) {
            print(`[DJMidiManager] Available layers: ${manager.getAvailableLayerCount()}/${manager.getTotalLayerCount()}`);
        }
        
        // ═══════════════════════════════════════════════════════════
        // STEP 4: Check if already generated or start generation
        // ═══════════════════════════════════════════════════════════
        
        if (this.generatedGenres[mode]) {
            this.updateStatus(`${genre.name} Ready!`);
            this.applyPlaybackSpeedToLoadedPads(true);
            return;
        }

        this.updateStatus(`${genre.name}: pick stems in the menu, then Confirm to generate.`);
    }

    /** True when Lyria has finished loading for this genre (pads may have clips). */
    public isGenreGenerated(mode: number): boolean {
        return mode >= 1 && mode <= getGenreCount() && !!this.generatedGenres[mode];
    }

    /**
     * Called from {@link MidiControllerMenu} after the user confirms stem selection. `stemMask` must have length ≥ 9;
     * index `i` true = run Lyria for that pad/instrument.
     */
    public startLyriaGenerationWithStemMask(mode: number, stemMask: boolean[]): void {
        if (mode < 1 || mode > getGenreCount()) {
            print(`[DJMidiManager] startLyriaGenerationWithStemMask: invalid mode ${mode}`);
            return;
        }
        const expanded = this.expandStemMask(stemMask);
        if (this.normalizeStemMask(expanded).length === 0) {
            print("[DJMidiManager] No stems selected — abort generation.");
            return;
        }
        if (this.generatedGenres[mode]) {
            print(`[DJMidiManager] Mode ${mode} already marked generated — skip`);
            return;
        }
        if (this.isGenerating[mode]) {
            print(`[DJMidiManager] Mode ${mode} already generating`);
            return;
        }
        this.generateGenreWithStemMask(mode, stemMask);
    }

    /** User closed the stem menu without confirming — pads stay empty until they confirm or pick another genre. */
    public onStemPickCancelled(mode: number): void {
        const genre = getGenreByMode(mode);
        this.updateStatus(
            genre
                ? `${genre.name}: choose stems again from the genre row, then Confirm`
                : 'Stem selection cancelled'
        );
    }

    /** Indices 0..8 where mask is true (in ascending order). */
    private normalizeStemMask(stemMask: boolean[]): number[] {
        const out: number[] = [];
        for (let i = 0; i < 9; i++) {
            if (stemMask[i]) {
                out.push(i);
            }
        }
        return out;
    }
    
    /**
     * Release all pads and layers across ALL genres
     */
    private releaseAllPadsAndLayers(): void {
        this._playbackSessionId++;
        print(`[DJMidiManager] Releasing all pads and layers...`);
        
        // Stop and release all pads from ALL genres
        for (let i = 1; i <= getGenreCount(); i++) {
            const pads = this.padsByGenre[i] || [];
            pads.forEach(pad => {
                if (pad.isPlaying()) {
                    pad.stop();
                } else {
                    pad.releaseLayer();
                }
            });
        }
        
        // Also release all layers at manager level (safety net)
        const manager = AudioLayerManager.getInstance();
        if (manager) {
            manager.releaseAllLayers();
            print(`[DJMidiManager] All layers released. Available: ${manager.getAvailableLayerCount()}`);
        }
        
        // Unregister all from crossfader - use individual unregister calls
        this.unregisterAllFromCrossfader();
        
        const sharedPads = this.padsByGenre[1] || [];
        sharedPads.forEach((pad) => pad.setStemEffectiveBpm(null));
    }
    
    /**
     * Unregister all pads from crossfader
     */
    private unregisterAllFromCrossfader(): void {
        const xf = this.getCrossfader();
        if (!xf) return;
        xf.unregisterAll();
        print(`[DJMidiManager] All pads unregistered from crossfader`);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // PUBLIC API - PLAYBACK CONTROL
    // ═══════════════════════════════════════════════════════════════
    
    public stopAll(): void {
        this._playbackSessionId++;
        print(`[DJMidiManager] Stopping all...`);
        
        const manager = AudioLayerManager.getInstance();
        if (manager) {
            manager.stopAll();
            manager.releaseAllLayers();
        }
        
        // Stop all pads in current genre
        const pads = this.padsByGenre[this.currentMode] || [];
        pads.forEach(p => {
            if (p.isPlaying()) {
                p.stop();
            }
        });
        
        // Unregister all from crossfader
        this.unregisterAllFromCrossfader();
        
        print("[DJMidiManager] Stopped all");
    }
    
    public playAllCurrent(): void {
        const pads = this.padsByGenre[this.currentMode] || [];
        let playedCount = 0;
        
        pads.forEach(p => {
            if (p.getState() === PadState.Ready && !p.isPlaying()) {
                p.play();
                playedCount++;
            }
        });
        
        print(`[DJMidiManager] Started ${playedCount} pads`);
    }
    
    public getCurrentMode(): number {
        return this.currentMode;
    }
    
    public getPadsForCurrentMode(): MidiPadController[] {
        return this.padsByGenre[this.currentMode] || [];
    }

    /** Shared 9-pad grid (same array for every genre slot). Safe when currentMode is 0. */
    public getSharedMidiPads(): MidiPadController[] {
        return this.padsByGenre[1] || [];
    }

    /** Pad grid parent (same as midiPadGrid input). For helpers that need pads before genre select. */
    public getMidiPadGrid(): SceneObject {
        return this.midiPadGrid;
    }

    // ═══════════════════════════════════════════════════════════════
    // GENERATION
    // ═══════════════════════════════════════════════════════════════
    
    private generateGenreWithStemMask(mode: number, stemMask: boolean[]): void {
        if (this.isGenerating[mode]) {
            print(`[DJMidiManager] Mode ${mode} already generating`);
            return;
        }

        const genre = getGenreByMode(mode);
        const pads = this.padsByGenre[mode] || [];

        if (!genre || pads.length === 0) {
            print(`[DJMidiManager] Invalid genre or no pads`);
            return;
        }

        const fullMask = this.expandStemMask(stemMask);
        const indices = this.normalizeStemMask(fullMask);
        if (indices.length === 0) {
            print(`[DJMidiManager] Empty stem mask`);
            return;
        }

        this.isGenerating[mode] = true;
        this.updateStatus(`Generating ${genre.name} (${indices.length} stem(s))...`);

        for (let i = 0; i < pads.length && i < 9; i++) {
            if (fullMask[i]) {
                pads[i].setLoading();
            } else {
                pads[i].reset();
            }
        }

        this.generateTracksSequentiallyMasked(genre, pads, mode, indices, 0, () => {
            this.isGenerating[mode] = false;
            this.generatedGenres[mode] = true;
            for (let i = 0; i < pads.length && i < 9; i++) {
                if (!fullMask[i]) {
                    pads[i].reset();
                }
            }
            const syncEv = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
            syncEv.bind(() => this.applyPlaybackSpeedToLoadedPads());
            syncEv.reset(0.12);
            this.updateStatus(`${genre.name} Ready!`);
            print(`[DJMidiManager] ${genre.name} generation complete (${indices.length} stem(s))`);
        });
    }

    private expandStemMask(stemMask: boolean[]): boolean[] {
        const m: boolean[] = [];
        for (let i = 0; i < 9; i++) {
            m.push(i < stemMask.length ? !!stemMask[i] : false);
        }
        return m;
    }

    private generateTracksSequentiallyMasked(
        genre: GenreConfig,
        pads: MidiPadController[],
        mode: number,
        indices: number[],
        cursor: number,
        onComplete: () => void
    ): void {
        if (cursor >= indices.length) {
            onComplete();
            return;
        }

        const index = indices[cursor];
        if (index < 0 || index >= pads.length || index >= genre.instruments.length) {
            this.scheduleNextMasked(genre, pads, mode, indices, cursor, onComplete);
            return;
        }

        const pad = pads[index];
        const inst = genre.instruments[index];

        this.updateStatus(
            `${genre.name}: stem ${cursor + 1}/${indices.length} (pad ${index + 1}) — ${inst.emoji} ${inst.name}`
        );

        const fromStem = pad.getStemEffectiveBpm();
        const effectiveBpm =
            fromStem !== null && fromStem > 0 ? fromStem : this.getEffectiveBpm(genre);
        const prompt = buildSafePrompt(genre, inst, effectiveBpm);
        print(`[DJMidiManager] Generating: ${inst.name} @ ${effectiveBpm} BPM`);
        print(`[DJMidiManager] Prompt: ${prompt.substring(0, 100)}...`);

        const req: GoogleGenAITypes.Lyria.LyriaRequest = {
            model: "lyria-002",
            type: "predict",
            body: {
                instances: [{ prompt: prompt }],
                parameters: { sample_count: 1 },
            },
        };

        Lyria.performLyriaRequest(req)
            .then((res) => {
                if (res?.predictions?.length) {
                    const b64 = res.predictions[0].bytesBase64Encoded;
                    if (b64) {
                        pad.loadAudioB64(b64);
                        pad.setStemEffectiveBpm(effectiveBpm);
                        print(`[DJMidiManager] ✓ Loaded: ${inst.name}`);
                        if (this.autoPlayFirstGeneratedTrack && cursor === 0) {
                            const session = this._playbackSessionId;
                            const playEv = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
                            playEv.bind(() => {
                                if (session !== this._playbackSessionId) {
                                    return;
                                }
                                if (pads.some((p) => p.isPlaying())) {
                                    return;
                                }
                                if (pad.getState() === PadState.Ready && pad.hasAudio() && !pad.isPlaying()) {
                                    print("[DJMidiManager] Auto-playing first generated track (preview)");
                                    pad.play();
                                }
                            });
                            playEv.reset(0.35);
                        }
                    } else {
                        pad.setError();
                        print(`[DJMidiManager] ✗ No audio for: ${inst.name}`);
                    }
                } else {
                    pad.setError();
                    print(`[DJMidiManager] ✗ Empty response for: ${inst.name}`);
                }

                this.scheduleNextMasked(genre, pads, mode, indices, cursor, onComplete);
            })
            .catch((error) => {
                print(`[DJMidiManager] ✗ Error generating ${inst.name}: ${error}`);
                pad.setError();
                this.scheduleNextMasked(genre, pads, mode, indices, cursor, onComplete);
            });
    }

    private scheduleNextMasked(
        genre: GenreConfig,
        pads: MidiPadController[],
        mode: number,
        indices: number[],
        cursor: number,
        onComplete: () => void
    ): void {
        const event = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        event.bind(() => {
            this.generateTracksSequentiallyMasked(genre, pads, mode, indices, cursor + 1, onComplete);
        });
        event.reset(this.delayBetweenTracks / 1000);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // UI HELPERS
    // ═══════════════════════════════════════════════════════════════
    
    private updateStatus(text: string): void {
        if (this.statusText) {
            this.statusText.text = text;
        }
        print(`[DJMidiManager] ${text}`);
    }
}