const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const VIZ_BARS = 40;

const graphs = new Map();
let latest = null;

const dbToGain = (db) => Math.pow(10, db / 20);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;

  switch (msg.type) {
    case 'start':
      start(msg.tabId, msg.streamId, msg.settings).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e?.message || e) })
      );
      return true;
    case 'stop':
      stop(msg.tabId);
      sendResponse({ ok: true });
      return;
    case 'apply':
      latest = msg.settings;
      graphs.forEach((g) => apply(g, latest));
      sendResponse({ ok: true });
      return;
    case 'status':
      sendResponse({ active: graphs.has(msg.tabId) });
      return;
    case 'spectrum':
      sendResponse({ bins: spectrum(graphs.get(msg.tabId)) });
      return;
  }
});

function makeImpulse(ctx, seconds = 2.2, decay = 3.2) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, length, rate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      lp += (Math.random() * 2 - 1 - lp) * (0.9 - 0.7 * t);
      data[i] = lp * Math.pow(1 - t, decay);
    }
  }
  return buffer;
}

function createGraph(ctx, stream) {
  const biquad = (type, frequency, Q = 1) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = Q;
    return f;
  };
  const gain = (value = 1) => {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  };

  const g = { ctx, stream };
  g.src = ctx.createMediaStreamSource(stream);
  g.pre = gain();
  g.pre.channelCount = 2;
  g.pre.channelCountMode = 'explicit';
  g.pre.channelInterpretation = 'speakers';

  g.sub = biquad('highpass', 28, 0.707);
  g.bassShelf = biquad('lowshelf', 90);
  g.bassPeak = biquad('peaking', 72, 1.0);
  g.trebleShelf = biquad('highshelf', 8000);
  g.clarity = biquad('peaking', 3200, 0.9);
  g.eq = BANDS.map((f) => biquad('peaking', f, 1.1));

  const tone = [g.src, g.pre, g.sub, g.bassShelf, g.bassPeak, g.trebleShelf, g.clarity, ...g.eq];
  tone.reduce((a, b) => (a.connect(b), b));
  const lastTone = tone[tone.length - 1];

  // Mid/side stereo width
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const mid = gain(0.5);
  const sideL = gain(0.5);
  const sideR = gain(-0.5);
  g.side = gain(1);
  const sideInv = gain(-1);
  lastTone.connect(split);
  split.connect(mid, 0);
  split.connect(mid, 1);
  split.connect(sideL, 0);
  split.connect(sideR, 1);
  sideL.connect(g.side);
  sideR.connect(g.side);
  g.side.connect(sideInv);
  mid.connect(merge, 0, 0);
  g.side.connect(merge, 0, 0);
  mid.connect(merge, 0, 1);
  sideInv.connect(merge, 0, 1);

  // Reverb and echo send, parallel to the dry path
  const fxIn = gain();
  const fxOut = gain();
  merge.connect(fxIn);
  g.dry = gain();
  fxIn.connect(g.dry).connect(fxOut);

  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);
  g.reverbWet = gain(0);
  fxIn.connect(convolver).connect(g.reverbWet).connect(fxOut);

  g.delay = ctx.createDelay(1);
  g.delay.delayTime.value = 0.3;
  g.feedback = gain(0.3);
  const echoTone = biquad('lowpass', 3500, 0.707);
  g.echoWet = gain(0);
  fxIn.connect(g.delay);
  g.delay.connect(echoTone);
  echoTone.connect(g.feedback).connect(g.delay);
  echoTone.connect(g.echoWet).connect(fxOut);

  // Dynamics and output
  g.comp = ctx.createDynamicsCompressor();
  g.comp.knee.value = 24;
  g.comp.attack.value = 0.01;
  g.comp.release.value = 0.2;
  g.makeup = gain();
  g.vol = gain();
  g.limiter = ctx.createDynamicsCompressor();
  g.limiter.knee.value = 0;
  g.limiter.attack.value = 0.003;
  g.limiter.release.value = 0.1;
  g.analyser = ctx.createAnalyser();
  g.analyser.fftSize = 2048;
  g.analyser.smoothingTimeConstant = 0.75;
  g.analyser.minDecibels = -85;
  g.analyser.maxDecibels = -15;
  g.freqBuf = new Uint8Array(g.analyser.frequencyBinCount);

  fxOut.connect(g.comp).connect(g.makeup).connect(g.vol).connect(g.limiter).connect(g.analyser).connect(ctx.destination);

  const nyquist = ctx.sampleRate / 2;
  const bins = g.analyser.frequencyBinCount;
  g.ranges = Array.from({ length: VIZ_BARS }, (_, i) => {
    const lo = 30 * Math.pow(16000 / 30, i / VIZ_BARS);
    const hi = 30 * Math.pow(16000 / 30, (i + 1) / VIZ_BARS);
    const a = Math.floor((lo / nyquist) * bins);
    const b = Math.max(a + 1, Math.ceil((hi / nyquist) * bins));
    return [a, b];
  });
  return g;
}

