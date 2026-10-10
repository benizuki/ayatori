<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/* ログイン画面。Hinamiのログイン画面と同じ和紙の地に、ヒアリングの対話が
   一行ずつ書かれ、作業断片へ変わっていく様子を添える。
   Googleのボタンは呼び出し側がスロットへ置く（ref を App.vue 側で持つため）。

   色は .auth-gate の局所変数で持つ。アプリ本体（tokens.css）の配色はこの画面に揃えてあるが、
   ログイン画面だけは単独で成り立つように、トークンには依存させない。 */

const props = defineProps<{
  buttonReady: boolean
  // メールアドレスだけで入れるお試しログイン（Docker Composeの体験用）
  demoLogin?: boolean
  error: string
  loading: boolean
}>()

const emit = defineEmits<{ 'demo-login': [email: string] }>()

const demoEmail = ref('')
const heroFailed = ref(false)
const sealUrl = `${import.meta.env.BASE_URL}auth/ayatori-seal.svg`
const heroUrl = `${import.meta.env.BASE_URL}auth/ayatori-hero.png`

function submitDemo() {
  const email = demoEmail.value.trim()
  if (email && !props.loading) emit('demo-login', email)
}

type Line = { who: 'ai' | 'user'; text: string }
type Scenario = { lines: Line[]; fragments: { label: string; review?: boolean }[] }

const SCENARIOS: Scenario[] = [
  {
    lines: [
      { who: 'ai', text: '請求書を受け取ってから支払うまで、最初に誰が何をしますか？' },
      { who: 'user', text: '経理の担当がメールで受け取って、Excelに転記しています。' },
      { who: 'ai', text: '転記のあと、承認はどなたが行いますか？' },
      { who: 'user', text: '50万円を超えると部長承認です。それ以外は課長まで。' },
    ],
    fragments: [
      { label: '受領：メール' },
      { label: '転記：Excel（手作業）' },
      { label: '分岐：50万円超 → 部長承認' },
      { label: '所要時間', review: true },
    ],
  },
  {
    lines: [
      { who: 'ai', text: '購買依頼はどこから始まりますか？' },
      { who: 'user', text: '現場が紙の申請書を書いて、購買課に回します。' },
      { who: 'ai', text: '見積もりは何社から取っていますか？' },
      { who: 'user', text: '基本は3社です。急ぎのときは1社で済ませることも。' },
    ],
    fragments: [
      { label: '起票：紙の申請書' },
      { label: '相見積：3社' },
      { label: '例外：緊急時は1社' },
      { label: '例外の判断者', review: true },
    ],
  },
]

const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const sceneIndex = ref(0)
const shownLines = ref(0)
const shownFragments = ref(0)
const leaving = ref(false)
let timer = 0

const scene = computed(() => SCENARIOS[sceneIndex.value])

/** 対話が一行ずつ静かに現れる → 断片が一つずつ付く → しばらく読ませる → 頁をめくる。 */
function step() {
  if (shownLines.value < scene.value.lines.length) {
    timer = window.setTimeout(() => {
      shownLines.value += 1
      step()
    }, shownLines.value === 0 ? 1000 : 1700)
    return
  }
  if (shownFragments.value < scene.value.fragments.length) {
    timer = window.setTimeout(() => {
      shownFragments.value += 1
      step()
    }, 650)
    return
  }
  timer = window.setTimeout(() => {
    leaving.value = true
    timer = window.setTimeout(() => {
      sceneIndex.value = (sceneIndex.value + 1) % SCENARIOS.length
      shownLines.value = 0
      shownFragments.value = 0
      leaving.value = false
      step()
    }, 900)
  }, 5200)
}

onMounted(() => {
  if (reducedMotion) {
    shownLines.value = scene.value.lines.length
    shownFragments.value = scene.value.fragments.length
    return
  }
  step()
})

onBeforeUnmount(() => window.clearTimeout(timer))

/* 舞う光の粒。位置・大きさ・周期を散らして、揃って動かないようにする。 */
const MOTES = Array.from({ length: 16 }, () => ({
  left: `${(Math.random() * 100).toFixed(1)}%`,
  size: `${(3 + Math.random() * 6).toFixed(1)}px`,
  duration: `${(18 + Math.random() * 20).toFixed(1)}s`,
  delay: `${(-Math.random() * 30).toFixed(1)}s`,
  sway: `${(Math.random() * 60 - 30).toFixed(0)}px`,
}))
</script>

