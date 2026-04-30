/**
 * Isolated looped-theremin voice: reads {@link SpectrumPinchNavigator} bar index + pinch strength,
 * crossfades between {@link AudioComponent} tracks (AETHER-style overlap). Assign each track’s
 * **Audio Track** in Lens Studio and enable **Loop** on the clip / component as needed.
 *
 * {@link trackDocumentation} is **editor-only notes** (MIDI / note names / filenames per bar index);
 * it is never parsed at runtime.
 */

import { SpectrumPinchNavigator } from "./SpectrumPinchNavigator";

/** Lens Studio component id for {@link AudioComponent} (no `getTypeName` on this type in TS defs). */
const AUDIO_COMPONENT_TYPE = "Component.AudioComponent";

interface TrackFade {
    comp: AudioComponent;
    vol: number;
    dir: number;
}

@component
export class SpectrumThereminVoice extends BaseScriptComponent {
    @input
    @hint("SpectrumPinchNavigator ScriptComponent (same object as on scene).")
    spectrumPinchNavigator: ScriptComponent;

    @input
    @hint("Parent object whose **direct children** each have one AudioComponent, in bar order 0 → barCount−1.")
    thereminTrackHoldersParent: SceneObject;

    @input
    @hint("Approx. fade units per second between looped tracks (higher = faster).")
    crossfadeSpeed: number = 8;

    @input
    @hint("Fade-out voices stop when volume falls below this.")
    stopThreshold: number = 0.015;

    @input
    @hint("Bus multiplier on top of pinch expression.")
    masterTrim: number = 0.85;

    @input
    @hint("Log track changes.")
    debugLog: boolean = false;

    @input
    @hint(
        "Documentation only (not used at runtime). One line per bar index, e.g. `0 | C3 | MIDI 48 | theremin_C3`. Edit to match your Theremin_Track_00… order."
    )
    trackDocumentation: string =
        "0 | Bb3 | 58 | theremin_Bb3\n" +
        "1 | Bb4 | 70 | theremin_Bb4\n" +
        "2 | Bb5 | 82 | theremin_Bb5\n" +
        "3 | C3 | 48 | theremin_C3\n" +
        "4 | C4 | 60 | theremin_C4\n" +
        "5 | C5 | 72 | theremin_C5\n" +
        "6 | D4 | 62 | theremin_D4\n" +
        "7 | E4 | 64 | theremin_E4\n" +
        "8 | Eb3 | 51 | theremin_Eb3\n" +
        "9 | Eb4 | 63 | theremin_Eb4\n" +
        "10 | Eb5 | 75 | theremin_Eb5\n" +
        "11 | F3 | 53 | theremin_F3\n" +
        "12 | F4 | 65 | theremin_F4\n" +
        "13 | F5 | 77 | theremin_F5\n" +
        "14 | G3 | 55 | theremin_G3\n" +
        "15 | G4 | 67 | theremin_G4\n" +
        "16 | G5 | 79 | theremin_G5";

    private _nav: SpectrumPinchNavigator | null = null;
    private _tracks: AudioComponent[] = [];
    private _activeFades: TrackFade[] = [];
    private _targetTrackIndex: number = -1;
    private _fadingOut: boolean = false;
    private _wasNavigating: boolean = false;
    private _lastSector: number = -1;

    onAwake(): void {
        if (this.spectrumPinchNavigator) {
            const so = this.spectrumPinchNavigator.getSceneObject();
            this._nav = so.getComponent(SpectrumPinchNavigator.getTypeName()) as SpectrumPinchNavigator;
        }
        this.createEvent("OnStartEvent").bind(() => {
            this.rebuildTrackList();
            for (let i = 0; i < this._tracks.length; i++) {
                const c = this._tracks[i];
                if (!c) {
                    continue;
                }
                try {
                    c.stop(false);
                    c.volume = 0;
                } catch (_) {}
            }
        });
        this.createEvent("UpdateEvent").bind(() => this.onUpdate());
    }

    private rebuildTrackList(): void {
        this._tracks = [];
        if (!this.thereminTrackHoldersParent) {
            return;
        }
        const n = this.thereminTrackHoldersParent.getChildrenCount();
        for (let i = 0; i < n; i++) {
            const ch = this.thereminTrackHoldersParent.getChild(i);
            if (!ch) {
                continue;
            }
            const ac = ch.getComponent(AUDIO_COMPONENT_TYPE) as AudioComponent | null;
            if (ac) {
                this._tracks.push(ac);
            }
        }
        if (this.debugLog) {
            print(`[SpectrumThereminVoice] collected ${this._tracks.length} AudioComponent(s) from track holders.`);
        }
    }

