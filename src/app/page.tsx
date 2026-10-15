"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Gauge,
  Lock,
  Loader2,
  Radar,
  Shield,
  Sparkles,
  Square,
  Upload,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Constantes do funil                                                */
/* ------------------------------------------------------------------ */

type Stage = "upload" | "scanning" | "hook" | "quiz" | "processing" | "offer";

const CHECKOUT_URL =
  "https://ggcheckout.app/checkout/v5/c706baf2-7033-483e-b1b2-05004fbf6f0a";

/** Durações mínimas (ansiedade) das 3 barras do scanner */
const MIN_SCAN_MS = 1700;
const BAR2_MS = 1600;
const BAR3_MS = 1950;
const REVEAL_MS = 900;
const OCR_TIMEOUT_MS = 25000;

const QUESTIONS = [
  {
    tag: "O Termômetro da Rejeição",
    text: "Na última semana, como tem sido a dinâmica de mensagens de vocês?",
    options: [
      "Eu mando mensagens longas, ele responde com poucas palavras (ou emojis).",
      "Ele visualiza e só responde horas (ou dias) depois.",
      "Ele só me procura de madrugada ou quando é conveniente para ele.",
      "Eu sinto que estou pisando em ovos para não irritá-lo.",
    ],
  },
  {
    tag: "A Quebra de Expectativa",
    text: "Quando ele age de forma fria ou cancela algo, qual costuma ser a sua reação automática?",
    options: [
      "Mando textão cobrando responsabilidade afetiva (e ele ignora).",
      "Finjo que está tudo bem, mas fico sofrendo e esperando ele voltar.",
      "Tento puxar outro assunto para não deixar a conversa morrer.",
    ],
  },
  {
    tag: "A Concorrência Invisível",
    text: "Seja honesta: qual é o seu maior medo em relação ao comportamento atual dele?",
    options: [
      "Que ele esteja perdendo o interesse e me troque por outra em breve.",
      "Que eu esteja me humilhando e perdendo meu tempo.",
      'Que ele só me veja como um "contatinho garantido" e nunca vá assumir nada.',
    ],
  },
  {
    tag: "O Nível de Submissão",
    text: "Se o sistema te der uma resposta agora que vai confrontar o ego dele e correr o risco de deixá-lo confuso, você tem coragem de copiar e colar?",
    options: [
      "Sim. Cansei de ser feita de boba. Quero o controle de volta.",
      "Não sei, tenho medo dele sumir de vez se eu for fria.",
    ],
  },
];

const PROCESS_STEPS = [
  "Cruzando as respostas com o texto lido do seu print...",
  "Calculando a sequência de Inversão de Polaridade...",
  "Gerando a resposta exata para o seu caso...",
];

/* ------------------------------------------------------------------ */
/*  Motor de análise (OCR real no navegador + regras)                  */
/* ------------------------------------------------------------------ */

type Analysis = {
  usable: boolean;
  score: number;
  verdict: string;
  messages: number;
  longMessages: number;
  shortReplies: number;
  shortExamples: string[];
  questions: number;
  justifications: number;
  doubleTexts: number;
  emojis: number;
  chips: string[];
};

const EMOJI_GLOBAL = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;
const JUSTIFICATION_RE =
  /\b(porqu[eê]|pq|por causa|e que|eh que|é que|desculp|perdoa|entende|só que|so que|na verdade)\b/i;
const JUSTIFICATION_GLOBAL = new RegExp(JUSTIFICATION_RE.source, "gi");

const STATUS_PT: Record<string, string> = {
  "loading tesseract core": "carregando motor de visão",
  "initializing tesseract": "inicializando motor",
  "loading language traineddata": "carregando pacote de idioma",
  "initializing api": "montando leitor de texto",
  "recognizing text": "escaneando padrões de texto",
};

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function rejectAfter(ms: number) {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), ms),
  );
}

/** Extrai o texto real do print usando Tesseract.js (100% no navegador). */
async function runOCR(
  file: File,
  onStep: (status: string, progress: number) => void,
): Promise<string> {
  const { createWorker } = await import("tesseract.js");

  const worker = await Promise.race([
    createWorker("por", 1, {
      logger: (m: { status: string; progress: number }) => {
        onStep(STATUS_PT[m.status] ?? "processando", m.progress ?? 0);
      },
    }),
    rejectAfter(20000),
  ]);

  try {
    const recognition = worker.recognize(file);
    const { data } = await Promise.race([recognition, rejectAfter(OCR_TIMEOUT_MS)]);
    return data?.text ?? "";
  } finally {
    worker.terminate().catch(() => {});
  }
}

