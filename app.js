import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  query, orderBy, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = document.getElementById("app");
const roleChip = document.getElementById("roleChip");
const params = new URLSearchParams(location.search);
const room = params.get("room");
const role = params.get("role") === "send" ? "send" : "judge";
const baseUrl = location.origin + location.pathname;

const VERDICTS = {
  want:  { label: "いる",     icon: "◎" },
  maybe: { label: "迷う",     icon: "△" },
  no:    { label: "いらない", icon: "×" },
};
const OWNED_KEY = "fuku-iru:rooms";

// ---------- 小さな DOM ヘルパー ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

const zoom = document.getElementById("zoom");
document.getElementById("zoomClose").addEventListener("click", () => zoom.close());
zoom.addEventListener("click", (e) => { if (e.target === zoom || e.target.tagName === "IMG") zoom.close(); });
function openZoom(src) {
  document.getElementById("zoomImg").src = src;
  zoom.showModal();
}

function photo(item, cls = "ph") {
  return h("button", { type: "button", class: cls, "aria-label": "写真を拡大", onclick: () => openZoom(item.image) },
    h("img", { src: item.image, alt: item.note || "写真", loading: "lazy" }));
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    toast("リンクをコピーしました");
  } catch {
    input?.select();
    toast("長押しでコピーしてください");
  }
}

function loadOwned() {
  try { return JSON.parse(localStorage.getItem(OWNED_KEY)) || []; } catch { return []; }
}
function saveOwned(list) {
  try { localStorage.setItem(OWNED_KEY, JSON.stringify(list.slice(0, 10))); } catch {}
}

function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

