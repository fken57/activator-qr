"use strict";

const byId = (id) => document.getElementById(id);
const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
const encoder = new TextEncoder();
const limit = 10000;

function parsePacket(data) {
  if (!data.startsWith("ACT1:") || data.length > 1024) return null;
  try {
    const packet = JSON.parse(data.slice(5));
    if (!Array.isArray(packet) || packet.length !== 4) return null;
    const [id, index, total, char] = packet;
    if (typeof id !== "string" || !/^[a-f0-9]{16}$/.test(id) ||
        !Number.isInteger(total) || total < 1 || total > limit ||
        !Number.isInteger(index) || index < 0 || index >= total ||
        typeof char !== "string" || segmenter.segment(char).containing(0)?.segment !== char) return null;
    return packet;
  } catch {
    return null;
  }
}

function initSender() {
  const canvas = byId("qr");
  const ctx = canvas.getContext("2d");
  const message = byId("message");
  const play = byId("play");
  const speed = byId("speed");
  const note = byId("send-note");
  const receiveURL = new URL("?receive", location.href);
  let chars = [];
  let session;
  let cache = [];
  let index = 0;
  let timer;
  let showingPair = true;
  let edited = false;

  function makeQR(text) {
    const qr = qrcode(0, "M");
    qr.addData(text, "Byte");
    qr.make();
    return qr;
  }

  function draw(qr, label) {
    const size = qr.getModuleCount();
    const scale = 10;
    canvas.width = canvas.height = (size + 8) * scale;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (qr.isDark(y, x)) ctx.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
      }
    }
    canvas.setAttribute("aria-label", label);
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
    play.textContent = showingPair ? "送信開始" : "送信再開";
  }

  function showPair() {
    showingPair = true;
    stop();
    draw(makeQR(receiveURL.href), "スマホ受信機を開くQRコード");
    byId("mode").textContent = "接続用 QR";
    byId("frame").textContent = "STANDBY";
    byId("sent").value = 0;
    note.textContent = "スマホで接続用QRを読み取ってください。";
  }

  function prepare() {
    chars = Array.from(segmenter.segment(message.value), ({ segment }) => segment);
    session = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    cache = [];
    index = 0;
    showPair();
    byId("count").textContent = chars.length.toLocaleString("ja-JP") + " 文字";
    play.disabled = chars.length === 0 || chars.length > limit || chars.some((char) => encoder.encode(char).length > 150);
    if (play.disabled) note.textContent = "送信できるのは1〜10,000文字です。極端に長い合成文字は分けて入力してください。";
  }

  function sendFrame() {
    cache[index] ??= makeQR("ACT1:" + JSON.stringify([session, index, chars.length, chars[index]]));
    draw(cache[index], "送信用QRコード");
    byId("frame").textContent = (index + 1) + " / " + chars.length;
    byId("sent").value = index + 1;
    index = (index + 1) % chars.length;
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(sendFrame, 1000 / Number(speed.value));
  }

  play.addEventListener("click", () => {
    if (timer !== undefined) {
      stop();
      note.textContent = "送信を一時停止しました。";
      return;
    }
    showingPair = false;
    byId("mode").textContent = "送信用 QR";
    byId("sent").max = chars.length;
    play.textContent = "一時停止";
    note.textContent = "スマホのカメラをこのQRに向けてください。";
    sendFrame();
    schedule();
  });
  speed.addEventListener("change", () => {
    if (timer !== undefined) schedule();
  });
  byId("pair").addEventListener("click", showPair);
  message.addEventListener("input", () => {
    edited = true;
    prepare();
  });
  byId("pair").disabled = false;
  showPair();
  fetch("./story.txt")
    .then((response) => {
      if (!response.ok) throw new Error("Story request failed");
      return response.text();
    })
    .then((story) => {
      if (edited) return;
      message.value = story.trimEnd();
      prepare();
    })
    .catch(() => {
      note.textContent = "物語を読み込めませんでした。「送信する文章を編集」から入力できます。";
    });
}

function initReceiver() {
  const video = byId("camera");
  const scan = byId("scan");
  const note = byId("receive-note");
  const result = byId("result");
  const copy = byId("copy");
  const scratch = document.createElement("canvas");
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  let stream;
  let frame;
  let session;
  let slots = [];
  let received = 0;
  let lastScan = 0;
  let lastVideoTime = -1;
  let generation = 0;

  function stop() {
    generation++;
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.srcObject = null;
    scan.textContent = "カメラを開始";
    scan.disabled = false;
  }

  function update() {
    byId("received").textContent = received + " / " + (slots.length || "—");
    byId("reception").max = slots.length || 1;
    byId("reception").value = received;
    const complete = slots.length > 0 && received === slots.length;
    copy.disabled = !complete;
    result.textContent = received ? Array.from(slots, (char) => char ?? "□").join("") :
      "受信した文字がここに表示されます。";
    if (complete) {
      stop();
      note.textContent = "全文を復元しました。";
    }
  }

  function accept(data) {
    const packet = parsePacket(data);
    if (!packet) return;
    const [id, index, total, char] = packet;
    if (session === undefined) {
      session = id;
      slots = Array(total);
      note.textContent = "受信中。□はまだ読み取っていない文字です。";
    }
    if (id !== session || total !== slots.length || slots[index] !== undefined) return;
    slots[index] = char;
    received++;
    update();
  }

  function read(now) {
    if (video.readyState >= 2 && now - lastScan >= 32 && lastVideoTime !== video.currentTime) {
      lastScan = now;
      lastVideoTime = video.currentTime;
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      if (scratch.width !== width || scratch.height !== height) {
        scratch.width = width;
        scratch.height = height;
      }
      ctx.drawImage(video, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height);
      const found = jsQR(pixels.data, width, height, { inversionAttempts: "dontInvert" });
      if (found) accept(found.data);
    }
    if (stream) frame = requestAnimationFrame(read);
  }

  scan.addEventListener("click", async () => {
    if (stream) {
      stop();
      note.textContent = "カメラを停止しました。";
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      note.textContent = "HTTPSでこのページを開くとカメラを使えます。";
      return;
    }
    if (slots.length && received === slots.length) {
      note.textContent = "次の文章を受信するには「受信をリセット」を押してください。";
      return;
    }
    scan.disabled = true;
    const attempt = ++generation;
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 640 } }
      });
      if (attempt !== generation) {
        camera.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = camera;
      video.srcObject = stream;
      await video.play();
      if (attempt !== generation) return;
      scan.disabled = false;
      scan.textContent = "カメラを停止";
      note.textContent = "送信中のQRを枠に合わせてください。";
      lastVideoTime = -1;
      frame = requestAnimationFrame(read);
    } catch {
      if (attempt !== generation) return;
      stop();
      note.textContent = "カメラを開けませんでした。ブラウザのカメラ許可を確認してください。";
    }
  });

  byId("clear").addEventListener("click", () => {
    session = undefined;
    slots = [];
    received = 0;
    update();
    note.textContent = "背面カメラを、送信中のQRに向けてください。";
  });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(slots.join(""));
      note.textContent = "文章をコピーしました。";
    } catch {
      note.textContent = "文章を選択してコピーしてください。";
    }
  });
  window.addEventListener("pagehide", stop);
}

if (new URLSearchParams(location.search).has("receive")) {
  document.body.classList.add("receive");
  byId("sender").hidden = true;
  byId("receiver").hidden = false;
  byId("switch").href = "./";
  byId("switch").textContent = "送信機";
  initReceiver();
} else {
  qrcode.stringToBytes = (text) => encoder.encode(text);
  initSender();
}
