/**
 * DotPoolVisualizer.ts
 * Particle visualizer that responds to track volumes
 * Updated to work with MidiPadController and AudioLayerManager
 */

import { AudioLayerManager } from "./AudioLayerManager";
import { TrackColorManager } from "./TrackColorManager";

@component
export class DotPoolVisualizer extends BaseScriptComponent {
    
    @input
    @hint("Container for all dots")
    dotContainer: SceneObject;
    
    @input
    @hint("Prefab for each dot (sphere mesh)")
    dotPrefab: ObjectPrefab;
    
    @input
    @hint("Number of dots per track")
    dotsPerTrack: number = 12;
    
    @input
    @hint("Width of the dot pool area")
    poolWidth: number = 50;
    
    @input
    @hint("Height of the dot pool area")
    poolHeight: number = 30;
    
    @input
    @hint("Depth of the dot pool area")
    poolDepth: number = 10;
    
    @input
    @hint("Base size of dots when at low volume")
    baseDotSize: number = 1.5;
    
    @input
    @hint("Maximum size of dots when at full volume")
    maxDotSize: number = 4.0;
    
    @input
    @hint("Speed of floating animation")
    animationSpeed: number = 1.0;
    
    @input
    @hint("Amplitude of floating movement")
    floatAmplitude: number = 3.0;
    
    // Store dots per track
    private _trackDots: Map<number, { 
        dots: SceneObject[], 
        materials: Material[],
        basePositions: vec3[],
        phases: number[],
        speedVariations: number[]
    }> = new Map();
    
    // Track which tracks are actually generated/active
    private _activeTrackIndices: number[] = [];
    
    private _time: number = 0;
    private _initialized: boolean = false;
    private _colorManager: TrackColorManager | null = null;
    
    private static _instance: DotPoolVisualizer;
    
    public static getInstance(): DotPoolVisualizer {
        return DotPoolVisualizer._instance;
    }
    
    onAwake() {
        DotPoolVisualizer._instance = this;
        
        this.createEvent("OnStartEvent").bind(() => {
            this._colorManager = TrackColorManager.getInstance();
            
            if (!this._colorManager) {
                print("[DotPoolVisualizer] WARNING: TrackColorManager not found!");
            } else {
                print("[DotPoolVisualizer] ✓ Connected to TrackColorManager");
            }
            
            this._initialized = true;
            print("[DotPoolVisualizer] Ready - waiting for tracks to be registered");
        });
        
        this.createEvent("UpdateEvent").bind(() => {
            this.updateDots();
        });
    }
    
    /**
     * Register a track for visualization
     * Called when a pad is configured/loaded
     */
    public registerTrack(trackIndex: number) {
        if (this._trackDots.has(trackIndex)) {
            print("[DotPoolVisualizer] Track " + trackIndex + " already registered");
            return;
        }
        
        if (!this.dotContainer || !this.dotPrefab) {
            print("[DotPoolVisualizer] ERROR: Missing dotContainer or dotPrefab!");
            return;
        }
        
        const color = this.getTrackColor(trackIndex);
        
        print("[DotPoolVisualizer] Registering track " + trackIndex + 
              " - Color: R=" + color.r.toFixed(2) + " G=" + color.g.toFixed(2) + " B=" + color.b.toFixed(2));
        
        const trackData: { 
            dots: SceneObject[], 
            materials: Material[],
            basePositions: vec3[],
            phases: number[],
            speedVariations: number[]
        } = {
            dots: [],
            materials: [],
            basePositions: [],
            phases: [],
            speedVariations: []
        };
        
        // Create dots for this track
        for (let i = 0; i < this.dotsPerTrack; i++) {
            const dot = this.dotPrefab.instantiate(this.dotContainer);
            
            // Random position within pool area
            const x = (Math.random() - 0.5) * this.poolWidth;
            const y = (Math.random() - 0.5) * this.poolHeight;
            const z = (Math.random() - 0.5) * this.poolDepth;
            
            const basePos = new vec3(x, y, z);
            dot.getTransform().setLocalPosition(basePos);
            
            // Start hidden (scale 0)
            dot.getTransform().setLocalScale(new vec3(0, 0, 0));
            
            // Clone and color material
            let material: Material | null = null;
            
            const meshVisual = dot.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            if (meshVisual && meshVisual.mainMaterial) {
                material = meshVisual.mainMaterial.clone();
                material.mainPass.baseColor = color;
                meshVisual.mainMaterial = material;
            }
            
            if (!material) {
                const image = dot.getComponent("Component.Image") as Image;
                if (image && image.mainMaterial) {
                    material = image.mainMaterial.clone();
                    material.mainPass.baseColor = color;
                    image.mainMaterial = material;
                }
            }
            
            // Random animation phase and speed variation
            const phase = Math.random() * Math.PI * 2;
            const speedVar = 0.7 + Math.random() * 0.6;
            
            trackData.dots.push(dot);
            trackData.materials.push(material!);
            trackData.basePositions.push(basePos);
            trackData.phases.push(phase);
            trackData.speedVariations.push(speedVar);
        }
        
        this._trackDots.set(trackIndex, trackData);
        this._activeTrackIndices.push(trackIndex);
        
        print("[DotPoolVisualizer] ✓ Track " + trackIndex + " registered with " + this.dotsPerTrack + " dots");
        print("[DotPoolVisualizer] Total active tracks: " + this._activeTrackIndices.length);
    }
    
    /**
     * Clear all tracks (called when switching genres)
     */
    public clearAllTracks() {
        // Destroy all dots
        this._trackDots.forEach((trackData, trackIndex) => {
            for (const dot of trackData.dots) {
                if (dot) {
                    dot.destroy();
                }
            }
        });
        
        this._trackDots.clear();
        this._activeTrackIndices = [];
        
        print("[DotPoolVisualizer] Cleared all tracks and dots");
    }
    
