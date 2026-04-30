// Helper DSP class
class FractionalPlayer {
    private buf: Float32Array;
    private len: number;
    private playhead = 0;
    private speed = 1.0;
    private playing = false;

    constructor(buffer: Float32Array) {
        this.buf = buffer;
        this.len = buffer.length;
    }

    public reset() {
        this.playhead = 0;
        this.playing = true;
    }

    public stop() {
        this.playing = false;
    }

    public setSpeed(factor: number) {
        this.speed = factor;
    }

    public getSamples(out: Float32Array, numSamples: number) {
        if (!this.playing || this.speed <= 0) return;
        for (let i = 0; i < numSamples; i++) {
            const idx = this.playhead % this.len;
            const i0 = Math.floor(idx);
            const i1 = (i0 + 1) % this.len;
            const frac = idx - i0;
            out[i] += this.buf[i0] * (1 - frac) + this.buf[i1] * frac;
            this.playhead = idx + this.speed;
        }
    }
}
