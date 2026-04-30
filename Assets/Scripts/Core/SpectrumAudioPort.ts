/**
 * Minimal contract for {@link SpectrumRingReaction} (matches AETHER AudioEngineService
 * pitch / gate / expression surface without importing the full theremin stack).
 */
export interface SpectrumAudioPort {
    getMidi(): number;
    isNoteOn(): boolean;
    isMuted(): boolean;
    getExpression(): { left: number; right: number };
}
