/**
 * AudioLayerManager.ts
 * Manages 9 DynamicAudioOutput layers with owner-based allocation (one per pad)
 * Layers are dynamically acquired/released when pads play/stop
 *
 * **Spectacles / large stems:** Scaling multi‑MB PCM in TypeScript on every fader move can freeze
 * or crash the device. When an {@link AudioComponent} is found on the same pad hierarchy as the
 * DynamicAudioOutput script, we drive level with `AudioComponent.volume` (native) and send
 * **unity** PCM to `addAudioFrame`. Otherwise we fall back to JS `_applyVolume` (expensive).
 */

const AUDIO_COMPONENT_TYPE = "Component.AudioComponent";

@component
export class AudioLayerManager extends BaseScriptComponent {
    
    // ═══════════════════════════════════════════════════════════════
    // LAYER INPUTS (9 total — each DynamicAudioOutput must sit on the same SceneObject as an Audio component)
    // ═══════════════════════════════════════════════════════════════
    
    @input private _layer0: ScriptComponent;
    @input private _layer1: ScriptComponent;
    @input private _layer2: ScriptComponent;
    @input private _layer3: ScriptComponent;
    @input private _layer4: ScriptComponent;
    @input private _layer5: ScriptComponent;
    @input private _layer6: ScriptComponent;
    @input private _layer7: ScriptComponent;
    @input private _layer8: ScriptComponent;
    
    // ═══════════════════════════════════════════════════════════════
    // PRIVATE STATE
    // ═══════════════════════════════════════════════════════════════
    
    private _layers: any[] = [];
    private _layerInUse: boolean[] = [];
    private _layerOwner: (string | null)[] = [];
    private _layerVolumes: number[] = [];
    private _layerAudioData: (Uint8Array | null)[] = [];
    /** When set, layer volume is applied via AudioComponent.volume (no full-buffer rescale). */
    private _layerOutputAudio: (AudioComponent | null)[] = [];
    private _initialized: boolean = false;
    
    // Debounce control for volume changes
    private _pendingVolumeUpdate: boolean[] = [];
    private _volumeUpdateTimer: number[] = [];
    /** Slightly longer on device reduces PCM re-upload storms when UI sliders fire very fast. */
    private readonly DEBOUNCE_TIME: number = 0.28;
    /** Last volume actually pushed to DynamicAudioOutput (skip redundant native pumps). */
    private _lastVolumePushedToLayer: number[] = [];

    /**
     * Crossfader / UI can call applyLayerVolumeNow twice in one frame (A + B). Each call would
     * allocate a full scaled PCM buffer and pump native audio — peak memory and thread load on
     * Spectacles. Queue coalesces and we process at most one native apply per Update.
     */
    private _immediateVolumeQueue: { index: number; volume: number }[] = [];

    private readonly LAYER_COUNT: number = 9;
    
    // ═══════════════════════════════════════════════════════════════
    // SINGLETON
    // ═══════════════════════════════════════════════════════════════
    
