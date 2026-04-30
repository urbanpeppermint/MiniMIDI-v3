/**
 * TrackColorManager.ts
 * Manages colors for tracks - singleton pattern
 */

@component
export class TrackColorManager extends BaseScriptComponent {
    
    private static _instance: TrackColorManager;
    
    // Vibrant color palette for tracks
    private _colors: vec4[] = [
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
    
    public static getInstance(): TrackColorManager {
        return TrackColorManager._instance;
    }
    
    onAwake() {
        TrackColorManager._instance = this;
        print("[TrackColorManager] Initialized with " + this._colors.length + " colors");
    }
    
    /**
     * Get color for a track index
     */
    public getColorForTrack(trackIndex: number): vec4 {
        if (trackIndex >= 0 && trackIndex < this._colors.length) {
            return this._colors[trackIndex];
        }
        // Wrap around for indices beyond color count
        return this._colors[trackIndex % this._colors.length];
    }
    
    /**
     * Get all colors
     */
    public getAllColors(): vec4[] {
        return this._colors;
    }
    
    /**
     * Get color count
     */
    public getColorCount(): number {
        return this._colors.length;
    }
}