    /**
     * Remove a specific track
     */
    public unregisterTrack(trackIndex: number) {
        const trackData = this._trackDots.get(trackIndex);
        if (trackData) {
            for (const dot of trackData.dots) {
                if (dot) {
                    dot.destroy();
                }
            }
            this._trackDots.delete(trackIndex);
            
            const idx = this._activeTrackIndices.indexOf(trackIndex);
            if (idx >= 0) {
                this._activeTrackIndices.splice(idx, 1);
            }
            
            print("[DotPoolVisualizer] Unregistered track " + trackIndex);
        }
    }
    
    /**
     * Get color from TrackColorManager or use fallback
     */
    private getTrackColor(trackIndex: number): vec4 {
        if (this._colorManager) {
            return this._colorManager.getColorForTrack(trackIndex);
        }
        
        // Fallback colors
        const fallbackColors: vec4[] = [
            new vec4(1.0, 0.2, 0.4, 1.0),   // 0: Hot Pink
            new vec4(0.2, 0.6, 1.0, 1.0),   // 1: Electric Blue
            new vec4(0.4, 1.0, 0.4, 1.0),   // 2: Lime Green
            new vec4(1.0, 0.8, 0.2, 1.0),   // 3: Golden Yellow
            new vec4(0.8, 0.4, 1.0, 1.0),   // 4: Purple
            new vec4(1.0, 0.5, 0.2, 1.0),   // 5: Orange
            new vec4(0.2, 1.0, 0.8, 1.0),   // 6: Cyan
            new vec4(1.0, 0.4, 0.6, 1.0),   // 7: Coral
            new vec4(0.6, 0.8, 1.0, 1.0),   // 8: Sky Blue
            new vec4(0.8, 1.0, 0.4, 1.0),   // 9: Lime Yellow
        ];
        
        return fallbackColors[trackIndex % fallbackColors.length];
    }
    
    /**
     * Update dots every frame based on track volumes
     */
    private updateDots() {
        if (!this._initialized) return;
        
        // No tracks registered = nothing to show
        if (this._activeTrackIndices.length === 0) return;
        
        const layerManager = AudioLayerManager.getInstance();
        if (!layerManager) return;
        
        this._time += getDeltaTime() * this.animationSpeed;
        
        // Update dots for each registered track
        for (const trackIndex of this._activeTrackIndices) {
            const volume = layerManager.getLayerVolume(trackIndex);
            const trackData = this._trackDots.get(trackIndex);
            
            if (!trackData) continue;
            
            // Calculate how many dots to show based on volume
            const activeDotCount = Math.floor(volume * this.dotsPerTrack);
            
            // Get track color for pulsing
            const baseColor = this.getTrackColor(trackIndex);
            
            for (let i = 0; i < trackData.dots.length; i++) {
                const dot = trackData.dots[i];
                const basePos = trackData.basePositions[i];
                const phase = trackData.phases[i];
                const speedVar = trackData.speedVariations[i];
                
                if (!dot) continue;
                
                if (i < activeDotCount && volume > 0.01) {
                    // ACTIVE dot - show and animate
                    
                    // Floating animation
                    const floatX = Math.sin(this._time * 0.5 * speedVar + phase) * this.floatAmplitude;
                    const floatY = Math.cos(this._time * 0.7 * speedVar + phase * 1.3) * this.floatAmplitude * 0.8;
                    const floatZ = Math.sin(this._time * 0.3 * speedVar + phase * 0.7) * this.floatAmplitude * 0.5;
                    
                    const newPos = new vec3(
                        basePos.x + floatX,
                        basePos.y + floatY,
                        basePos.z + floatZ
                    );
                    dot.getTransform().setLocalPosition(newPos);
                    
                    // Size with pulsing
                    const pulse = 1 + Math.sin(this._time * 2.5 * speedVar + phase) * 0.25;
                    const sizeRange = this.maxDotSize - this.baseDotSize;
                    const size = (this.baseDotSize + volume * sizeRange) * pulse;
                    dot.getTransform().setLocalScale(new vec3(size, size, size));
                    
                    // Brightness pulse
                    if (trackData.materials[i]) {
                        const brightness = 0.7 + Math.sin(this._time * 3 * speedVar + phase) * 0.3;
                        const pulsedColor = new vec4(
                            Math.min(1.0, baseColor.r * brightness * (0.8 + volume * 0.4)),
                            Math.min(1.0, baseColor.g * brightness * (0.8 + volume * 0.4)),
                            Math.min(1.0, baseColor.b * brightness * (0.8 + volume * 0.4)),
                            1.0
                        );
                        try {
                            trackData.materials[i].mainPass.baseColor = pulsedColor;
                        } catch (e) {}
                    }
                } else {
                    // INACTIVE dot - shrink smoothly
                    const currentScale = dot.getTransform().getLocalScale();
                    if (currentScale.x > 0.01) {
                        const shrinkSpeed = 5.0 * getDeltaTime();
                        const newScale = Math.max(0, currentScale.x - shrinkSpeed);
                        dot.getTransform().setLocalScale(new vec3(newScale, newScale, newScale));
                    } else {
                        dot.getTransform().setLocalScale(new vec3(0, 0, 0));
                    }
                }
            }
        }
    }
    
    /**
     * Get number of registered tracks
     */
    public getRegisteredTrackCount(): number {
        return this._activeTrackIndices.length;
    }
    
    /**
     * Check if a track is registered
     */
    public isTrackRegistered(trackIndex: number): boolean {
        return this._trackDots.has(trackIndex);
    }
}