<template>
  <div class="auth-gate">
    <img v-if="!heroFailed" class="auth-gate__art" :src="heroUrl" alt="" aria-hidden="true" @error="heroFailed = true">
    <div class="auth-gate__veil" aria-hidden="true"></div>
    <div class="auth-gate__motes" aria-hidden="true">
      <i v-for="(mote, index) in MOTES" :key="index" :style="{ '--left': mote.left, '--size': mote.size, '--duration': mote.duration, '--delay': mote.delay, '--sway': mote.sway }"></i>
    </div>

    <div class="auth-gate__layout">
      <header class="auth-hero">
        <div class="auth-brand">
          <img class="auth-brand__seal" :src="sealUrl" alt="" aria-hidden="true">
          <div>
            <div class="auth-brand__name">Ayatori</div>
            <div class="auth-brand__ruby">あやとり ・ 業務の見える化</div>
          </div>
        </div>
        <h1 class="auth-hero__title">対話から、<br>業務をひもとく。</h1>
        <p class="auth-hero__lead">
          担当者との対話をAIが受け持ち、作業・判断・使っているシステムを拾い上げます。絡まった業務の糸をほどき、ともに見つめ直します。
        </p>
      </header>

      <!-- 飾りのデモ。読み上げると本文と混ざるので支援技術からは隠す。 -->
      <section class="auth-page" :class="{ 'is-leaving': leaving }" aria-hidden="true">
        <p class="auth-page__ask"><b>ヒアリング</b>担当者との対話から</p>
        <div class="auth-page__paper">
          <p
            v-for="(line, index) in scene.lines"
            :key="`${sceneIndex}-${index}`"
            class="auth-page__line"
            :class="[`auth-page__line--${line.who}`, { 'is-shown': index < shownLines }]"
          ><b>{{ line.who === 'ai' ? 'AI' : '担当' }}</b>{{ line.text }}</p>
          <div class="auth-page__fragments">
            <span
              v-for="(fragment, index) in scene.fragments"
              :key="`${sceneIndex}-f-${index}`"
              :class="{ 'is-shown': index < shownFragments, 'is-review': fragment.review }"
            >{{ fragment.review ? `要確認：${fragment.label}` : fragment.label }}</span>
          </div>
        </div>
      </section>

      <section class="auth-card" aria-labelledby="auth-card-title">
        <p class="auth-card__eyebrow">業務の糸をたどる</p>
        <h2 id="auth-card-title">おかえりなさい</h2>
        <p class="auth-card__intro">業務の見える化を、はじめましょう。</p>
        <form v-if="demoLogin" class="auth-card__demo" @submit.prevent="submitDemo">
          <label for="auth-demo-email">メールアドレス</label>
          <input
            id="auth-demo-email"
            v-model="demoEmail"
            type="email"
            name="email"
            autocomplete="email"
            placeholder="you@example.com"
            required
            :disabled="loading"
            autofocus
          >
          <button type="submit" :disabled="loading || !demoEmail.trim()">{{ loading ? '認証中…' : 'はじめる' }}</button>
          <p class="auth-card__note">お試し版です。パスワードは要りません。はじめてのメールアドレスは、そのまま新しい利用者として登録されます。</p>
        </form>
        <template v-else>
          <div class="auth-card__button">
            <slot />
            <button v-if="!buttonReady" class="auth-card__pending" disabled>Googleログインを準備中</button>
          </div>
          <p class="auth-card__note">組織のGoogleアカウントでログインします。利用できるのは、ユーザーマスターに登録されたアカウントだけです。</p>
        </template>
        <p v-if="error" class="auth-card__error" role="alert">{{ error }}</p>
        <p v-if="loading" class="auth-card__status" role="status"><span class="auth-card__spinner"></span>認証中...</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.auth-gate {
  --paper: #f8f1e4;
  --paper-deep: #efe3cd;
  --sheet: #fffaf0;
  --ink: #4a3b2f;
  --ink-soft: #75624f;
  --line: #e2d3ba;
  --seal: #b5573f;
  --moss: #6d8a5a;
  --moss-soft: #e9efdf;
  --warn: #a46c3e;
  --warn-soft: #faeee2;
  --glow: #f4c98a;
  --auth-serif: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;

  position: fixed; inset: 0; z-index: 9999; overflow: hidden auto;
  color: var(--ink);
  font-family: 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic', sans-serif;
  background:
    radial-gradient(ellipse 70% 60% at 12% 8%, color-mix(in srgb, var(--glow) 55%, transparent), transparent 70%),
    radial-gradient(ellipse 60% 55% at 88% 92%, color-mix(in srgb, var(--moss) 16%, transparent), transparent 70%),
    linear-gradient(160deg, var(--paper), var(--paper-deep));
}