/** Recupera as mensagens reais do print (usa o horário como divisor de bolhas). */
function splitBubbles(raw: string): string[] {
  const text = (raw || "").replace(/\r/g, "");

  /* Horários no formato 19:02, 19.02, e também os degradados pelo OCR (2215, 194) */
  const TIME_SPLIT = /(?:\b\d{1,2}[.:]\d{2}\b|\b\d{3,4}\b(?=[ \t]*$))/gm;

  if (TIME_SPLIT.test(text)) {
    TIME_SPLIT.lastIndex = 0;
    const parts = text
      .replace(TIME_SPLIT, "\n@@\n")
      .split(/@@/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(
        (p) =>
          p.length > 1 &&
          !/^(hoje|ontem|amanh[aã]|online|digitando|editado)$/i.test(p),
      )
      .map(explodeLongBubble)
      .flat()
      .map(splitShortRun)
      .flat()
      .filter((p) => p.length > 1);
    if (parts.length >= 3) return parts;
  }

  /* Fallback: o OCR só devolveu linhas — remonta as mensagens quebradas */
  const rawLines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1);

  const bubbles: string[] = [];
  for (const line of rawLines) {
    const prev = bubbles[bubbles.length - 1];
    const mustMerge =
      prev !== undefined &&
      prev.length >= 35 &&
      !/[.!?…:;)]$/.test(prev) &&
      line.length > 12 &&
      !/^\d{1,2}[.:]\d{2}$/.test(line);
    if (mustMerge) bubbles[bubbles.length - 1] = `${prev} ${line}`.trim();
    else bubbles.push(line);
  }
  return bubbles
    .flatMap(explodeLongBubble)
    .flatMap(splitShortRun)
    .filter((b) => b.length > 1);
}

/** Quando a fusão do OCR junta mensagens inteiras, separa por unidade de fala. */
function explodeLongBubble(bubble: string): string[] {
  if (bubble.length <= 300) return [bubble];

  const sentences = bubble.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const out: string[] = [];
  let acc = "";

  for (const sentence of sentences) {
    acc = acc ? `${acc} ${sentence}` : sentence;
    if (acc.length >= 140) {
      out.push(acc);
      acc = "";
    }
  }
  if (acc) {
    if (out.length > 0 && acc.length < 70) out[out.length - 1] = `${out[out.length - 1]} ${acc}`;
    else out.push(acc);
  }
  return out.length > 0 ? out : [bubble];
}

/** Bolhas curtas que o OCR grudou ("boa noite, Bom descanso") voltam a separar. */
function splitShortRun(bubble: string): string[] {
  if (bubble.length > 60) return [bubble];
  const parts = bubble
    .split(/\s*[,.;:]\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 1 && p.length <= 30);
  return parts.length >= 2 ? parts : [bubble];
}

function plural(n: number, singular: string, pluralForm: string) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Regras: transforma o texto bruto do print em um diagnóstico personalizado. */
function analyzeText(raw: string): Analysis {
  const bubbles = splitBubbles(raw);

  let longMessages = 0;
  let shortReplies = 0;
  let questions = 0;
  let justifications = 0;
  let doubleTexts = 0;
  let emojis = 0;
  let prevWasLong = false;
  const shortExamples: string[] = [];

  for (const bubble of bubbles) {
    emojis += (bubble.match(EMOJI_GLOBAL) ?? []).length;
    questions += (bubble.match(/\?/g) ?? []).length;
    justifications += bubble.match(JUSTIFICATION_GLOBAL)?.length ?? 0;

    const clean = bubble.replace(EMOJI_GLOBAL, "").replace(/[.,;:]+$/, "").trim();
    const isLong = clean.length >= 60;
    const isMinimal = clean.length <= 22 && !bubble.includes("?");

    if (isLong) {
      longMessages += 1;
      if (prevWasLong) doubleTexts += 1;
      prevWasLong = true;
    } else {
      prevWasLong = false;
    }

    if (isMinimal && clean && shortExamples.length < 3) {
      shortReplies += 1;
      if (!shortExamples.includes(clean)) shortExamples.push(clean);
    } else if (isMinimal) {
      shortReplies += 1;
    }
  }

  const usable = bubbles.length >= 3 && raw.replace(/\s/g, "").length >= 40;
  const total = Math.max(bubbles.length, 1);

  let score = 18;
  score += Math.min(28, (longMessages / total) * 50);
  score += Math.min(26, (shortReplies / total) * 70);
  score += Math.min(14, questions * 2);
  score += Math.min(10, doubleTexts * 3);
  score += Math.min(8, justifications * 2);
  if (shortReplies === 0) score -= 10;
  score = Math.max(12, Math.min(97, Math.round(score)));

  const verdict = score >= 70 ? "CRÍTICO" : score >= 45 ? "ALTO" : "MODERADO";

  const chips: string[] = [];
  if (usable) {
    chips.push(`${plural(longMessages, "mensagem longa", "mensagens longas")} (texto denso)`);
    chips.push(
      shortExamples.length
        ? `${plural(shortReplies, "resposta mínima", "respostas mínimas")} — ex.: "${shortExamples[0]}"`
        : plural(shortReplies, "resposta mínima", "respostas mínimas"),
    );
    chips.push(`${plural(questions, "pergunta", "perguntas")} na conversa`);
    chips.push(`${plural(justifications, "justificativa detectada", "justificativas detectadas")}`);
    if (doubleTexts > 0) {
      chips.push(`${plural(doubleTexts, "bloco", "blocos")} de texto duplo em sequência`);
    }
    if (emojis > 0) chips.push(`${plural(emojis, "emoji/reação", "emojis/reações")}`);
    chips.push(`Nível de fuga: ${score}%`);
  } else {
    chips.push(`só ${plural(bubbles.length, "trecho legível", "trechos legíveis")} nesta imagem`);
    chips.push("a calibragem manual vira a base do diagnóstico");
  }

  return {
    usable,
    score,
    verdict,
    messages: bubbles.length,
    longMessages,
    shortReplies,
    shortExamples,
    questions,
    justifications,
    doubleTexts,
    emojis,
    chips,
  };
}