function apply(g, s) {
  const t = g.ctx.currentTime;
  const set = (param, value) => param.setTargetAtTime(value, t, 0.03);

  const bass = s.bass / 100;
  const shelfDb = bass * 12;
  const peakDb = bass * 4.5;
  const clarityDb = (s.clarity / 100) * 6;

  set(g.sub.frequency, s.subsonic ? 28 : 5);
  set(g.bassShelf.frequency, s.bassFreq);
  set(g.bassShelf.gain, shelfDb);
  set(g.bassPeak.frequency, s.bassFreq * 0.8);
  set(g.bassPeak.gain, peakDb);
  set(g.trebleShelf.gain, s.treble);
  set(g.clarity.gain, clarityDb);
  g.eq.forEach((f, i) => set(f.gain, s.eq[i] || 0));

  // Headroom: pull the input down as boosts stack up so the bass stays clean
  const boost =
    (shelfDb + peakDb) * 0.5 +
    Math.max(0, s.treble) * 0.4 +
    clarityDb * 0.4 +
    Math.max(0, ...s.eq) * 0.6;
  set(g.pre.gain, dbToGain(-boost * 0.7));

  set(g.side.gain, s.width / 100);

  const reverb = s.reverb / 100;
  const echo = s.echo / 100;
  set(g.reverbWet.gain, reverb * 0.7);
  set(g.dry.gain, 1 - reverb * 0.25);
  set(g.echoWet.gain, echo * 0.55);
  set(g.feedback.gain, 0.25 + echo * 0.2);

  const c = s.compressor / 100;
  const ratio = 1 + c * 7;
  const threshold = -8 - c * 28;
  set(g.comp.threshold, threshold);
  set(g.comp.ratio, ratio);
  set(g.makeup.gain, dbToGain(Math.abs(threshold) * (1 - 1 / ratio) * 0.3 * (c > 0 ? 1 : 0)));

  set(g.vol.gain, s.volume / 100);
  set(g.limiter.threshold, s.limiter ? -1.5 : 0);
  set(g.limiter.ratio, s.limiter ? 20 : 1);
}

async function start(tabId, streamId, settings) {
  if (graphs.has(tabId)) stop(tabId);
  latest = settings;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });

  const ctx = new AudioContext({ latencyHint: 'playback' });
  const graph = createGraph(ctx, stream);
  graph.tabId = tabId;
  apply(graph, settings);
  await ctx.resume();

  graphs.set(tabId, graph);
  stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => stop(tabId)));
}

function stop(tabId) {
  const g = graphs.get(tabId);
  if (!g) return;
  graphs.delete(tabId);
  g.stream.getTracks().forEach((t) => t.stop());
  g.ctx.close().catch(() => {});
  chrome.runtime
    .sendMessage({ target: 'background', type: 'stopped', tabId, remaining: graphs.size })
    .catch(() => {});
}

function spectrum(g) {
  if (!g) return null;
  g.analyser.getByteFrequencyData(g.freqBuf);
  return g.ranges.map(([a, b]) => {
    let peak = 0;
    for (let i = a; i < b; i++) if (g.freqBuf[i] > peak) peak = g.freqBuf[i];
    return peak;
  });
}