    private static _instance: AudioLayerManager;
    public static getInstance(): AudioLayerManager {
        return AudioLayerManager._instance;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ═══════════════════════════════════════════════════════════════
    
    onAwake() {
        AudioLayerManager._instance = this;
        
        this.createEvent("OnStartEvent").bind(() => {
            this.initializeLayers();
        });
        
        this.createEvent("UpdateEvent").bind(() => {
            this.updateDebounceTimers();
        });
    }
    
    private initializeLayers(): void {
        this._layers = [
            this._layer0, this._layer1, this._layer2, this._layer3, this._layer4,
            this._layer5, this._layer6, this._layer7, this._layer8
        ];
        
        // Initialize arrays
        this._layerInUse = new Array(this.LAYER_COUNT).fill(false);
        this._layerOwner = new Array(this.LAYER_COUNT).fill(null);
        this._layerVolumes = new Array(this.LAYER_COUNT).fill(1.0);
        this._layerAudioData = new Array(this.LAYER_COUNT).fill(null);
        this._layerOutputAudio = new Array(this.LAYER_COUNT).fill(null);
        this._pendingVolumeUpdate = new Array(this.LAYER_COUNT).fill(false);
        this._volumeUpdateTimer = new Array(this.LAYER_COUNT).fill(0);
        this._lastVolumePushedToLayer = new Array(this.LAYER_COUNT).fill(-1);
        
        // Initialize each DynamicAudioOutput at 48kHz
        let validCount = 0;
        const gainLayerIndices: number[] = [];
        for (let i = 0; i < this._layers.length; i++) {
            if (this._layers[i]) {
                try {
                    this._layers[i].initialize(48000);
                    validCount++;
                    this._layerOutputAudio[i] = this.findLayerOutputAudioComponent(this._layers[i]);
                    if (this._layerOutputAudio[i]) {
                        gainLayerIndices.push(i);
                    }
                } catch (e) {
                    print(`[AudioLayerManager] Layer ${i} init error: ${e}`);
                }
            } else {
                print(`[AudioLayerManager] Layer ${i} is null`);
            }
        }
        if (gainLayerIndices.length === validCount && validCount > 0) {
            print(
                `[AudioLayerManager] Ready ${validCount}/${this.LAYER_COUNT} layers — **native gain** on all (crossfader does not rescale PCM)`
            );
        } else if (validCount > 0) {
            print(
                `[AudioLayerManager] Ready ${validCount}/${this.LAYER_COUNT} layers — native gain on [${gainLayerIndices.join(
                    ", "
                )}] only; other slots use **PCM scale** (heavy for long stems)`
            );
        }
        
        this._initialized = true;
    }
    
    private updateDebounceTimers(): void {
        const dt = getDeltaTime();

        for (let i = 0; i < this.LAYER_COUNT; i++) {
            if (this._pendingVolumeUpdate[i]) {
                this._volumeUpdateTimer[i] -= dt;
            }
        }

        while (this._immediateVolumeQueue.length > 0) {
            const item = this._immediateVolumeQueue.shift() as { index: number; volume: number };
            if (item.index < 0 || item.index >= this.LAYER_COUNT) {
                continue;
            }
            if (!this._layerInUse[item.index] || !this._layerAudioData[item.index]) {
                continue;
            }
            const v = Math.max(0, Math.min(1, item.volume));
            if (!isFinite(v)) {
                continue;
            }
            this._layerVolumes[item.index] = v;
            this._applyVolumeToLayer(item.index, false);
            return;
        }

        for (let i = 0; i < this.LAYER_COUNT; i++) {
            if (this._pendingVolumeUpdate[i] && this._volumeUpdateTimer[i] <= 0) {
                this._pendingVolumeUpdate[i] = false;
                this._applyVolumeToLayer(i, true);
                return;
            }
        }
    }

    private _enqueueApplyVolumeNow(index: number, volume: number): void {
        for (let k = 0; k < this._immediateVolumeQueue.length; k++) {
            if (this._immediateVolumeQueue[k].index === index) {
                this._immediateVolumeQueue[k].volume = volume;
                return;
            }
        }
        this._immediateVolumeQueue.push({ index, volume });
    }

    private _purgeImmediateVolumeQueueForLayer(index: number): void {
        if (this._immediateVolumeQueue.length === 0) {
            return;
        }
        const next: { index: number; volume: number }[] = [];
        for (let k = 0; k < this._immediateVolumeQueue.length; k++) {
            if (this._immediateVolumeQueue[k].index !== index) {
                next.push(this._immediateVolumeQueue[k]);
            }
        }
        this._immediateVolumeQueue = next;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // LAYER ACQUISITION
    // ═══════════════════════════════════════════════════════════════
    
    /**
     * Acquire a layer for a specific owner (pad)
     * @param ownerId Unique identifier for the pad (e.g., "g1_p0")
     * @returns Layer index, or -1 if no layers available
     */
    public acquireLayer(ownerId: string): number {
        // First check if this owner already has a layer
        for (let i = 0; i < this._layerOwner.length; i++) {
            if (this._layerOwner[i] === ownerId) {
                print(`[AudioLayerManager] Owner "${ownerId}" already has layer ${i}`);
                return i;
            }
        }
        
        // Find first available layer
        for (let i = 0; i < this._layerInUse.length; i++) {
            if (!this._layerInUse[i] && this._layers[i]) {
                this._layerInUse[i] = true;
                this._layerOwner[i] = ownerId;
                this._layerVolumes[i] = 1.0;
                this._layerAudioData[i] = null;
                print(`[AudioLayerManager] Acquired layer ${i} for "${ownerId}" (${this.getActiveLayerCount()}/${this.LAYER_COUNT} in use)`);
                return i;
            }
        }
        
        print(`[AudioLayerManager] No available layers! (${this.getActiveLayerCount()}/${this.LAYER_COUNT} in use)`);
        this.logLayerStatus();
        return -1;
    }
    
    /**
     * Release a layer by owner ID
     */
    public releaseLayerByOwner(ownerId: string): void {
        for (let i = 0; i < this._layerOwner.length; i++) {
            if (this._layerOwner[i] === ownerId) {
                this.releaseLayer(i);
                return;
            }
        }
        print(`[AudioLayerManager] No layer found for owner "${ownerId}"`);
    }
    
    /**
     * Release a layer by index
     */
    public releaseLayer(index: number): void {
        if (index < 0 || index >= this.LAYER_COUNT) return;
        
        const owner = this._layerOwner[index];
        
        // Stop audio first
        this.stopLayer(index);
        
        // Reset layer state
        this._layerInUse[index] = false;
        this._layerOwner[index] = null;
        this._layerAudioData[index] = null;
        this._layerVolumes[index] = 1.0;
        this._pendingVolumeUpdate[index] = false;
        this._volumeUpdateTimer[index] = 0;
        this._lastVolumePushedToLayer[index] = -1;
        this._purgeImmediateVolumeQueueForLayer(index);
        this.resetLayerHardwareVolume(index);

        print(`[AudioLayerManager] Released layer ${index} (was: "${owner}") - ${this.getActiveLayerCount()}/${this.LAYER_COUNT} in use`);
    }

    /**
     * Prefer AudioComponent on the DynamicAudioOutput SceneObject, then a child named
     * "DynamicAudioOutput", then first AudioComponent under the pad root (scene convention).
     */
    private findLayerOutputAudioComponent(layerScript: ScriptComponent): AudioComponent | null {
        const root = layerScript.getSceneObject();
        const fromScriptObj = root.getComponent(AUDIO_COMPONENT_TYPE) as AudioComponent | null;
        if (fromScriptObj) {
            return fromScriptObj;
        }
        for (let i = 0; i < root.getChildrenCount(); i++) {
            const ch = root.getChild(i);
            if (ch.name === "DynamicAudioOutput") {
                const ac = ch.getComponent(AUDIO_COMPONENT_TYPE) as AudioComponent | null;
                if (ac) {
                    return ac;
                }
            }
        }
        const stack: SceneObject[] = [];
        for (let i = 0; i < root.getChildrenCount(); i++) {
            stack.push(root.getChild(i));
        }
        while (stack.length > 0) {
            const o = stack.pop() as SceneObject;
            const ac = o.getComponent(AUDIO_COMPONENT_TYPE) as AudioComponent | null;
            if (ac) {
                return ac;
            }
            for (let j = 0; j < o.getChildrenCount(); j++) {
                stack.push(o.getChild(j));
            }
        }
        return null;
    }

    private resetLayerHardwareVolume(index: number): void {
        const ac = this._layerOutputAudio[index];
        if (ac) {
            ac.volume = 1.0;
        }
    }

    private usesHardwareLayerGain(index: number): boolean {
        return this._layerOutputAudio[index] !== null;
    }
    
    /**
     * Release ALL layers - call when switching genres
     */
    public releaseAllLayers(): void {
        print(`[AudioLayerManager] ═══ Releasing all layers ═══`);
        
        for (let i = 0; i < this.LAYER_COUNT; i++) {
            if (this._layerInUse[i]) {
                this.releaseLayer(i);
            }
        }
        
        print(`[AudioLayerManager] All layers released. Active: ${this.getActiveLayerCount()}`);
    }
    
    /**
     * Get layer index for an owner, or -1 if not found
     */
    public getLayerForOwner(ownerId: string): number {
        for (let i = 0; i < this._layerOwner.length; i++) {
            if (this._layerOwner[i] === ownerId) {
                return i;
            }
        }
        return -1;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // PLAYBACK CONTROL
    // ═══════════════════════════════════════════════════════════════
    
    /**
     * Play audio on a layer
     */
    public playOnLayer(index: number, audioData: Uint8Array): void {
        if (index < 0 || index >= this.LAYER_COUNT) {
            print(`[AudioLayerManager] Invalid layer index: ${index}`);
            return;
        }
        
        const layer = this._layers[index];
        if (!layer) {
            print(`[AudioLayerManager] Layer ${index} is null`);
            return;
        }
        
        // Store audio data for volume updates
        this._layerAudioData[index] = audioData;
        this._pendingVolumeUpdate[index] = false;
        this._volumeUpdateTimer[index] = 0;
        this._purgeImmediateVolumeQueueForLayer(index);

        const useHwGain = this.usesHardwareLayerGain(index);
        const adjustedAudio = useHwGain
            ? audioData
            : this._applyVolume(audioData, this._layerVolumes[index]);
        
        try {
            // Interrupt current playback
            if (typeof layer.interruptAudioOutput === 'function') {
                layer.interruptAudioOutput();
            } else {
                layer.initialize(48000);
            }
            
            // Play new audio
            layer.addAudioFrame(adjustedAudio, 2); // 2 = stereo

            if (useHwGain && this._layerOutputAudio[index]) {
                this._layerOutputAudio[index].volume = Math.max(
                    0,
                    Math.min(1, this._layerVolumes[index])
                );
            }
            
            const owner = this._layerOwner[index] || "unknown";
            print(`[AudioLayerManager] ▶ Playing on layer ${index} (${owner}) at ${Math.round(this._layerVolumes[index] * 100)}%`);
            this._lastVolumePushedToLayer[index] = this._layerVolumes[index];
        } catch (e) {
            print(`[AudioLayerManager] Play error on layer ${index}: ${e}`);
        }
    }
    
    /**
     * Replace PCM for an active layer and restart playback (same volume).
     * Used after in-place resample / tempo tweak on the pad.
     */
    public replaceLayerPcmAndReplay(index: number, audioData: Uint8Array): void {
        if (index < 0 || index >= this.LAYER_COUNT) {
            return;
        }
        if (!this._layerInUse[index]) {
            return;
        }
        const layer = this._layers[index];
        if (!layer) {
            return;
        }
        
        this._layerAudioData[index] = audioData;
        this._pendingVolumeUpdate[index] = false;
        this._volumeUpdateTimer[index] = 0;
        this._purgeImmediateVolumeQueueForLayer(index);

        const useHwGain = this.usesHardwareLayerGain(index);
        const adjustedAudio = useHwGain
            ? audioData
            : this._applyVolume(audioData, this._layerVolumes[index]);
        
        try {
            if (typeof layer.interruptAudioOutput === "function") {
                layer.interruptAudioOutput();
            } else {
                layer.initialize(48000);
            }
            layer.addAudioFrame(adjustedAudio, 2);
            if (useHwGain && this._layerOutputAudio[index]) {
                this._layerOutputAudio[index].volume = Math.max(
                    0,
                    Math.min(1, this._layerVolumes[index])
                );
            }
            this._lastVolumePushedToLayer[index] = this._layerVolumes[index];
        } catch (e) {
            print(`[AudioLayerManager] replaceLayerPcmAndReplay error on layer ${index}: ${e}`);
        }
    }
    
    /**
     * Stop a layer
     */
    public stopLayer(index: number): void {
        if (index < 0 || index >= this.LAYER_COUNT) return;
        
        const layer = this._layers[index];
        if (!layer) return;
        
        try {
            if (typeof layer.interruptAudioOutput === 'function') {
                layer.interruptAudioOutput();
            } else {
                layer.initialize(48000);
            }
            print(`[AudioLayerManager] ⏹ Stopped layer ${index}`);
        } catch (e) {
            print(`[AudioLayerManager] Stop error on layer ${index}: ${e}`);
        }
    }
    
    /**
     * Stop all layers (without releasing)
     */
    public stopAll(): void {
        for (let i = 0; i < this.LAYER_COUNT; i++) {
            if (this._layers[i]) {
                try {
                    if (typeof this._layers[i].interruptAudioOutput === 'function') {
                        this._layers[i].interruptAudioOutput();
                    } else {
                        this._layers[i].initialize(48000);
                    }
                } catch (e) {}
            }
        }
        print(`[AudioLayerManager] Stopped all layers`);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // VOLUME CONTROL
    // ═══════════════════════════════════════════════════════════════
    
    /**
     * Set layer volume (0.0 to 1.0) - debounced
     */
    public setLayerVolume(index: number, volume: number): void {
        if (index < 0 || index >= this.LAYER_COUNT) return;
        
        const clampedVolume = Math.max(0, Math.min(1, volume));
        this._layerVolumes[index] = clampedVolume;
        
        // Only trigger debounced update if we have audio data
        if (this._layerAudioData[index]) {
            this._pendingVolumeUpdate[index] = true;
            this._volumeUpdateTimer[index] = this.DEBOUNCE_TIME;
        }
    }
    
    /**
     * Apply layer volume immediately (no debounce). Use for crossfader / continuous UI.
     */
    public applyLayerVolumeNow(index: number, volume: number): void {
        if (index < 0 || index >= this.LAYER_COUNT) return;

        const clampedVolume = Math.max(0, Math.min(1, volume));
        this._layerVolumes[index] = clampedVolume;
        this._pendingVolumeUpdate[index] = false;
        this._volumeUpdateTimer[index] = 0;

        if (this._layerAudioData[index] && this._layerInUse[index]) {
            this._enqueueApplyVolumeNow(index, clampedVolume);
        }
    }
    
    /**
     * Get layer volume
     */
    public getLayerVolume(index: number): number {
        if (index < 0 || index >= this.LAYER_COUNT) return 0;
        return this._layerVolumes[index];
    }
    
    /**
     * Apply pending volume change to layer (called after debounce)
     */
    private _applyVolumeToLayer(index: number, skipIfTinyChange: boolean): void {
        const audioData = this._layerAudioData[index];
        const layer = this._layers[index];
        
        if (!audioData || !layer) return;

        const vol = this._layerVolumes[index];
        if (!isFinite(vol)) {
            return;
        }
        const last = this._lastVolumePushedToLayer[index];
        if (skipIfTinyChange && last >= 0 && Math.abs(vol - last) < 0.001) {
            return;
        }

        const ac = this._layerOutputAudio[index];
        if (ac) {
            ac.volume = Math.max(0, Math.min(1, vol));
            this._lastVolumePushedToLayer[index] = vol;
            return;
        }
        
        const adjustedAudio = this._applyVolume(audioData, vol);
        
        try {
            if (typeof layer.interruptAudioOutput === 'function') {
                layer.interruptAudioOutput();
            } else {
                layer.initialize(48000);
            }
            layer.addAudioFrame(adjustedAudio, 2);
            this._lastVolumePushedToLayer[index] = vol;
        } catch (e) {
            print(`[AudioLayerManager] Volume apply error on layer ${index}: ${e}`);
        }
    }
    
    /**
     * Apply volume to PCM audio data (16-bit stereo)
     */
    private _applyVolume(audioData: Uint8Array, volume: number): Uint8Array {
        // Skip processing if full volume
        if (volume >= 0.99) return audioData;
        
        // Return silence if muted
        if (volume <= 0.01) {
            return new Uint8Array(audioData.length);
        }
        
        const adjusted = new Uint8Array(audioData.length);
        
        // Process 16-bit samples (2 bytes per sample)
        for (let i = 0; i < audioData.length; i += 2) {
            // Read 16-bit sample (little-endian)
            let sample = audioData[i] | (audioData[i + 1] << 8);
            
            // Handle signed conversion
            if (sample > 32767) sample -= 65536;
            
            // Apply volume
            sample = Math.round(sample * volume);
            
            // Clamp to valid range
            sample = Math.max(-32768, Math.min(32767, sample));
            
            // Convert back to unsigned
            if (sample < 0) sample += 65536;
            
            // Write back (little-endian)
            adjusted[i] = sample & 0xFF;
            adjusted[i + 1] = (sample >> 8) & 0xFF;
        }
        
        return adjusted;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // STATUS / GETTERS
    // ═══════════════════════════════════════════════════════════════
    
    public isReady(): boolean {
        return this._initialized;
    }
    
    public isLayerInUse(index: number): boolean {
        if (index < 0 || index >= this.LAYER_COUNT) return false;
        return this._layerInUse[index];
    }
    
    public hasAudioData(index: number): boolean {
        if (index < 0 || index >= this.LAYER_COUNT) return false;
        return this._layerAudioData[index] !== null;
    }
    
    public getActiveLayerCount(): number {
        return this._layerInUse.filter(inUse => inUse).length;
    }
    
    public getAvailableLayerCount(): number {
        return this._layerInUse.filter(inUse => !inUse).length;
    }
    
    public getTotalLayerCount(): number {
        return this.LAYER_COUNT;
    }
    
    public getLayerOwner(index: number): string | null {
        if (index < 0 || index >= this.LAYER_COUNT) return null;
        return this._layerOwner[index];
    }
    
    /**
     * Log current layer status (for debugging)
     */
    public logLayerStatus(): void {
        print(`[AudioLayerManager] ═══ Layer Status ═══`);
        for (let i = 0; i < this.LAYER_COUNT; i++) {
            const status = this._layerInUse[i] ? "IN USE" : "FREE";
            const owner = this._layerOwner[i] || "-";
            const volume = Math.round(this._layerVolumes[i] * 100);
            print(`  Layer ${i}: ${status} | Owner: ${owner} | Vol: ${volume}%`);
        }
        print(`[AudioLayerManager] Total: ${this.getActiveLayerCount()}/${this.LAYER_COUNT} in use`);
    }
}