/* ------------------------------------------------------------------ */
/*  Utilitários visuais                                                */
/* ------------------------------------------------------------------ */

const pageVariants = {
  initial: { opacity: 0, y: 26, filter: "blur(8px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: { opacity: 0, y: -22, filter: "blur(8px)" },
};

const pageTransition = { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const };

const blockTransition = (delay: number) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] as const },
});

const ambientGlow: React.CSSProperties = {
  background:
    "radial-gradient(65% 45% at 50% 0%, rgba(217,70,239,0.20), transparent 70%), radial-gradient(55% 35% at 50% 100%, rgba(168,85,247,0.10), transparent 70%)",
};

const gridPattern: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
  backgroundSize: "44px 44px",
  maskImage: "radial-gradient(ellipse at center, black 25%, transparent 78%)",
  WebkitMaskImage: "radial-gradient(ellipse at center, black 25%, transparent 78%)",
};

const stageSegment: Record<Stage, number> = {
  upload: 1,
  scanning: 2,
  hook: 2,
  quiz: 2,
  processing: 2,
  offer: 3,
};

/* ------------------------------------------------------------------ */
/*  Página                                                             */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [stage, setStage] = useState<Stage>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [bars, setBars] = useState([0, 0, 0]);
  const [ocrStatus, setOcrStatus] = useState("preparando motor de visão");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);

  const [qIndex, setQIndex] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [locked, setLocked] = useState(false);
  const [popup, setPopup] = useState(false);

  const [procStep, setProcStep] = useState(0);
  const [blink, setBlink] = useState(true);

  const fileInput = useRef<HTMLInputElement>(null);

  const go = useCallback((next: Stage) => {
    setStage(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  /* Texto piscando durante o scan */
  useEffect(() => {
    if (stage !== "scanning") return;
    const id = setInterval(() => setBlink((v) => !v), 520);
    return () => clearInterval(id);
  }, [stage]);

  /* Scan: OCR real + barras sequenciais */
  useEffect(() => {
    if (stage !== "scanning" || !file) return;
    let cancelled = false;

    const startedAt = Date.now();

    (async () => {
      let text = "";

      try {
        text = await runOCR(file, (status, progress) => {
          if (cancelled) return;
          setOcrStatus(status);
          setBars((prev) => {
            const mapped =
              status === "escaneando padrões de texto"
                ? Math.round(progress * 100)
                : Math.min(prev[0], Math.round(progress * 12));
            return [Math.max(prev[0], mapped), prev[1], prev[2]];
          });
        });
      } catch {
        text = "";
      }

      if (cancelled) return;

      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_SCAN_MS) await wait(MIN_SCAN_MS - elapsed);
      if (cancelled) return;

      const result = analyzeText(text);
      setAnalysis(result);
      setOcrStatus("texto extraído — cruzando padrões");
      setBars([100, 0, 0]);

      await wait(BAR2_MS);
      if (cancelled) return;
      setBars([100, 100, 0]);

      await wait(BAR3_MS);
      if (cancelled) return;
      setBars([100, 100, 100]);

      await wait(REVEAL_MS);
      if (cancelled) return;
      go("hook");
    })();

    return () => {
      cancelled = true;
    };
  }, [stage, file, go]);

  /* Processamento das respostas do quiz */
  useEffect(() => {
    if (stage !== "processing") return;
    const t1 = setTimeout(() => setProcStep(1), 800);
    const t2 = setTimeout(() => setProcStep(2), 1600);
    const t3 = setTimeout(() => go("offer"), 2500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [stage, go]);

  const handleFile = (picked: File | null | undefined) => {
    if (stage !== "upload" || !picked) return;
    if (picked.type && !picked.type.startsWith("image/")) {
      setFileError("Formato inválido — envie um print em PNG ou JPG.");
      return;
    }
    setFileError(null);
    setBars([0, 0, 0]);
    setOcrStatus("preparando motor de visão");
    setFile(picked);
    go("scanning");
  };

  const selectAnswer = (index: number) => {
    if (locked) return;
    setLocked(true);
    setAnswers((prev) => [...prev, index]);

    if (qIndex === 3 && index === 1) {
      setPopup(true);
      return;
    }
    setTimeout(() => {
      if (qIndex >= QUESTIONS.length - 1) {
        setProcStep(0);
        go("processing");
      } else setQIndex((q) => q + 1);
      setLocked(false);
    }, 340);
  };

  const closePopup = () => {
    setPopup(false);
    setTimeout(() => {
      if (qIndex >= QUESTIONS.length - 1) {
        setProcStep(0);
        go("processing");
      } else setQIndex((q) => q + 1);
      setLocked(false);
    }, 320);
  };

  const restart = () => {
    setFile(null);
    setAnalysis(null);
    setBars([0, 0, 0]);
    setQIndex(0);
    setAnswers([]);
    setLocked(false);
    setPopup(false);
    setFileError(null);
    go("upload");
  };

  /* Leitura cruzada print + quiz */
  const submissionSignals =
    (answers[0] === 0 || answers[0] === 3 ? 1 : 0) +
    (answers[1] === 1 ? 1 : 0) +
    (answers[2] === 1 ? 1 : 0) +
    (answers[3] === 1 ? 1 : 0);

  const fearLabel =
    answers[2] === 0
      ? "perda iminente"
      : answers[2] === 1
        ? "autossabotagem"
        : "ser só a garantida";

  const current = QUESTIONS[qIndex];

  return (
    <main className="relative min-h-screen overflow-hidden bg-zinc-950 text-white selection:bg-fuchsia-500/40">
      <div aria-hidden className="pointer-events-none fixed inset-0" style={ambientGlow} />
      <div aria-hidden className="pointer-events-none fixed inset-0" style={gridPattern} />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-56 bg-gradient-to-b from-fuchsia-600/10 to-transparent"
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-lg flex-col px-5 pb-10 pt-7">
        {/* Header / status do sistema */}
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fuchsia-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-fuchsia-500" />
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuchsia-200">
              Decodificador v2.4
            </span>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
            SSL 256-bit
          </span>
        </header>

        {/* Stepper: Envio → Calibragem → Liberação */}
        <div className="mt-5 flex gap-1.5" aria-hidden>
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full transition-all duration-500 ${
                stageSegment[stage] >= s
                  ? "bg-fuchsia-500 shadow-[0_0_10px_rgba(217,70,239,0.7)]"
                  : "bg-white/10"
              }`}
            />
          ))}
        </div>

        <AnimatePresence mode="wait">
          {/* ========================= ESTADO 1: CAPTURA ========================= */}
          {stage === "upload" && (
            <motion.section
              key="upload"
              variants={pageVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={pageTransition}
              className="flex flex-1 flex-col justify-center py-10"
            >
              <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                <span className="font-mono text-[10px] uppercase tracking-widest text-amber-300">
                  Análise gratuita • vagas limitadas hoje
                </span>
              </div>

              <h1 className="mt-5 text-4xl font-black leading-[1.05] tracking-tight text-white sm:text-5xl">
                Pare de inventar desculpas para a{" "}
                <span className="bg-gradient-to-r from-fuchsia-400 via-fuchsia-500 to-pink-500 bg-clip-text text-transparent">
                  frieza dele.
                </span>
              </h1>

              <p className="mt-5 text-pretty text-[15px] leading-relaxed text-zinc-400">
                Nossa Inteligência Artificial foi treinada com mais de{" "}
                <span className="font-semibold text-zinc-200">
                  500.000 conversas masculinas vazadas.
                </span>{" "}
                Faça o upload do último print onde ele te deixou no vácuo ou respondeu seco. A IA vai
                traduzir o que ele realmente quis dizer.
              </p>

              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  handleFile(e.dataTransfer.files?.[0]);
                }}
                className={`mt-8 w-full cursor-pointer rounded-3xl border-2 border-dashed p-8 text-center outline-none transition-all duration-300 focus-visible:ring-2 focus-visible:ring-fuchsia-500 ${
                  dragging
                    ? "scale-[1.02] border-fuchsia-400 bg-fuchsia-500/15"
                    : "border-fuchsia-500/40 bg-fuchsia-500/5 hover:border-fuchsia-400 hover:bg-fuchsia-500/10"
                }`}
              >
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-fuchsia-600 shadow-[0_0_35px_-6px_rgba(217,70,239,0.9)]">
                  <Upload className="h-7 w-7 text-white" strokeWidth={2.2} />
                </div>
                <p className="mt-4 text-base font-bold text-white">
                  Toque para enviar o print da conversa
                </p>
                <p className="mt-1.5 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
                  arraste e solte também • PNG / JPG • até 10 MB
                </p>
              </div>

              {fileError && (
                <p className="mt-3 text-center text-xs font-semibold text-red-400">{fileError}</p>
              )}

              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  handleFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />

              <div className="mt-6 flex items-start gap-2 text-zinc-500">
                <Shield className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <p className="text-xs leading-relaxed">
                  100% anônimo. O print é lido apenas no seu navegador — nada é salvo nem
                  compartilhado.
                </p>
              </div>
            </motion.section>
          )}

          {/* ========================= ESTADO 2: SCAN / OCR ========================= */}
          {stage === "scanning" && (
            <motion.section
              key="scanning"
              variants={pageVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={pageTransition}
              className="flex flex-1 flex-col justify-center py-10"
            >
              <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-black/60 shadow-[0_0_60px_-20px_rgba(217,70,239,0.6)] backdrop-blur">
                <motion.div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-fuchsia-500/15 to-transparent"
                  animate={{ y: ["0%", "520%"] }}
                  transition={{ duration: 2.1, repeat: Infinity, ease: "easeInOut" }}
                />

                <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
                  <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                    ocr_scanner.exe
                  </span>
                </div>

                <div className="relative px-5 py-7 sm:px-6">
                  <p
                    className={`text-center font-mono text-sm font-semibold tracking-wide text-fuchsia-300 transition-opacity duration-200 ${
                      blink ? "opacity-100" : "opacity-20"
                    }`}
                  >
                    Decodificando padrões de linguagem...
                  </p>

                  <div className="mt-7 space-y-5">
                    {[
                      { label: "Escaneando padrões de texto...", ms: MIN_SCAN_MS },
                      { label: "Mapeando subcomunicação de baixo valor...", ms: BAR2_MS },
                      {
                        label: "Cruzando dados com o Padrão de Fuga Masculino...",
                        ms: BAR3_MS,
                      },
                    ].map((bar, i) => {
                      const done = bars[i] === 100;
                      const active = !done && bars.slice(0, i).every((w) => w === 100);

                      return (
                        <div key={bar.label}>
                          <div className="flex items-start justify-between gap-3">
                            <span
                              className={`font-mono text-[11px] leading-snug ${
                                active
                                  ? "text-fuchsia-200"
                                  : done
                                    ? "text-zinc-400"
                                    : "text-zinc-600"
                              }`}
                            >
                              {bar.label}
                            </span>
                            <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wider">
                              {done ? (
                                <>
                                  <Check className="h-3 w-3 text-fuchsia-400" />
                                  <span className="text-fuchsia-400">100%</span>
                                </>
                              ) : active ? (
                                <>
                                  <Loader2 className="h-3 w-3 animate-spin text-fuchsia-400" />
                                  <span className="text-fuchsia-300">
                                    {bars[i]}%
                                  </span>
                                </>
                              ) : (
                                <span className="text-zinc-700">—</span>
                              )}
                            </span>
                          </div>

                          <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/5 ring-1 ring-inset ring-white/10">
                            <div
                              className={`h-full rounded-full ${
                                done
                                  ? "bg-fuchsia-600"
                                  : "bg-gradient-to-r from-fuchsia-600 to-pink-500"
                              } ${active ? "shadow-[0_0_14px_rgba(217,70,239,0.85)]" : ""}`}
                              style={{
                                width: `${bars[i]}%`,
                                transitionProperty: "width",
                                transitionTimingFunction: "linear",
                                transitionDuration: `${bar.ms}ms`,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-7 flex items-center justify-center gap-2">
                    <Radar className="h-3.5 w-3.5 animate-spin text-fuchsia-500" />
                    <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-600">
                      {ocrStatus}
                    </p>
                  </div>
                </div>
              </div>

              <p className="mt-4 text-center text-xs text-zinc-600">
                A IA está lendo o texto do seu print, linha por linha.
              </p>
            </motion.section>
          )}

          {/* ========================= PASSO 1: ANÁLISE RETIDA ========================= */}
          {stage === "hook" && (
            <motion.section
              key="hook"
              variants={pageVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={pageTransition}
              className="flex flex-1 flex-col justify-center py-8"
            >
              {/* Conclusão do scan */}
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-emerald-400">
                <Check className="h-4 w-4" />
                Escaneando padrões de texto... <span className="text-emerald-300">100%</span>
              </div>

              {/* Alerta */}
              <div className="mt-4 rounded-3xl border border-red-500/40 bg-red-950/40 p-5 shadow-[0_0_50px_-18px_rgba(239,68,68,0.9)]">
                <div className="flex items-start gap-3">
                  <AlertTriangle
                    className="mt-0.5 h-6 w-6 shrink-0 animate-pulse text-red-400"
                    strokeWidth={2.2}
                  />
                  <div className="min-w-0">
                    <h2 className="text-lg font-black leading-snug text-red-300">
                      ⚠️ Padrão de Fuga Emocional Detectado nas falas dele.
                    </h2>

                    <p className="mt-3 text-pretty text-sm leading-relaxed text-red-100/85">
                      {analysis?.usable
                        ? `Leitura concluída: ${plural(analysis.messages, "mensagem identificada", "mensagens identificadas")} no seu print. Foram mapeadas ${plural(analysis.longMessages, "mensagem longa", "mensagens longas")} de texto denso contra ${plural(analysis.shortReplies, "resposta mínima", "respostas mínimas")}${analysis.shortExamples[0] ? ` (ex.: "${analysis.shortExamples[0]}")` : ""}, além de ${plural(analysis.questions, "pergunta", "perguntas")} e ${plural(analysis.justifications, "justificativa", "justificativas")}. O nível de fuga registrado ficou em ${analysis.score}% — classificação ${analysis.verdict}.`
                        : "A leitura automática desta imagem ficou limitada — o texto do print não pôde ser extraído com qualidade. Mesmo assim, o padrão foi identificado: a calibragem com as 4 perguntas é o que vai fechar o diagnóstico exato do seu caso."}
                    </p>

                    <div className="mt-4 flex flex-wrap gap-2">
                      {(analysis?.chips ?? []).map((chip) => (
                        <span
                          key={chip}
                          className="rounded-full border border-red-400/30 bg-black/40 px-2.5 py-1 font-mono text-[10px] tracking-wide text-red-200/90"
                        >
                          {chip}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Texto de transição */}
              <div className="mt-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5">
                <div className="mb-3 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-fuchsia-400" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuchsia-300">
                    Sistema travado — diagnóstico parcial
                  </span>
                </div>
                <p className="text-pretty text-[15px] leading-relaxed text-zinc-300">
                  A nossa IA conseguiu mapear o nível de desinteresse na mensagem enviada. Porém,
                  para que o sistema gere a resposta de Inversão de Polaridade exata para o seu caso
                  (e não uma resposta genérica), precisamos calibrar o algoritmo com o histórico de
                  vocês.{" "}
                  <span className="font-semibold text-white">Responda com sinceridade.</span>
                </p>
              </div>

              <motion.button
                type="button"
                onClick={() => go("quiz")}
                animate={{ scale: [1, 1.02, 1] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-2xl bg-fuchsia-600 px-5 py-5 text-[15px] font-black uppercase leading-tight tracking-wide text-white shadow-[0_0_50px_-8px_rgba(217,70,239,0.95)] transition-colors hover:bg-fuchsia-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <Gauge className="h-5 w-5 shrink-0" strokeWidth={2.4} />
                Iniciar Calibragem (4 Perguntas Rápidas)
              </motion.button>

              <p className="mt-3 text-center text-xs text-zinc-600">
                Leva menos de 40 segundos. Suas respostas não são salvas.
              </p>
            </motion.section>
          )}

          {/* ========================= PASSO 2: QUIZ ========================= */}
          {stage === "quiz" && (
            <motion.section
              key="quiz"
              variants={pageVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={pageTransition}
              className="flex flex-1 flex-col py-8"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuchsia-300">
                  Calibragem do algoritmo
                </span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                  {qIndex + 1} de {QUESTIONS.length}
                </span>
              </div>

              <div className="mt-2 flex gap-1.5" aria-hidden>
                {QUESTIONS.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-full transition-all duration-500 ${
                      i <= qIndex
                        ? "bg-fuchsia-500 shadow-[0_0_10px_rgba(217,70,239,0.7)]"
                        : "bg-white/10"
                    }`}
                  />
                ))}
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={qIndex}
                  initial={{ opacity: 0, x: 30 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -30 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    Pergunta {qIndex + 1} • {current.tag}
                  </p>
                  <h2 className="mt-3 text-pretty text-xl font-bold leading-snug text-white">
                    {current.text}
                  </h2>

                  <div className="mt-6 space-y-3">
                    {current.options.map((option, i) => (
                      <button
                        key={option}
                        type="button"
                        disabled={locked}
                        onClick={() => selectAnswer(i)}
                        className={`flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-500 ${
                          locked && answers[qIndex] === i
                            ? "border-fuchsia-500 bg-fuchsia-500/20"
                            : "border-white/10 bg-white/[0.03] hover:border-fuchsia-500/50 hover:bg-fuchsia-500/10"
                        }`}
                      >
                        <span className="mt-0.5 shrink-0">
                          {locked && answers[qIndex] === i ? (
                            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-fuchsia-600">
                              <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />
                            </span>
                          ) : (
                            <Square className="h-5 w-5 text-zinc-600" strokeWidth={1.6} />
                          )}
                        </span>
                        <span className="text-pretty text-[15px] leading-snug text-zinc-200">
                          {option}
                        </span>
                      </button>
                    ))}
                  </div>
                </motion.div>
              </AnimatePresence>

              {/* Pop-up do medo (Pergunta 4, opção 2) */}
              <AnimatePresence>
                {popup && (
                  <motion.div
                    key="popup"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-5 backdrop-blur-sm"
                  >
                    <motion.div
                      initial={{ scale: 0.92, y: 18 }}
                      animate={{ scale: 1, y: 0 }}
                      exit={{ scale: 0.95, opacity: 0 }}
                      transition={{ duration: 0.28 }}
                      className="w-full max-w-sm rounded-3xl border border-red-500/40 bg-zinc-950 p-6 shadow-[0_0_60px_-15px_rgba(239,68,68,0.9)]"
                    >
                      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600/20 ring-1 ring-red-500/40">
                        <AlertTriangle className="h-6 w-6 text-red-400" />
                      </div>
                      <h3 className="mt-4 text-center text-lg font-black text-red-300">
                        Alerta do Sistema
                      </h3>
                      <p className="mt-3 text-pretty text-center text-sm leading-relaxed text-zinc-300">
                        Se você continuar agindo como age hoje, o sumiço dele é questão de dias.
                        Aceite a ajuda.
                      </p>
                      <button
                        type="button"
                        onClick={closePopup}
                        className="mt-5 w-full rounded-2xl bg-fuchsia-600 px-4 py-3.5 text-sm font-black uppercase tracking-wide text-white transition-colors hover:bg-fuchsia-500"
                      >
                        Aceitar a ajuda
                      </button>
                      <button
                        type="button"
                        onClick={closePopup}
                        className="mt-2 w-full rounded-2xl px-4 py-2.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                      >
                        Continuar agindo como antes
                      </button>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.section>
          )}

          {/* ========================= PROCESSAMENTO DAS RESPOSTAS ========================= */}
          {stage === "processing" && (
            <motion.section
              key="processing"
              variants={pageVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={pageTransition}
              className="flex flex-1 flex-col justify-center py-10"
            >
              <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-black/60 px-5 py-7 shadow-[0_0_60px_-20px_rgba(217,70,239,0.6)] sm:px-6">
                <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                  <Loader2 className="h-4 w-4 animate-spin text-fuchsia-400" />
                  <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                    calibrating_profile.exe
                  </span>
                </div>

                <div className="mt-5 space-y-3">
                  {PROCESS_STEPS.map((step, i) => {
                    const active = i === procStep;
                    const done = i < procStep;
                    return (
                      <div key={step} className="flex items-center gap-2">
                        {done ? (
                          <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                        ) : active ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-fuchsia-400" />
                        ) : (
                          <Square className="h-4 w-4 shrink-0 text-zinc-700" strokeWidth={1.6} />
                        )}
                        <span
                          className={`font-mono text-[12px] leading-snug ${
                            active
                              ? "text-fuchsia-200"
                              : done
                                ? "text-zinc-400"
                                : "text-zinc-700"
                          }`}
                        >
                          {step}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-6 h-2 overflow-hidden rounded-full bg-white/5 ring-1 ring-inset ring-white/10">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-fuchsia-600 to-pink-500"
                    initial={{ width: "0%" }}
                    animate={{ width: "100%" }}
                    transition={{ duration: 2.4, ease: "linear" }}
                  />
                </div>
              </div>

              <p className="mt-4 text-center text-xs text-zinc-600">
                Cruzando {analysis?.usable ? "o texto do print" : "o envio"} com suas{" "}
                {QUESTIONS.length} respostas...
              </p>
            </motion.section>
          )}

          {/* ========================= PASSO 3: EXPLICAÇÃO LÓGICA + OFERTA ========================= */}
          {stage === "offer" && (
            <motion.section key="offer" className="flex flex-1 flex-col py-8">
              <motion.div
                {...blockTransition(0)}
                className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-emerald-400"
              >
                <Check className="h-4 w-4" />
                Diagnóstico personalizado concluído
              </motion.div>

              {/* Chips de leitura cruzada */}
              <motion.div {...blockTransition(0.06)} className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-2.5 py-1 font-mono text-[10px] tracking-wide text-fuchsia-200">
                  Ciclo da Disponibilidade • nível {analysis?.score ?? 74}%
                </span>
                <span className="rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-2.5 py-1 font-mono text-[10px] tracking-wide text-fuchsia-200">
                  {submissionSignals}/4 indicadores de submissão
                </span>
                <span className="rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-2.5 py-1 font-mono text-[10px] tracking-wide text-fuchsia-200">
                  Medo dominante: {fearLabel}
                </span>
              </motion.div>

              {/* Headline */}
              <motion.h1
                {...blockTransition(0.12)}
                className="mt-5 text-pretty text-3xl font-black leading-[1.1] tracking-tight text-white sm:text-4xl"
              >
                O seu print não é um caso isolado. Você está presa no{" "}
                <span className="bg-gradient-to-r from-fuchsia-400 via-fuchsia-500 to-pink-500 bg-clip-text text-transparent">
                  &quot;Ciclo da Disponibilidade&quot;
                </span>
                . Mas a ciência comportamental sabe exatamente como reverter isso.
              </motion.h1>

              {/* Corpo lógico */}
              <motion.div {...blockTransition(0.2)} className="mt-6 space-y-4">
                <p className="text-pretty text-[15px] leading-relaxed text-zinc-300">
                  As perguntas que você acabou de responder confirmaram o que a nossa IA já
                  suspeitava ao ler o seu print:{" "}
                  <span className="font-semibold text-white">
                    você perdeu o poder na dinâmica.
                  </span>
                </p>

                <p className="text-pretty text-[15px] leading-relaxed text-zinc-400">
                  Ele não está ocupado demais. Ele não está confuso. O cérebro masculino responde a
                  estímulos de recompensa e esforço, e neste momento, você se tornou previsível e
                  fácil de acessar.
                </p>

                <div className="rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/5 p-4">
                  <p className="text-pretty text-[15px] leading-relaxed text-zinc-300">
                    As respostas e os scripts que o nosso algoritmo gerou para você não são &quot;dicas
                    de amigas&quot; ou joguinhos infantis. Nossa inteligência processou mais de{" "}
                    <span className="font-semibold text-fuchsia-300">10.000 horas</span> de
                    dinâmicas reais de casais e cruzou essas informações com os estudos mais densos
                    de psicologia comportamental, gatilhos de dissonância cognitiva e persuasão
                    avançada.
                  </p>
                </div>

                <p className="text-pretty text-[15px] leading-relaxed text-zinc-300">
                  O que você está prestes a acessar é{" "}
                  <span className="font-semibold text-white">
                    pura engenharia social aplicada a relacionamentos.
                  </span>
                </p>

                <p className="text-pretty text-[15px] leading-relaxed text-zinc-400">
                  Nós mapeamos as exatas sequências de palavras que desarmam as defesas de um homem e
                  o forçam a recalcular o seu valor. Ao copiar e colar as mensagens que o sistema
                  preparou, você vai acionar o{" "}
                  <span className="font-semibold text-fuchsia-300">Gatilho da Perda</span> diretamente
                  no subconsciente dele. Ele deixará de ver você como uma opção garantida e passará a
                  ver você como um desafio que está prestes a escapar.
                </p>
              </motion.div>

              {/* CTA */}
              <motion.div
                {...blockTransition(0.3)}
                className="mt-6 rounded-3xl border border-fuchsia-500/30 bg-gradient-to-b from-fuchsia-600/10 to-transparent p-5 text-center"
              >
                <p className="text-pretty text-[15px] leading-relaxed text-zinc-200">
                  O seu Script de Inversão de Polaridade está pronto, baseado no print e no perfil
                  que você acabou de traçar.
                </p>
                <p className="mt-3 text-pretty text-[15px] font-semibold leading-relaxed text-red-300">
                  Cada minuto que você continua agindo no desespero, esfria ele um pouco mais.
                </p>

                <motion.a
                  href={CHECKOUT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  animate={{ scale: [1, 1.035, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                  className="mt-5 flex w-full items-center justify-center gap-2.5 rounded-2xl bg-fuchsia-600 px-5 py-5 text-center text-[15px] font-black uppercase leading-tight tracking-wide text-white shadow-[0_0_50px_-8px_rgba(217,70,239,0.95)] transition-colors hover:bg-fuchsia-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  <Lock className="h-5 w-5 shrink-0" strokeWidth={2.4} />
                  Desbloquear o Decodificador de Mensagens agora
                  <Lock className="h-5 w-5 shrink-0" strokeWidth={2.4} />
                </motion.a>

                <div className="mt-4 flex items-center justify-center gap-1.5 text-zinc-500">
                  <Shield className="h-3.5 w-3.5 text-emerald-400" />
                  <p className="font-mono text-[11px] uppercase tracking-wider">
                    Pagamento Único. Acesso Imediato. 100% Anônimo e Seguro.
                  </p>
                </div>
              </motion.div>

              <button
                type="button"
                onClick={restart}
                className="mx-auto mt-6 flex items-center gap-1.5 font-mono text-[11px] text-zinc-700 underline-offset-4 transition-colors hover:text-zinc-400 hover:underline"
              >
                <ArrowRight className="h-3 w-3 rotate-180" /> nova análise
              </button>
            </motion.section>
          )}
        </AnimatePresence>

        <footer className="mt-auto pt-6 text-center">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-700">
            © Decodificador de Mensagens • uso educacional
          </p>
        </footer>
      </div>
    </main>
  );
}