    private onUpdate(): void {
        const dt = getDeltaTime();
        this.tickCrossfade(dt);

        const nav = this._nav;
        const navigating = nav !== null && nav.isSpectrumPinchNavigating();
        const sector = navigating && nav ? nav.getActiveSpectrumSectorIndex() : null;

        if (navigating && sector !== null && this._tracks.length > 0) {
            const idx = Math.max(0, Math.min(this._tracks.length - 1, sector));
            if (!this._wasNavigating || idx !== this._lastSector) {
                this.switchToTrackIndex(idx, !this._wasNavigating);
                this._lastSector = idx;
            }
            this._wasNavigating = true;
        } else {
            if (this._wasNavigating) {
                this.beginStopFade();
                this._lastSector = -1;
            }
            this._wasNavigating = false;
        }
    }

    private pinchBusMultiplier(): number {
        const nav = this._nav;
        if (!nav) {
            return this.masterTrim;
        }
        const e = Math.max(0, Math.min(1, nav.getLeadPinchStrength01()));
        return (0.35 + e * 0.65) * this.masterTrim;
    }

    private tickCrossfade(dt: number): void {
        if (this._activeFades.length === 0) {
            if (this._fadingOut) {
                this._fadingOut = false;
                this._targetTrackIndex = -1;
            }
            return;
        }
        const speed = Math.max(0.5, this.crossfadeSpeed);
        const bus = this.pinchBusMultiplier();
        const toRemove: number[] = [];

        for (let i = 0; i < this._activeFades.length; i++) {
            const f = this._activeFades[i];
            f.vol += f.dir * speed * dt;
            if (f.dir > 0) {
                f.vol = Math.min(f.vol, 1);
                try {
                    f.comp.volume = f.vol * bus;
                } catch (_) {}
            } else {
                f.vol = Math.max(f.vol, 0);
                try {
                    f.comp.volume = f.vol * bus;
                } catch (_) {}
                if (f.vol <= this.stopThreshold) {
                    try {
                        f.comp.stop(false);
                    } catch (_) {}
                    toRemove.push(i);
                }
            }
        }

        for (let j = toRemove.length - 1; j >= 0; j--) {
            this._activeFades.splice(toRemove[j], 1);
        }

        if (this._activeFades.length === 0 && this._fadingOut) {
            this._fadingOut = false;
            this._targetTrackIndex = -1;
        }
    }

    private syncFadeVolumes(): void {
        if (this._activeFades.length === 0) {
            return;
        }
        const bus = this.pinchBusMultiplier();
        for (const f of this._activeFades) {
            try {
                f.comp.volume = Math.max(0, Math.min(1, f.vol)) * bus;
            } catch (_) {}
        }
    }

    private switchToTrackIndex(idx: number, fromSilence: boolean): void {
        if (this._tracks.length === 0 || idx < 0 || idx >= this._tracks.length) {
            return;
        }
        if (idx === this._targetTrackIndex && !fromSilence) {
            this.syncFadeVolumes();
            return;
        }

        const comp = this._tracks[idx];
        if (!comp) {
            return;
        }

        if (this._fadingOut) {
            this._fadingOut = false;
            for (const f of this._activeFades) {
                if (f.dir < 0) {
                    f.dir = 1;
                }
            }
        }

        for (const f of this._activeFades) {
            if (f.dir > 0 && f.comp !== comp) {
                f.dir = -1;
            }
        }

        const existing = this._activeFades.find((f) => f.comp === comp);
        if (existing) {
            existing.dir = 1;
            this._targetTrackIndex = idx;
            this.syncFadeVolumes();
            return;
        }

        try {
            if (!comp.isPlaying()) {
                comp.volume = 0;
                comp.play(0);
            } else {
                comp.volume = 0;
            }
        } catch (e) {
            print("[SpectrumThereminVoice] play error idx=" + idx + ": " + e);
            return;
        }

        this._activeFades.push({ comp, vol: 0, dir: 1 });
        this._targetTrackIndex = idx;
        if (this.debugLog) {
            print("[SpectrumThereminVoice] → track " + idx);
        }
        this.syncFadeVolumes();
    }

    private beginStopFade(): void {
        if (this._fadingOut || this._activeFades.length === 0) {
            return;
        }
        this._fadingOut = true;
        for (const f of this._activeFades) {
            f.dir = -1;
        }
        if (this.debugLog) {
            print("[SpectrumThereminVoice] stop fade");
        }
    }
}
