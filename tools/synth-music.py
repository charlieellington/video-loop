# synth-music.py — the away-loop music bed, ANY length, synthesized from scratch (no samples,
# no dependencies, no rights questions). Felt-piano chords + plucked-string melody (Karplus-
# Strong) + sub bass + soft kick + vinyl crackle/tape hiss. Deterministic (fixed seed): the same
# arguments render the same bytes every time — the bed is a fixed asset, not a weekly variable.
#   python3 synth-music.py [out.wav] [seconds]      (defaults: assets/music-bed.wav, 18s)
# Long renders are built in 18s PHRASES (4 bars of C–Am7–Fmaj7–G6) whose texture cycles
# full → sparse → medium so a 3–4 min bed breathes under a voice instead of looping.
import math, random, wave, array, os, sys

SR = 44100
BAR, PHRASE = 4.5, 18.0
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "music-bed.wav")
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 18.0
N = int(SR * DUR)
random.seed(7)
L = [0.0] * N
R = [0.0] * N

def add(buf, start_s, samples, amp=1.0):
    i0 = max(0, int(start_s * SR)); i1 = min(N, i0 + len(samples))
    if i1 <= i0: return
    seg = samples[: i1 - i0]
    buf[i0:i1] = [a + b * amp for a, b in zip(buf[i0:i1], seg)]

_cache = {}
def cached(key, fn):
    if key not in _cache: _cache[key] = fn()
    return _cache[key]

def piano_note(freq, dur, detune=0.0):
    """Soft dark 'felt piano': few partials, 25ms attack, exponential decay. Phase seeded by pitch."""
    def render():
        rng = random.Random(int(freq * 1000) + int(detune * 1e6))
        n = int(dur * SR); out = [0.0] * n
        f = freq * (1.0 + detune)
        atk = int(0.025 * SR)
        for k, (mult, pa) in enumerate([(1, 1.00), (2, 0.30), (3, 0.10), (4, 0.035)]):
            ph = rng.random() * 6.283185; w = 6.283185 * f * mult / SR
            ptau = 2.1 / (1 + 0.8 * k)
            for i in range(n):
                env = (i / atk if i < atk else 1.0) * math.exp(-(i / SR) / ptau)
                out[i] += pa * env * math.sin(w * i + ph)
        return out
    return cached(("p", freq, dur, detune), render)

def ks_note(freq, dur):
    """Karplus-Strong plucked string, pre-smoothed buffer = darker pluck, no 20kHz attack spike."""
    def render():
        rng = random.Random(int(freq * 100))
        n = int(dur * SR); nbuf = max(2, int(SR / freq))
        buf = [rng.uniform(-1, 1) for _ in range(nbuf)]
        for _ in range(3):
            buf = [0.5 * (buf[i] + buf[(i + 1) % nbuf]) for i in range(nbuf)]
        out = [0.0] * n; idx = 0; fade = int(0.35 * SR)
        for i in range(n):
            v = buf[idx]; buf[idx] = 0.9962 * 0.5 * (v + buf[(idx + 1) % nbuf])
            out[i] = v * (1.0 if i < n - fade else (n - i) / fade); idx = (idx + 1) % nbuf
        return out
    return cached(("k", freq, dur), render)

def sub_note(freq, dur):
    def render():
        n = int(dur * SR); atk = int(0.6 * SR); rel = int(0.8 * SR); w = 6.283185 * freq / SR
        return [min(1.0, i / atk) * min(1.0, (n - i) / rel) * math.sin(w * i) for i in range(n)]
    return cached(("s", freq, dur), render)

def kick(dur=0.30):
    def render():
        n = int(dur * SR); out = [0.0] * n; ph = 0.0
        for i in range(n):
            t = i / SR; ph += 6.283185 * (70 * math.exp(-t * 10) + 44) / SR
            out[i] = math.exp(-t * 11) * math.sin(ph)
        return out
    return cached(("kick", dur), render)

