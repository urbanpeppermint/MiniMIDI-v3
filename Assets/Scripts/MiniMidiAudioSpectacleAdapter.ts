import { ServiceLocator, SERVICE_KEYS } from "./Core/ServiceLocator";
import type { SpectrumAudioPort } from "./Core/SpectrumAudioPort";
import { DJMidiManager } from "./DJMidiManager";
import { AudioLayerManager } from "./AudioLayerManager";
import { getGenreByMode, getGenreCount } from "./GenreInstrumentData";
import { SpectrumPinchNavigator } from "./SpectrumPinchNavigator";

/**
 * MODE A — registers {@link SERVICE_KEYS.audio} for {@link SpectrumRingReaction}.
 * Lyria / pad state → synthetic MIDI when no spectrum navigation is active.
 * When {@link spectrumPinchNavigator} is assigned and the user is navigating the spectrum ring,
 * MIDI / note-on reflect that **overlay** (bars / semitones), not pad playback.
 */
@component
export class MiniMidiAudioSpectacleAdapter extends BaseScriptComponent implements SpectrumAudioPort {
    @input
    @hint("Main DJ controller (pads, genres, BPM).")
    djMidiManager: DJMidiManager;

    @input
    @hint("Optional: SpectrumPinchNavigator ScriptComponent — while pinching the spectrum, ring hue uses overlay MIDI from bar + radial semitones.")
    @allowUndefined
    spectrumPinchNavigator: ScriptComponent;

    private _spectrumNav: SpectrumPinchNavigator | null = null;

    onAwake(): void {
        ServiceLocator.instance.register<SpectrumAudioPort>(SERVICE_KEYS.audio, this);
        if (this.spectrumPinchNavigator) {
            const so = this.spectrumPinchNavigator.getSceneObject();
            this._spectrumNav = so.getComponent(SpectrumPinchNavigator.getTypeName()) as SpectrumPinchNavigator;
        }
    }

    private spectrumOverlayActive(): boolean {
        return this._spectrumNav !== null && this._spectrumNav.isSpectrumPinchNavigating();
    }

    public getMidi(): number {
        if (this.spectrumOverlayActive()) {
            return this._spectrumNav!.getOverlayMidiForVisual();
        }
        const dm = this.djMidiManager;
        if (!dm) {
            return 60;
        }
        const mode = dm.getCurrentMode();
        const genre = mode >= 1 && mode <= getGenreCount() ? getGenreByMode(mode) : null;
        const baseBpm = genre && genre.bpm > 0 ? genre.bpm : 120;

        const pads = dm.getPadsForCurrentMode();
        const layers = AudioLayerManager.getInstance();
        let bestIdx = -1;
        let bestVol = -1;
        for (let i = 0; i < pads.length; i++) {
            const p = pads[i];
            if (!p || !p.isPlaying()) {
                continue;
            }
            const li = p.getLayerIndex();
            const v =
                layers && li >= 0 && li < layers.getTotalLayerCount()
                    ? layers.getLayerVolume(li)
                    : 0.5;
            if (v > bestVol) {
                bestVol = v;
                bestIdx = i;
            }
        }

        if (bestIdx >= 0) {
            const p = pads[bestIdx];
            const stem = p.getStemEffectiveBpm();
            const effBpm = stem !== null && stem > 0 ? stem : baseBpm;
            const fromBpm = 48 + Math.min(36, Math.max(0, (effBpm - 72) * 0.35));
            const spread = Math.max(48, Math.min(84, Math.round(fromBpm + bestIdx * 1.5)));
            return spread;
        }

        const idle = 48 + Math.min(36, Math.max(0, (baseBpm - 72) * 0.25));
        return Math.max(48, Math.min(84, Math.round(idle)));
    }

    public isNoteOn(): boolean {
        if (this.spectrumOverlayActive()) {
            return true;
        }
        const pads = this.djMidiManager?.getPadsForCurrentMode();
        if (!pads) {
            return false;
        }
        for (let i = 0; i < pads.length; i++) {
            if (pads[i] && pads[i].isPlaying()) {
                return true;
            }
        }
        return false;
    }

    public isMuted(): boolean {
        return false;
    }

    public getExpression(): { left: number; right: number } {
        if (this.spectrumOverlayActive() && this._spectrumNav) {
            const e = this._spectrumNav.getLeadPinchStrength01();
            return { left: e, right: e };
        }
        const layers = AudioLayerManager.getInstance();
        if (!layers) {
            return { left: 0, right: 0 };
        }
        const n = layers.getTotalLayerCount();
        let left = 0;
        let right = 0;
        for (let i = 0; i < n; i++) {
            const v = layers.getLayerVolume(i);
            if (i < n / 2) {
                left = Math.max(left, v);
            } else {
                right = Math.max(right, v);
            }
        }
        return { left, right };
    }
}