/* Hinamiと同じ、挿絵を紙色でなじませる背景。 */
.auth-gate__art {
  position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 70% 60%; pointer-events: none;
  filter: var(--auth-artwork-filter);
  transform-origin: 75% 65%; animation: auth-breathe 40s ease-in-out infinite alternate;
}
.auth-gate__veil {
  position: fixed; inset: 0; pointer-events: none;
  background: linear-gradient(90deg, var(--paper), color-mix(in srgb, var(--paper) 60%, transparent) 30%, transparent 58%);
}

/* 舞う光の粒。下からゆっくり昇り、左右にそよぐ。 */
.auth-gate__motes { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
.auth-gate__motes i {
  position: absolute; bottom: -20px; left: var(--left); width: var(--size); height: var(--size); border-radius: 50%;
  background: radial-gradient(circle, #fff6df, var(--glow) 60%, transparent 72%);
  opacity: 0; animation: auth-mote var(--duration) linear var(--delay) infinite;
}

.auth-gate__layout {
  position: relative; min-height: 100%;
  display: grid; grid-template-columns: minmax(0, 1fr) 400px; grid-template-rows: 1fr auto;
  gap: 24px 56px; padding: 48px 64px;
}

/* ---- 見出し ---- */
.auth-hero { grid-column: 1; grid-row: 1; align-self: start; max-width: 540px; }
.auth-brand { display: flex; align-items: center; gap: 12px; }
.auth-brand__seal { width: 40px; height: 40px; object-fit: contain; transform: rotate(-3deg); }
.auth-brand__name { font-family: var(--auth-serif); font-size: 20px; font-weight: 700; letter-spacing: .5px; }
.auth-brand__ruby { color: var(--ink-soft); font-size: 11px; letter-spacing: 1.4px; }

.auth-hero__title {
  margin: 56px 0 0; font-family: var(--auth-serif); font-size: clamp(30px, 3.8vw, 46px); font-weight: 600;
  line-height: 1.5; letter-spacing: 1px;
}
.auth-hero__lead { margin: 20px 0 0; max-width: 360px; color: var(--ink-soft); font-size: 14px; line-height: 2; }

/* ---- ヒアリングの一頁（飾り） ---- */
.auth-page { grid-column: 1; grid-row: 2; align-self: end; width: min(480px, 100%); transition: opacity .8s ease; }
.auth-page.is-leaving { opacity: 0; }
.auth-page__ask {
  display: inline-flex; align-items: center; gap: 10px; margin: 0 0 12px; padding: 8px 16px 8px 10px;
  border-radius: 999px; background: color-mix(in srgb, var(--sheet) 80%, transparent);
  border: 1px solid var(--line); color: var(--ink); font-size: 13px;
}
.auth-page__ask b {
  padding: 1px 8px; border-radius: 999px; color: #fff8ee; background: var(--moss); font-size: 11px; font-weight: 600; letter-spacing: 1px;
}
.auth-page__paper {
  min-height: 236px; padding: 16px 22px 16px; border: 1px solid var(--line); border-radius: 6px 14px 14px 6px;
  background: var(--sheet);
  box-shadow: 0 14px 40px color-mix(in srgb, var(--ink) 12%, transparent), inset 6px 0 0 color-mix(in srgb, var(--moss) 16%, transparent);
}
.auth-page__line {
  display: grid; grid-template-columns: 34px 1fr; margin: 0; font-family: var(--auth-serif); font-size: 14px; line-height: 30px;
  opacity: 0; filter: blur(3px); transform: translateY(3px); transition: opacity 1.1s ease, filter 1.1s ease, transform 1.1s ease;
}
.auth-page__line b { color: var(--ink-soft); font-family: inherit; font-size: 11px; font-weight: 700; letter-spacing: 1px; }
.auth-page__line--ai b { color: var(--moss); }
.auth-page__line.is-shown { opacity: 1; filter: none; transform: none; }
.auth-page__fragments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--line); }
.auth-page__fragments span {
  padding: 3px 10px; border: 1px solid color-mix(in srgb, var(--moss) 35%, transparent); border-radius: 999px;
  color: var(--moss); background: var(--moss-soft); font-size: 12px; font-weight: 600;
  opacity: 0; transform: scale(.94); transition: opacity .6s ease, transform .6s ease;
}
.auth-page__fragments span.is-review { border-color: color-mix(in srgb, var(--warn) 35%, transparent); color: var(--warn); background: var(--warn-soft); }
.auth-page__fragments span.is-shown { opacity: 1; transform: none; }