# --- the material: 4 bars, C – Am7 – Fmaj7 – G6 (warm, hopeful, resolves open) ---
C3, E3, G3, B3 = 130.81, 164.81, 196.00, 246.94
A2, F2, G2, B2, D3 = 110.00, 87.31, 98.00, 123.47, 146.83
BARS = [([C3, E3, G3, B3], 65.41), ([A2, C3, E3, G3], 55.00),
        ([F2, A2, C3, E3], 43.65), ([G2, B2, D3, E3], 49.00)]
E4, D4, G4, C4, A4 = 329.63, 293.66, 392.00, 261.63, 440.00
MELODIES = [  # two phrases, alternated — (offset in phrase, pitch)
    [(2.3, E4), (4.1, D4), (6.9, G4), (9.4, E4), (11.6, D4), (13.8, C4), (15.7, E4)],
    [(1.9, G4), (4.4, E4), (6.6, D4), (9.1, C4), (11.3, E4), (13.5, D4), (16.0, C4)],
]
# texture per phrase: 3 = full (piano+sub+melody+kick), 2 = +melody, 1 = piano+sub only
def level_for(p, total):
    if p == 0: return 3                        # the open is always full
    if p == total - 1: return 1                # the last phrase thins out to the fade
    return [1, 1, 2, 3, 2, 1][(p - 1) % 6]

n_phrases = int(math.ceil(DUR / PHRASE))
for p in range(n_phrases):
    base = p * PHRASE; lvl = level_for(p, n_phrases)
    for b, (notes, sub) in enumerate(BARS):
        start = base + 0.15 + b * BAR
        if start >= DUR: break
        for k, f in enumerate(notes):
            amp = (0.185 if k == 0 else 0.155) * (1.0 if lvl > 1 else 0.85)
            add(L, start + k * 0.065, piano_note(f, 4.2, -0.0012), amp)
            add(R, start + k * 0.078, piano_note(f, 4.2, +0.0012), amp)
        s = sub_note(sub, 4.3); add(L, start, s, 0.075); add(R, start, s, 0.075)
    if lvl >= 2:
        for off, f in MELODIES[p % 2]:
            m = ks_note(f, 2.0); add(L, base + off, m, 0.085); add(R, base + off + 0.012, m, 0.105)
    if lvl == 3:
        for off in (9.15, 11.4, 13.65, 15.9):
            kk = kick(); add(L, base + off, kk, 0.10); add(R, base + off, kk, 0.10)

# vinyl crackle (sparse impulses) + tape hiss (one 18s low-passed noise loop, tiled)
hiss_n = int(PHRASE * SR); lp = 0.0; hiss = [0.0] * hiss_n
for i in range(hiss_n):
    lp = 0.94 * lp + 0.06 * random.uniform(-1, 1); hiss[i] = lp * 0.010
for buf in (L, R):
    for i0 in range(0, N, hiss_n):
        add(buf, i0 / SR, hiss, 1.0)
    for _ in range(int(DUR * 9)):
        j = random.randrange(N - 6); a = random.uniform(0.008, 0.030)
        buf[j] += a; buf[j + 1] += a * 0.5; buf[j + 2] += a * 0.15

# master: fade in 0.4s, fade out over the last 3s (18s renders: last 1.6s), peak-normalize
FI = int(0.4 * SR); FO = int((3.0 if DUR > 30 else 1.6) * SR); FO_START = N - FO
peak = 0.0
for buf in (L, R):
    for i in range(FI): buf[i] *= i / FI
    for i in range(FO_START, N): buf[i] *= (N - i) / FO
    peak = max(peak, max(abs(x) for x in buf))
g = 0.9 / peak
frames = array.array('h')
for i in range(N):
    frames.append(int(max(-1.0, min(1.0, L[i] * g)) * 32767))
    frames.append(int(max(-1.0, min(1.0, R[i] * g)) * 32767))
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(frames.tobytes())
print(f"{out} written: {DUR}s stereo, {n_phrases} phrases, peak-normalized to 0.9 (gain {g:.3f})")