// ---------- 画像を Firestore に入る大きさまで縮める ----------
async function compress(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("画像を読み込めませんでした"));
      i.src = url;
    });
    let max = 1400, q = 0.78, out = "";
    for (let k = 0; k < 7; k++) {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      out = c.toDataURL("image/jpeg", q);
      if (out.length < 900000) return out;
      max = Math.round(max * 0.8);
      q = Math.max(0.5, q - 0.06);
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- 画面: Firebase 未設定 ----------
function renderSetup() {
  app.replaceChildren(
    h("section", { class: "panel setup" },
      h("h2", { text: "はじめに Firebase の設定が必要です" }),
      h("p", {}, "写真と判定結果を保存する場所として、無料の Firebase を使います。"),
      h("ol", {},
        h("li", {}, "Firebase でプロジェクトを作り、Firestore Database を作成"),
        h("li", {}, h("code", { text: "firestore.rules" }), " の中身をルールに貼り付けて公開"),
        h("li", {}, "ウェブアプリを登録して、出てきた設定を ", h("code", { text: "config.js" }), " に貼る"),
      ),
      h("p", { class: "small" }, "くわしい手順はリポジトリの README にあります。"),
    ),
  );
}

// ---------- 画面: トップ ----------
function renderLanding() {
  const owned = loadOwned();
  app.replaceChildren(
    h("section", {},
      h("h1", {}, "写真を送るだけ。", h("br"), "向こうで「いる・いらない」を選べます。"),
    ),
    h("p", { class: "lead" },
      "部屋をつくって写真をアップロードし、出てくるリンクを相手に送ってください。相手はリンクを開いて、1枚ずつボタンで選ぶだけです。結果はこちらの画面にすぐ届きます。"),
    h("button", {
      type: "button", class: "btn primary wide",
      onclick: () => {
        const id = newRoomId();
        saveOwned([{ id, at: Date.now() }, ...owned]);
        location.href = `${baseUrl}?room=${id}&role=send`;
      },
    }, "新しい部屋をつくる"),
    owned.length ? h("section", { class: "panel" },
      h("h2", { text: "前につくった部屋" }),
      ...owned.map((r) => h("a", { class: "btn", href: `${baseUrl}?room=${r.id}&role=send` },
        new Date(r.at).toLocaleDateString("ja-JP", { month: "long", day: "numeric" }) + " につくった部屋")),
    ) : null,
  );
}

// ---------- データ購読 ----------
let db, itemsCol;
const state = { items: [], loaded: false };
const listeners = [];

function subscribe() {
  db = getFirestore(initializeApp(firebaseConfig));
  itemsCol = collection(db, "rooms", room, "items");
  onSnapshot(query(itemsCol, orderBy("createdAt")), (snap) => {
    state.items = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    state.loaded = true;
    listeners.forEach((fn) => fn());
  }, (err) => {
    console.error(err);
    app.replaceChildren(h("p", { class: "empty" },
      "データを読み込めませんでした。リンクが正しいか確認してください。（" + err.code + "）"));
  });
}

// ---------- 画面: 送る側 ----------
function renderSender() {
  roleChip.textContent = "送る人";
  roleChip.hidden = false;
  const judgeUrl = `${baseUrl}?room=${room}`;
  let filter = "all";
  let editingId = null;
  let deletingId = null;

  const linkInput = h("input", { id: "shareLink", type: "text", readonly: true, value: judgeUrl, onfocus: (e) => e.target.select() });
  const progressBar = h("div");
  const progress = h("div", { class: "progress", hidden: true }, progressBar);
  const progressText = h("p", { class: "small", hidden: true });
  const fileInput = h("input", { id: "fileInput", type: "file", accept: "image/*", multiple: true });
  const upload = h("label", { class: "upload", for: "fileInput" },
    "＋ 写真を選ぶ",
    h("span", { class: "small", text: "何枚でもまとめて選べます" }),
    fileInput);
  const tally = h("div", { class: "tally" });
  const grid = h("div", { class: "grid" });
  const emptyMsg = h("p", { class: "empty" });

  fileInput.addEventListener("change", async () => {
    const files = [...fileInput.files];
    fileInput.value = "";
    if (!files.length) return;
    upload.classList.add("busy");
    progress.hidden = progressText.hidden = false;
    let done = 0, failed = 0;
    for (const f of files) {
      progressText.textContent = `アップロード中… ${done + 1} / ${files.length}`;
      try {
        const image = await compress(f);
        await addDoc(itemsCol, { image, note: "", createdAt: serverTimestamp(), verdict: null, comment: "", judgedAt: null });
      } catch (e) {
        console.error(e);
        failed++;
      }
      done++;
      progressBar.style.width = `${(done / files.length) * 100}%`;
    }
    upload.classList.remove("busy");
    progress.hidden = progressText.hidden = true;
    progressBar.style.width = "0";
    toast(failed ? `${files.length - failed}枚送りました（${failed}枚は失敗）` : `${files.length}枚送りました`);
  });

  app.replaceChildren(
    h("section", { class: "panel" },
      h("h2", { text: "相手に送るリンク" }),
      h("p", { class: "small" }, "このリンクを LINE などで送ってください。写真はあとから追加しても、相手の画面に自動で出てきます。"),
      h("div", { class: "share-row" },
        linkInput,
        h("button", { type: "button", class: "btn primary small-btn", onclick: () => copyText(judgeUrl, linkInput) }, "コピー")),
      h("a", {
        class: "btn small-btn", target: "_blank", rel: "noopener",
        href: "https://line.me/R/share?text=" + encodeURIComponent("これいる？いらない？ほしいのを選んでね\n" + judgeUrl),
      }, "LINEで送る"),
    ),
    upload,
    progress,
    progressText,
    h("section", { class: "panel" },
      h("h2", { text: "相手の返事" }),
      tally,
    ),
    grid,
    emptyMsg,
    h("p", { class: "small" }, "この画面のアドレス（送る人用）はブックマークしておくと、あとで結果を見に戻れます。"),
  );

  function draw() {
    const items = state.items;
    const count = (v) => items.filter((i) => (i.verdict ?? null) === v).length;
    const tallies = [
      ["all", "全部", items.length, ""],
      ["want", "いる", count("want"), "t-want"],
      ["maybe", "迷う", count("maybe"), "t-maybe"],
      ["no", "いらない", count("no"), "t-no"],
      [null, "まだ", count(null), ""],
    ];
    tally.replaceChildren(...tallies.map(([key, label, n, cls]) =>
      h("button", {
        type: "button", class: `${cls} ${filter === key ? "on" : ""}`,
        onclick: () => { filter = key; draw(); },
      }, h("b", { text: n }), label)));

    const shown = filter === "all" ? items : items.filter((i) => (i.verdict ?? null) === filter);
    grid.replaceChildren(...shown.map(senderTile));
    emptyMsg.hidden = shown.length > 0;
    emptyMsg.textContent = !state.loaded ? "読み込み中…"
      : items.length === 0 ? "まだ写真がありません。上のボタンから写真を選んでください。"
      : "この分類の写真はありません。";
  }

  function senderTile(item) {
    const v = VERDICTS[item.verdict];
    const body = h("div", { class: "body" });
    if (editingId === item.id) {
      const input = h("input", {
        class: "note-input", type: "text", value: item.note || "", maxlength: "80",
        placeholder: "例: 食器セット 6枚 未使用",
      });
      const save = async () => {
        editingId = null;
        await updateDoc(doc(itemsCol, item.id), { note: input.value.trim() });
        draw();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
      body.append(input, h("div", { class: "actions" },
        h("button", { type: "button", onclick: save }, "保存"),
        h("button", { type: "button", onclick: () => { editingId = null; draw(); } }, "やめる")));
      queueMicrotask(() => input.focus());
    } else {
      if (item.note) body.append(h("p", { class: "note", text: item.note }));
      if (item.comment) body.append(h("p", { class: "comment", text: "💬 " + item.comment }));
      body.append(h("div", { class: "actions" },
        h("button", { type: "button", onclick: () => { editingId = item.id; deletingId = null; draw(); } },
          item.note ? "メモを直す" : "メモを書く"),
        deletingId === item.id
          ? h("button", { type: "button", class: "del", onclick: () => deleteDoc(doc(itemsCol, item.id)) }, "本当に消す")
          : h("button", { type: "button", class: "del", onclick: () => { deletingId = item.id; draw(); } }, "消す"),
      ));
    }
    const ph = photo(item);
    ph.append(h("span", { class: `badge ${item.verdict || ""}`, text: v ? `${v.icon} ${v.label}` : "まだ" }));
    return h("article", { class: "tile" }, ph, body);
  }

  listeners.push(() => { if (!editingId) draw(); });
  draw();
}

// ---------- 画面: 判定する側 ----------
function renderJudge() {
  roleChip.textContent = "選ぶ人";
  roleChip.hidden = false;
  let tab = "judge";
  let focusId = null;       // 一覧から選び直すときの対象
  let shownId = undefined;  // いまカードに出している写真（入力中に書き換えないため）
  const drafts = {};

  const tabs = h("div", { class: "tabs" });
  const counter = h("div", { class: "counter" });
  const stage = h("div");

  app.replaceChildren(
    h("p", { class: "lead" }, "1枚ずつ、ほしいかどうかを選んでください。ひとことコメントも送れます。"),
    tabs, counter, stage);

  function drawTabs() {
    tabs.replaceChildren(
      h("button", { type: "button", class: tab === "judge" ? "on" : "", onclick: () => { tab = "judge"; shownId = undefined; draw(); } }, "1枚ずつ選ぶ"),
      h("button", { type: "button", class: tab === "list" ? "on" : "", onclick: () => { tab = "list"; draw(); } }, "選んだものを見る"),
    );
  }

  function currentItem() {
    if (focusId) {
      const f = state.items.find((i) => i.id === focusId);
      if (f) return f;
      focusId = null;
    }
    return state.items.find((i) => !i.verdict) || null;
  }

  function drawCounter() {
    const total = state.items.length;
    const left = state.items.filter((i) => !i.verdict).length;
    counter.replaceChildren(
      h("span", {}, "のこり ", h("b", { text: left }), " 枚"),
      h("span", { class: "small", text: `全部で ${total} 枚` }),
    );
  }

  async function judge(item, verdict) {
    const comment = (drafts[item.id] ?? item.comment ?? "").trim();
    try {
      await updateDoc(doc(itemsCol, item.id), { verdict, comment, judgedAt: serverTimestamp() });
      delete drafts[item.id];
      if (focusId === item.id) {
        focusId = null;
        if (tab === "judge") toast("変更しました");
      }
      shownId = undefined;
      draw();
    } catch (e) {
      console.error(e);
      toast("送れませんでした。電波を確認してもう一度押してください");
    }
  }

  function judgeCard(item) {
    const box = h("textarea", {
      id: "comment", class: "comment-box", rows: "2", maxlength: "200",
      placeholder: "ひとこと（任意）",
      oninput: (e) => { drafts[item.id] = e.target.value; },
    });
    box.value = drafts[item.id] ?? item.comment ?? "";
    return h("article", { class: "card" },
      photo(item),
      h("div", { class: "body" },
        item.note ? h("p", { class: "note", text: item.note }) : null,
        box,
        h("div", { class: "verdicts" },
          ...["want", "maybe", "no"].map((k) => h("button", {
            type: "button", class: `v-${k} ${item.verdict === k ? "on" : ""}`,
            onclick: () => judge(item, k),
          }, h("span", { text: VERDICTS[k].icon }), VERDICTS[k].label))),
        focusId ? h("button", { type: "button", class: "btn small-btn", onclick: () => { focusId = null; shownId = undefined; draw(); } }, "選び直しをやめる") : null,
      ));
  }

  function doneView() {
    const maybe = state.items.filter((i) => i.verdict === "maybe");
    return h("section", { class: "done panel" },
      h("p", { class: "big", text: state.items.length ? "✓" : "…" }),
      h("h2", { text: state.items.length ? "全部選び終わりました" : "まだ写真が届いていません" }),
      h("p", { class: "small" }, state.items.length
        ? "新しい写真が届くと、ここに自動で出てきます。"
        : "写真が送られてくると、ここに自動で出てきます。このページは開いたままで大丈夫です。"),
      maybe.length ? h("button", {
        type: "button", class: "btn",
        onclick: () => { focusId = maybe[0].id; shownId = undefined; draw(); },
      }, `「迷う」の ${maybe.length} 枚を見直す`) : null,
      state.items.length ? h("button", { type: "button", class: "btn", onclick: () => { tab = "list"; draw(); } }, "選んだものを見る") : null,
    );
  }

  function listView() {
    if (!state.items.length) return h("p", { class: "empty", text: "まだ写真がありません。" });
    const order = { want: 0, maybe: 1, no: 2 };
    const sorted = [...state.items].sort((a, b) => (order[a.verdict] ?? 3) - (order[b.verdict] ?? 3));
    return h("div", { class: "grid" }, ...sorted.map((item) => {
      const v = VERDICTS[item.verdict];
      const ph = photo(item);
      ph.append(h("span", { class: `badge ${item.verdict || ""}`, text: v ? `${v.icon} ${v.label}` : "まだ" }));
      return h("article", { class: "tile" }, ph,
        h("div", { class: "body" },
          item.note ? h("p", { class: "note", text: item.note }) : null,
          item.comment ? h("p", { class: "comment", text: item.comment }) : null,
          h("div", { class: "actions" },
            h("button", {
              type: "button",
              onclick: () => { focusId = item.id; tab = "judge"; shownId = undefined; draw(); scrollTo({ top: 0 }); },
            }, "選び直す"))));
    }));
  }

  function draw() {
    drawTabs();
    drawCounter();
    if (!state.loaded) { stage.replaceChildren(h("p", { class: "loading", text: "読み込み中…" })); return; }
    if (tab === "list") { shownId = undefined; stage.replaceChildren(listView()); return; }
    const item = currentItem();
    const id = item ? item.id : null;
    if (id === shownId) return; // 同じ写真なら入力中のコメントを守るため描き直さない
    shownId = id;
    stage.replaceChildren(item ? judgeCard(item) : doneView());
  }

  listeners.push(draw);
  draw();
}

// ---------- 起動 ----------
if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("YOUR_")) {
  renderSetup();
} else if (!room || room.length < 16) {
  renderLanding();
} else {
  subscribe();
  role === "send" ? renderSender() : renderJudge();
}
