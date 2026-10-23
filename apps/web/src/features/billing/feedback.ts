// A short beep when a scan or add fails, so the cashier notices without
// looking up from the scanner. Silently does nothing where audio is blocked.

let audio: AudioContext | null = null;

export function errorBeep() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = 220;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.18);
  } catch {
    // No audio: the on-screen error is enough.
  }
}