/* ---- ログインカード ---- */
.auth-card {
  grid-column: 2; grid-row: 1 / span 2; align-self: center; padding: 34px 32px 30px;
  border: 1px solid var(--line); border-radius: 22px;
  background: color-mix(in srgb, var(--sheet) 90%, transparent); backdrop-filter: blur(10px);
  box-shadow: 0 24px 60px color-mix(in srgb, var(--ink) 16%, transparent);
  animation: auth-rise .9s ease-out both;
}
.auth-card__eyebrow { margin: 0 0 10px; color: var(--seal); font-size: 12px; font-weight: 700; letter-spacing: 1.6px; }
.auth-card h2 { margin: 0 0 10px; font-family: var(--auth-serif); font-size: 26px; font-weight: 600; letter-spacing: 1px; }
.auth-card__intro { margin: 0 0 26px; color: var(--ink-soft); font-size: 13px; line-height: 1.8; }
.auth-card__button { display: grid; min-height: 44px; }
.auth-card__button :slotted(.google-login-button) { min-height: 44px; }
.auth-card__demo { display: grid; gap: 10px; }
.auth-card__demo label { color: var(--ink-soft); font-size: 12px; font-weight: 700; letter-spacing: 1px; }
.auth-card__demo input {
  height: 44px; padding: 0 16px; border: 1px solid var(--line); border-radius: 22px;
  color: var(--ink); background: color-mix(in srgb, var(--sheet) 70%, transparent); font-size: 15px;
}
.auth-card__demo input:focus-visible { outline: 2px solid var(--seal); outline-offset: 1px; }
.auth-card__demo button {
  height: 44px; border: 0; border-radius: 22px; color: #fff; background: var(--seal);
  font-size: 15px; font-weight: 700; letter-spacing: 2px; cursor: pointer;
}
.auth-card__demo button:disabled { opacity: .5; cursor: default; }
.auth-card__demo .auth-card__note { margin-top: 4px; }
.auth-card__note { margin: 14px 0 0; color: var(--ink-soft); font-size: 12px; line-height: 1.7; }
.auth-card__pending {
  width: 100%; height: 44px; border: 1px dashed var(--line); border-radius: 22px;
  color: var(--ink-soft); background: transparent; font-size: 13px;
}
.auth-card__error {
  margin: 14px 0 0; padding: 9px 12px; border-radius: 10px;
  color: #98352a; background: #fbe8e2; font-size: 13px; line-height: 1.7;
}
.auth-card__status { display: flex; align-items: center; gap: 8px; margin: 14px 0 0; color: var(--ink-soft); font-size: 13px; }
.auth-card__spinner {
  width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--seal);
  border-radius: 50%; animation: auth-spin .9s linear infinite;
}

@keyframes auth-breathe { to { transform: scale(1.035); } }
@keyframes auth-mote {
  0% { opacity: 0; transform: translate(0, 0); }
  12% { opacity: .75; }
  85% { opacity: .55; }
  100% { opacity: 0; transform: translate(var(--sway), -105vh); }
}
@keyframes auth-rise { from { opacity: 0; transform: translateY(8px); } }
@keyframes auth-spin { to { transform: rotate(360deg); } }

@media (max-width: 1180px) {
  .auth-gate__layout { grid-template-columns: minmax(0, 1fr) 380px; padding: 40px; gap: 24px 32px; }
  .auth-page { display: none; }
}
/* 高さの低い画面（ノートPCなど）。飾りを外してスクロールを出さない。 */
@media (max-height: 720px) {
  .auth-page { display: none; }
}
@media (max-width: 780px) {
  .auth-gate__layout { grid-template-columns: 1fr; grid-template-rows: auto auto; padding: 28px 16px; }
  .auth-hero__title { margin-top: 32px; font-size: 28px; }
  .auth-card { grid-column: 1; grid-row: 2; padding: 26px 22px; }
}
@media (prefers-reduced-motion: reduce) {
  .auth-card, .auth-gate__art { animation: none; }
  .auth-page { transition: none; }
  .auth-gate__motes { display: none; }
  .auth-page__line, .auth-page__fragments span { transition: none; }
}
</style>
