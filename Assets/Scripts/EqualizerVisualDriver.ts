/**
 * Equalizer visuals for the Out01Mon (or any) mesh:
 *
 * **Single material (default):** clones `equalizerMesh.mainMaterial` (or `equalizerMaterial` if set)
 * and drives `padPlaybackGate` (0–1) when any pad is playing with PCM.
 *
 * **Dual materials:** assign `equalizerMaterialAnimated` (re-imported animated shader). The mesh
 * uses the **idle** clone (`equalizerMaterial` if set, else the mesh’s material at start) until a
 * track pad is **playing** with **ready** audio (`hasAudio`, not Loading/Error), then switches to
 * the animated clone. Gate is written on whichever material is active (ignored if that shader has
 * no matching property).
 */

import { DJMidiManager } from "./DJMidiManager";
import { MidiPadController, PadState } from "./MidiPadController";

const PROP_CANDIDATES = [
    "padPlaybackGate",
    "pad Playback Gate",
    "pad_Playback_Gate",
    "PadPlaybackGate",
    "Pad Playback Gate",
];

@component
export class EqualizerVisualDriver extends BaseScriptComponent {
    @input
    @hint("DJMidiManager (shared pad grid).")
    djMidiManager: DJMidiManager;

    @input
    @hint("RenderMeshVisual on the equalizer object (e.g. Out01Mon).")
    equalizerMesh: RenderMeshVisual;

    @input
    @allowUndefined
    @hint("Idle / static material when `equalizerMaterialAnimated` is set (cloned). If animated is unset, optional override source for the single cloned material.")
    equalizerMaterial: Material;

    @input
    @allowUndefined
    @hint("Animated equalizer material (cloned). When set, mesh swaps idle ↔ animated while any pad is playing with ready audio.")
    equalizerMaterialAnimated: Material;

    private _idleClone: Material | null = null;
    private _animClone: Material | null = null;
    private _usingAnimated: boolean = false;
    private _loggedGateMissingOnce = false;

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.onStart());
        this.createEvent("UpdateEvent").bind(() => this.onUpdate());
    }

    private onStart(): void {
        if (!this.equalizerMesh) {
            print("[EqualizerVisualDriver] Assign equalizerMesh (RenderMeshVisual).");
            return;
        }
        const mesh = this.equalizerMesh;
        const animAsset = this.equalizerMaterialAnimated;

        if (animAsset) {
            const idleSource = this.equalizerMaterial || mesh.mainMaterial;
            if (!idleSource) {
                print("[EqualizerVisualDriver] Need a static idle material (assign equalizerMaterial or set mesh material).");
                return;
            }
            this._idleClone = idleSource.clone();
            this._animClone = animAsset.clone();
            mesh.mainMaterial = this._idleClone;
            this._usingAnimated = false;
        } else {
            this._animClone = null;
            const src = this.equalizerMaterial || mesh.mainMaterial;
            if (src) {
                this._idleClone = src.clone();
                mesh.mainMaterial = this._idleClone;
            } else {
                print("[EqualizerVisualDriver] No material on mesh and equalizerMaterial is unset.");
            }
        }

        this.applyGateToCurrentMaterial(0);
    }

    private writePadPlaybackGate(mat: Material | null, v: number): void {
        if (!mat || !mat.mainPass) {
            return;
        }
        const pass = mat.mainPass as any;
        for (let i = 0; i < PROP_CANDIDATES.length; i++) {
            const n = PROP_CANDIDATES[i];
            try {
                pass[n] = v;
                return;
            } catch (_) {
                /* try next */
            }
        }
        if (!this._loggedGateMissingOnce) {
            this._loggedGateMissingOnce = true;
            print(
                "[EqualizerVisualDriver] No padPlaybackGate-style float on this material — add a matching Script/Dynamic input if the shader should react."
            );
        }
    }

    private applyGateToCurrentMaterial(v: number): void {
        this.writePadPlaybackGate(this.equalizerMesh?.mainMaterial ?? null, v);
    }

    private onUpdate(): void {
        const live = this.computePadsPlayingWithReadyAudio();
        const gate = live ? 1.0 : 0.0;

        if (this._animClone && this._idleClone) {
            if (live !== this._usingAnimated) {
                this._usingAnimated = live;
                this.equalizerMesh.mainMaterial = live ? this._animClone : this._idleClone;
            }
            this.applyGateToCurrentMaterial(gate);
            return;
        }

        this.applyGateToCurrentMaterial(gate);
    }

    /** True when a pad is actively playing PCM and not in Loading/Empty/Error. */
    private computePadsPlayingWithReadyAudio(): boolean {
        const pads = this.collectPads();
        for (let i = 0; i < pads.length; i++) {
            const p = pads[i];
            if (!p || !p.hasAudio() || !p.isPlaying()) {
                continue;
            }
            const st = p.getState();
            if (st === PadState.Loading || st === PadState.Empty || st === PadState.Error) {
                continue;
            }
            return true;
        }
        return false;
    }

    private collectPads(): MidiPadController[] {
        if (!this.djMidiManager) {
            return [];
        }
        const shared = this.djMidiManager.getSharedMidiPads();
        if (shared.length > 0) {
            return shared;
        }
        const grid = this.djMidiManager.getMidiPadGrid();
        if (!grid) {
            return [];
        }
        return EqualizerVisualDriver.collectPadsUnderGrid(grid);
    }

    private static collectPadsUnderGrid(grid: SceneObject): MidiPadController[] {
        const pads: MidiPadController[] = [];
        const n = grid.getChildrenCount();
        for (let i = 0; i < n; i++) {
            const c = grid.getChild(i);
            if (!c) {
                continue;
            }
            const pad = c.getComponent(MidiPadController.getTypeName()) as MidiPadController;
            if (pad) {
                pads.push(pad);
            }
        }
        pads.sort((a, b) => a.getPadIndex() - b.getPadIndex());
        return pads;
    }
}
