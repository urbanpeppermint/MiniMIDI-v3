/**
 * Linear resample 16-bit little-endian stereo PCM (48 kHz assumed at output).
 * speed > 1 → shorter buffer → faster playback at fixed sample rate → higher pitch.
 * speed < 1 → slower → lower pitch.
 */

export function resampleStereoS16Linear(source: Uint8Array, speed: number): Uint8Array {
    const bytesPerFrame = 4;
    if (source.length < bytesPerFrame || source.length % bytesPerFrame !== 0) {
        return source;
    }
    const s = Math.max(0.5, Math.min(2.0, speed));
    const numInFrames = (source.length / bytesPerFrame) | 0;
    const numOutFrames = Math.max(1, Math.floor(numInFrames / s));
    const out = new Uint8Array(numOutFrames * bytesPerFrame);

    const readS16 = (byteIdx: number): number => {
        let v = source[byteIdx] | (source[byteIdx + 1] << 8);
        if (v > 32767) {
            v -= 65536;
        }
        return v;
    };
    const writeS16 = (byteIdx: number, v: number) => {
        let x = Math.round(v);
        x = Math.max(-32768, Math.min(32767, x));
        if (x < 0) {
            x += 65536;
        }
        out[byteIdx] = x & 0xff;
        out[byteIdx + 1] = (x >> 8) & 0xff;
    };

    for (let k = 0; k < numOutFrames; k++) {
        const pos = k * s;
        const f0 = pos | 0;
        const frac = pos - f0;
        const i0 = Math.min(f0, numInFrames - 1) * bytesPerFrame;
        const i1 = Math.min(f0 + 1, numInFrames - 1) * bytesPerFrame;
        const ob = k * bytesPerFrame;
        for (let ch = 0; ch < 2; ch++) {
            const o0 = i0 + ch * 2;
            const o1 = i1 + ch * 2;
            const v0 = readS16(o0);
            const v1 = readS16(o1);
            writeS16(ob + ch * 2, v0 + (v1 - v0) * frac);
        }
    }
    return out;
}
