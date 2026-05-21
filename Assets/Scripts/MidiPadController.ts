/**
 * MidiPadController.ts
 * Controls a single MIDI pad with dynamic layer acquisition
 */

import { Interactable } from 'SpectaclesInteractionKit/Components/Interaction/Interactable/Interactable';
import { AudioLayerManager } from './AudioLayerManager';
import { resampleStereoS16Linear } from './PcmResampler';

export enum PadState {
    Empty = 0,
    Loading = 1,
    Ready = 2,
    Playing = 3,
    Error = 4
}

@component
export class MidiPadController extends BaseScriptComponent {
    
    public static makeOwnerId(genreId: number, padIndex: number): string {
        return `g${genreId}_p${padIndex}`;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // INPUTS
    // ═══════════════════════════════════════════════════════════════
    
    @input
    @hint("Pad index (0-8)")
    padIndex: number = 0;
    
    @input
    @hint("Genre ID this pad belongs to (1-5)")
    genreId: number = 1;
    
    @input
    @hint("Visual mesh for the pad")
    @allowUndefined
    padMesh: RenderMeshVisual;
    
    @input
    @hint("Material for empty state")
    @allowUndefined
    emptyMaterial: Material;
    
    @input
    @hint("Material for loading state")
    @allowUndefined
    loadingMaterial: Material;
    
    @input
    @hint("Material for ready state")
    @allowUndefined
    readyMaterial: Material;
    
    @input
    @hint("Material for playing state")
    @allowUndefined
    playingMaterial: Material;
    
    @input
    @hint("Material for error state")
    @allowUndefined
    errorMaterial: Material;
    
    @input
    @hint("Optional label text")
    @allowUndefined
    labelText: Text;
    
    @input
    @hint("Optional emoji text")
    @allowUndefined
    emojiText: Text;
    
    // ═══════════════════════════════════════════════════════════════
    // CALLBACKS
    // ═══════════════════════════════════════════════════════════════
    
    public onPadToggled: ((padIndex: number, isPlaying: boolean, pad: MidiPadController) => void)[] = [];
    
    // ═══════════════════════════════════════════════════════════════
    // PRIVATE STATE
    // ═══════════════════════════════════════════════════════════════
    
    private _state: PadState = PadState.Empty;
    private _instrumentId: string = "";
    private _instrumentName: string = "";
    private _instrumentEmoji: string = "";
    private _isPlaying: boolean = false;
    private _audioData: Uint8Array | null = null;
    /** Immutable Lyria PCM for linear tempo tweak (pitch follows speed). */
    private _sourcePcm: Uint8Array | null = null;
    /** 1.0 = original; >1 faster+higher pitch; <1 slower+lower. */
    private _playbackSpeed: number = 1.0;
    /** Ready pads: speed changed but PCM not rebuilt yet (avoids main-thread spike during generation). */
    private _playbackPcmDirty: boolean = false;
    /** Lyria / user BPM for this stem; other pads ignore slider until you tap them. null until first gen or slider assigns. */
    private _stemEffectiveBpm: number | null = null;
    /** Optional spectrum / theremin pitch offset in semitones (combined with _playbackSpeed in resample). */
    private _spectrumSemitones: number = 0;
    private _ownerId: string = "";
    private _layerIndex: number = -1;
    private _interactable: Interactable | null = null;
    /** Invalidates pending stem-loop timers (incremented on cancel / stop / PCM refresh). */
    private _stemLoopToken: number = 0;
    
    // Base64 lookup table
    private static readonly BASE64_CHARS: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    
    // ═══════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ═══════════════════════════════════════════════════════════════
    
    onAwake(): void {
        // Create unique owner ID: "genre_padIndex"
        this._ownerId = MidiPadController.makeOwnerId(this.genreId, this.padIndex);
        
        this.createEvent('OnStartEvent').bind(() => {
            this.setupInteraction();
            this.setState(PadState.Empty);
            print(`[Pad ${this.padIndex}] Initialized - Owner: ${this._ownerId}`);
        });
    }
    
    private setupInteraction(): void {
        this._interactable = this.getSceneObject().getComponent(Interactable.getTypeName()) as Interactable;
        
        if (this._interactable) {
            this._interactable.onInteractorTriggerEnd.add(() => {
                this.onPadTapped();
            });
            print(`[Pad ${this.padIndex}] Interaction setup complete`);
        } else {
            print(`[Pad ${this.padIndex}] WARNING: No Interactable component found`);
        }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // TAP HANDLER
    // ═══════════════════════════════════════════════════════════════
    
    private onPadTapped(): void {
        print(`[Pad ${this.padIndex}] Tapped (${this._instrumentName}) - State: ${this._state}, HasAudio: ${this._audioData !== null}, Layer: ${this._layerIndex}`);
        
        // Check if ready
        if (this._state !== PadState.Ready && this._state !== PadState.Playing) {
            print(`[Pad ${this.padIndex}] Not ready!`);
            return;
        }
        
        // Toggle play/stop
        if (this._isPlaying) {
            this.stop();
        } else {
            this.play();
        }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // PLAYBACK CONTROL
    // ═══════════════════════════════════════════════════════════════
    
    /**
     * Play the pad - acquire layer dynamically
     */
    public play(): void {
        if (this._state !== PadState.Ready && this._state !== PadState.Playing) {
            print(`[Pad ${this.padIndex}] Cannot play - not ready (state: ${this._state})`);
            return;
        }
        
        if (!this._audioData) {
            print(`[Pad ${this.padIndex}] Cannot play - no audio data`);
            return;
        }
        
        const manager = AudioLayerManager.getInstance();
        if (!manager) {
            print(`[Pad ${this.padIndex}] Cannot play - no AudioLayerManager`);
            return;
        }
        
        // Acquire layer if we don't have one
        if (this._layerIndex < 0) {
            this._layerIndex = manager.acquireLayer(this._ownerId);
            print(`[Pad ${this.padIndex}] Acquired layer: ${this._layerIndex}`);
        }
        
        if (this._layerIndex < 0) {
            print(`[Pad ${this.padIndex}] Could not acquire layer! (${manager.getActiveLayerCount()}/${manager.getTotalLayerCount()} in use)`);
            return;
        }
        
        if (this._sourcePcm && this._playbackPcmDirty) {
            this.rebuildPlaybackPcmFromSource();
            this._playbackPcmDirty = false;
        }

        this.cancelStemLoopSchedule();
        
        this._state = PadState.Playing;
        this._isPlaying = true;
        this.updateVisuals();
        
        // Crossfader must run BEFORE first PCM buffer so layers are not all at 100% gain
        this.onPadToggled.forEach(cb => cb(this.padIndex, true, this));
        
        manager.playOnLayer(this._layerIndex, this._audioData);
        
        print(`[Pad ${this.padIndex}] ${this._instrumentEmoji} ${this._instrumentName} ▶ PLAYING on layer ${this._layerIndex}`);

        this.scheduleStemLoopReplay();
    }

    private cancelStemLoopSchedule(): void {
        this._stemLoopToken++;
    }

    private getPlaybackDurationSec(): number {
        if (!this._audioData || this._audioData.length < 4) {
            return 1.0;
        }
        const frames = this._audioData.length / 4;
        return Math.max(0.25, frames / 48000);
    }

    /**
     * Re-queue `playOnLayer` when the clip ends so stems loop until the user taps stop.
     * Timing is derived from current PCM length @ 48 kHz stereo.
     */
    private scheduleStemLoopReplay(): void {
        if (!this._isPlaying || this._state !== PadState.Playing) {
            return;
        }
        if (!this._audioData || this._layerIndex < 0) {
            return;
        }
        const armed = this._stemLoopToken;
        const delay = this.getPlaybackDurationSec() * 0.998;
        const ev = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        ev.bind(() => {
            if (armed !== this._stemLoopToken) {
                return;
            }
            if (!this._isPlaying || this._state !== PadState.Playing) {
                return;
            }
            const m = AudioLayerManager.getInstance();
            if (!m || this._layerIndex < 0 || !this._audioData) {
                return;
            }
            if (this._sourcePcm && this._playbackPcmDirty) {
                this.rebuildPlaybackPcmFromSource();
                this._playbackPcmDirty = false;
            }
            m.playOnLayer(this._layerIndex, this._audioData);
            this.scheduleStemLoopReplay();
        });
        ev.reset(delay);
    }

    private refreshStemLoopAfterPcmChange(): void {
        if (!this._isPlaying || this._state !== PadState.Playing || this._layerIndex < 0) {
            return;
        }
        this.cancelStemLoopSchedule();
        this.scheduleStemLoopReplay();
    }
    
    /**
     * Stop the pad - release layer
     */
    public stop(): void {
        this.cancelStemLoopSchedule();

        const manager = AudioLayerManager.getInstance();
        
        if (manager && this._layerIndex >= 0) {
            manager.stopLayer(this._layerIndex);
            manager.releaseLayer(this._layerIndex);
            print(`[Pad ${this.padIndex}] Released layer ${this._layerIndex}`);
        }
        
        this._layerIndex = -1;
        this._isPlaying = false;
        
        if (this._state === PadState.Playing) {
            this._state = PadState.Ready;
        }
        
        this.updateVisuals();
        
        print(`[Pad ${this.padIndex}] ${this._instrumentEmoji} ${this._instrumentName} ⏹ STOPPED`);
        
        // Notify callbacks
        this.onPadToggled.forEach(cb => cb(this.padIndex, false, this));
    }
    
    /**
     * Force release layer (called when switching genres)
     */
    public releaseLayer(): void {
        this.cancelStemLoopSchedule();

        const manager = AudioLayerManager.getInstance();
        
        if (manager && this._layerIndex >= 0) {
            manager.stopLayer(this._layerIndex);
            manager.releaseLayer(this._layerIndex);
            print(`[Pad ${this.padIndex}] Force released layer ${this._layerIndex}`);
        }
        
        this._layerIndex = -1;
        this._isPlaying = false;
        
        if (this._state === PadState.Playing) {
            this._state = PadState.Ready;
        }
        
        this.updateVisuals();
    }
    
    /**
     * Update logical genre for layer ownership (single shared pad grid for all genres).
     */
    public setActiveGenreId(genreId: number): void {
        const next = Math.max(1, Math.floor(genreId));
        if (this.genreId !== next) {
            if (this._isPlaying || this._layerIndex >= 0) {
                this.stop();
            }
            this.genreId = next;
        }
        this._ownerId = MidiPadController.makeOwnerId(this.genreId, this.padIndex);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════
    
    /**
     * Configure the pad for an instrument
     */
    public configure(instrumentId: string, instrumentName: string, emoji: string = "🎵"): void {
        this._instrumentId = instrumentId;
        this._instrumentName = instrumentName;
        this._instrumentEmoji = emoji;
        
        if (this.labelText) {
            this.labelText.text = instrumentName;
        }
        
        if (this.emojiText) {
            this.emojiText.text = emoji;
        }
        
        print(`[Pad ${this.padIndex}] Configured: ${emoji} ${instrumentName}`);
    }
    
    /**
     * Load audio data from base64
     */
    public loadAudioB64(base64Data: string): void {
        try {
            const decoded = this.decodeBase64(base64Data);
            // Lyria returns WAV containers; DynamicAudioOutput.addAudioFrame expects raw PCM only.
            const pcm = MidiPadController.stripWavToPcmIfPresent(decoded);
            this.assignLoadedPcm(pcm);
            this._state = PadState.Ready;
            this.updateVisuals();
            print(`[Pad ${this.padIndex}] ${this._instrumentName} loaded: ${this._audioData.length} bytes PCM`);
        } catch (e) {
            print(`[Pad ${this.padIndex}] Error loading audio: ${e}`);
            this._state = PadState.Error;
            this.updateVisuals();
        }
    }
    
    /**
     * Load audio data directly
     */
    public loadAudioData(audioData: Uint8Array): void {
        const pcm = MidiPadController.stripWavToPcmIfPresent(audioData);
        this.assignLoadedPcm(pcm);
        this._state = PadState.Ready;
        this.updateVisuals();
        print(`[Pad ${this.padIndex}] ${this._instrumentName} loaded: ${this._audioData!.length} bytes`);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // STATE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════
    
    public setState(state: PadState): void {
        this._state = state;
        this.updateVisuals();
    }
    
    public setLoading(): void {
        this._state = PadState.Loading;
        this.updateVisuals();
    }
    
    public setError(): void {
        this._state = PadState.Error;
        this.updateVisuals();
    }
    
    public setReady(): void {
        this._state = PadState.Ready;
        this.updateVisuals();
    }
    
    /**
     * Reset pad to empty state (for genre switching)
     */
    public reset(): void {
        this.releaseLayer();
        this._audioData = null;
        this._sourcePcm = null;
        this._playbackSpeed = 1.0;
        this._playbackPcmDirty = false;
        this._stemEffectiveBpm = null;
        this._spectrumSemitones = 0;
        this._state = PadState.Empty;
        this._isPlaying = false;
        this.updateVisuals();
    }
    
    // ═══════════════════════════════════════════════════════════════
    // GETTERS
    // ═══════════════════════════════════════════════════════════════
    
    public getState(): PadState {
        return this._state;
    }
    
    public getPadIndex(): number {
        return this.padIndex;
    }
    
    public getGenreId(): number {
        return this.genreId;
    }
    
    public getInstrumentId(): string {
        return this._instrumentId;
    }
    
    public getInstrumentName(): string {
        return this._instrumentName;
    }
    
    /** Same identity as on the pad (emoji + name, matching configure / on-pad labels). */
    public getPadDisplayTitle(): string {
        const name = (this._instrumentName || "").trim();
        const em = (this._instrumentEmoji || "").trim();
        const displayName = name.length > 0 ? name : "Track";
        return em.length > 0 ? `${em} ${displayName}` : displayName;
    }
    
    public isPlaying(): boolean {
        return this._isPlaying;
    }
    
    public hasAudio(): boolean {
        return this._audioData !== null;
    }
    
    public getLayerIndex(): number {
        return this._layerIndex;
    }
    
    public getOwnerId(): string {
        return this._ownerId;
    }
    
    public getAudioData(): Uint8Array | null {
        return this._audioData;
    }
    
    public hasStoredSourcePcm(): boolean {
        return this._sourcePcm !== null;
    }
    
    public getPlaybackSpeed(): number {
        return this._playbackSpeed;
    }
    
    public getStemEffectiveBpm(): number | null {
        return this._stemEffectiveBpm;
    }
    
    public setStemEffectiveBpm(bpm: number | null): void {
        if (bpm === null) {
            this._stemEffectiveBpm = null;
            return;
        }
        this._stemEffectiveBpm = Math.max(60, Math.min(220, Math.round(bpm)));
    }
    
    public getSpectrumPitchSemitones(): number {
        return this._spectrumSemitones;
    }
    
    /**
     * Sets spectrum-driven pitch offset in semitones (resample from source PCM).
     * When not playing, defers rebuild until next play() (same pattern as speed-only tweaks).
     */
    public setSpectrumPitchSemitones(semitones: number): void {
        if (!this._sourcePcm) {
            return;
        }
        const s = Math.max(-36, Math.min(36, semitones));
        if (Math.abs(s - this._spectrumSemitones) < 1e-4) {
            return;
        }
        this._spectrumSemitones = s;
        if (this._isPlaying) {
            this._playbackPcmDirty = false;
            this.rebuildPlaybackPcmFromSource();
            const manager = AudioLayerManager.getInstance();
            if (this._layerIndex >= 0 && manager && this._audioData) {
                manager.replaceLayerPcmAndReplay(this._layerIndex, this._audioData);
                this.refreshStemLoopAfterPcmChange();
            }
        } else {
            this._playbackPcmDirty = true;
        }
    }
    
    /**
     * For pads that are not playing: record speed only; resample on next play() to avoid script timeouts.
     * If already playing, same as setPlaybackSpeedRate (full resample + layer refresh).
     */
    public setPlaybackSpeedTargetOnly(rate: number): void {
        if (!this._sourcePcm) {
            return;
        }
        if (this._isPlaying) {
            this.setPlaybackSpeedRate(rate);
            return;
        }
        const r = Math.max(0.5, Math.min(2.0, rate));
        if (Math.abs(r - this._playbackSpeed) < 1e-5) {
            return;
        }
        this._playbackSpeed = r;
        this._playbackPcmDirty = true;
    }
    
    /**
     * Rebuild working PCM from stored Lyria buffer (linear resample).
     * If this pad is playing, restarts the layer with new PCM (crossfader volume preserved).
     */
    public setPlaybackSpeedRate(rate: number): void {
        if (!this._sourcePcm) {
            return;
        }
        const r = Math.max(0.5, Math.min(2.0, rate));
        if (Math.abs(r - this._playbackSpeed) < 1e-5) {
            return;
        }
        this._playbackSpeed = r;
        this._playbackPcmDirty = false;
        this.rebuildPlaybackPcmFromSource();
        
        const manager = AudioLayerManager.getInstance();
        if (this._isPlaying && this._layerIndex >= 0 && manager && this._audioData) {
            manager.replaceLayerPcmAndReplay(this._layerIndex, this._audioData);
            this.refreshStemLoopAfterPcmChange();
        }
    }
    
    private rebuildPlaybackPcmFromSource(): void {
        if (!this._sourcePcm) {
            return;
        }
        const specRatio = Math.pow(2, this._spectrumSemitones / 12);
        const totalRate = this._playbackSpeed * specRatio;
        if (Math.abs(totalRate - 1.0) < 1e-4) {
            this._audioData = new Uint8Array(this._sourcePcm);
        } else {
            this._audioData = resampleStereoS16Linear(this._sourcePcm, totalRate);
        }
    }
    
    private assignLoadedPcm(pcm: Uint8Array): void {
        this._sourcePcm = new Uint8Array(pcm);
        this._playbackSpeed = 1.0;
        this._spectrumSemitones = 0;
        this._playbackPcmDirty = false;
        this.rebuildPlaybackPcmFromSource();
    }
    
    // ═══════════════════════════════════════════════════════════════
    // VISUALS
    // ═══════════════════════════════════════════════════════════════
    
    private updateVisuals(): void {
        if (!this.padMesh) return;
        
        let material: Material | null = null;
        
        switch (this._state) {
            case PadState.Empty:
                material = this.emptyMaterial;
                break;
            case PadState.Loading:
                material = this.loadingMaterial;
                break;
            case PadState.Ready:
                material = this.readyMaterial;
                break;
            case PadState.Playing:
                material = this.playingMaterial;
                break;
            case PadState.Error:
                material = this.errorMaterial;
                break;
        }
        
        if (material) {
            this.padMesh.mainMaterial = material;
        }
    }
    
    /**
     * If buffer is a RIFF/WAVE file, return the raw PCM bytes from the "data" chunk only.
     * Otherwise return the buffer unchanged (already PCM).
     */
    private static stripWavToPcmIfPresent(bytes: Uint8Array): Uint8Array {
        if (bytes.length < 12) {
            return bytes;
        }
        const isRiff =
            bytes[0] === 0x52 &&
            bytes[1] === 0x49 &&
            bytes[2] === 0x46 &&
            bytes[3] === 0x46;
        const isWave =
            bytes[8] === 0x57 &&
            bytes[9] === 0x41 &&
            bytes[10] === 0x56 &&
            bytes[11] === 0x45;
        if (!isRiff || !isWave) {
            return bytes;
        }
        let offset = 12;
        while (offset + 8 <= bytes.length) {
            const c0 = bytes[offset];
            const c1 = bytes[offset + 1];
            const c2 = bytes[offset + 2];
            const c3 = bytes[offset + 3];
            const chunkSize =
                bytes[offset + 4] |
                (bytes[offset + 5] << 8) |
                (bytes[offset + 6] << 16) |
                (bytes[offset + 7] << 24);
            const dataStart = offset + 8;
            const isData = c0 === 0x64 && c1 === 0x61 && c2 === 0x74 && c3 === 0x61; // "data"
            if (isData) {
                const end = Math.min(dataStart + chunkSize, bytes.length);
                return bytes.subarray(dataStart, end);
            }
            let next = dataStart + chunkSize;
            if (chunkSize % 2 === 1) {
                next += 1;
            }
            offset = next;
        }
        print("[MidiPadController] WAV parse: no data chunk, using full buffer");
        return bytes;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // BASE64 DECODE (Lens Studio compatible - no atob)
    // ═══════════════════════════════════════════════════════════════
    
    /**
     * Decode base64 string to Uint8Array
     * Custom implementation that doesn't rely on atob
     */
    private decodeBase64(base64: string): Uint8Array {
        // Remove any whitespace and padding
        const cleanedBase64 = base64.replace(/[\s]/g, '');
        
        // Calculate output length
        let padding = 0;
        if (cleanedBase64.endsWith('==')) {
            padding = 2;
        } else if (cleanedBase64.endsWith('=')) {
            padding = 1;
        }
        
        const outputLength = Math.floor((cleanedBase64.length * 3) / 4) - padding;
        const output = new Uint8Array(outputLength);
        
        let outputIndex = 0;
        
        for (let i = 0; i < cleanedBase64.length; i += 4) {
            // Get indices for 4 base64 characters
            const c0 = this.getBase64CharIndex(cleanedBase64.charAt(i));
            const c1 = this.getBase64CharIndex(cleanedBase64.charAt(i + 1));
            const c2 = this.getBase64CharIndex(cleanedBase64.charAt(i + 2));
            const c3 = this.getBase64CharIndex(cleanedBase64.charAt(i + 3));
            
            // Combine into bytes
            if (outputIndex < outputLength) {
                output[outputIndex++] = (c0 << 2) | (c1 >> 4);
            }
            if (outputIndex < outputLength) {
                output[outputIndex++] = ((c1 & 0x0F) << 4) | (c2 >> 2);
            }
            if (outputIndex < outputLength) {
                output[outputIndex++] = ((c2 & 0x03) << 6) | c3;
            }
        }
        
        return output;
    }
    
    /**
     * Get index of base64 character
     */
    private getBase64CharIndex(char: string): number {
        if (char === '=') return 0;
        
        const index = MidiPadController.BASE64_CHARS.indexOf(char);
        if (index === -1) {
            print(`[Pad ${this.padIndex}] Invalid base64 character: ${char}`);
            return 0;
        }
        return index;
    }
}