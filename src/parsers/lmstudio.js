'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ENVIRONMENT = 'lmstudio';

const TS_PREFIX_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/;
const RUNNING_RE = /\[INFO\]\[([^\]]+)\] Running chat completion/;
const LAUNCH_SLOT_RE = /slot launch_slot_: id\s*(\d+) \| task (\d+) \| processing task/;
const LIVE_GEN_RE = /slot print_timing: id\s*(\d+) \| task (\d+) \| n_gen =\s*(\d+), tg =\s*([\d.]+) t\/s, tg_3s =\s*([\d.]+) t\/s/;
const LIVE_PROMPT_RE = /slot print_timing: id\s*(\d+) \| task (\d+) \| prompt processing, n_tokens =\s*(\d+), progress = ([\d.]+), t =\s*([\d.]+) s \/ ([\d.]+) tokens per second/;
const PROMPT_EVAL_RE = /task (\d+) \| prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens \(\s*[\d.]+ ms per token,\s*([\d.]+) tokens per second\)/;
const GEN_EVAL_RE = /task (\d+) \|\s+eval time =\s*([\d.]+) ms \/\s*(\d+) tokens \(\s*[\d.]+ ms per token,\s*([\d.]+) tokens per second\)/;
const RELEASE_RE = /slot\s+release: id\s*(\d+) \| task (\d+) \| stop processing/;

/**
 * LM Studio ("Bionic") uygulamasinin server-logs dizinlerini bulur.
 * Surumler arasinda kok yolu degisti (~/.lmstudio/server-logs ve
 * ~/.lmstudio/apps/<app>/server-logs), bu yuzden ikisi de taranir.
 */
function findLogRoots(lmstudioHome) {
  const roots = [];
  const direct = path.join(lmstudioHome, 'server-logs');
  if (fs.existsSync(direct)) roots.push(direct);

  const appsDir = path.join(lmstudioHome, 'apps');
  if (fs.existsSync(appsDir)) {
    for (const app of fs.readdirSync(appsDir)) {
      const candidate = path.join(appsDir, app, 'server-logs');
      if (fs.existsSync(candidate)) roots.push(candidate);
    }
  }
  return roots;
}

/** Tum .log dosyalarini (YYYY-MM/*.log) bulur, yol olarak dondurur. */
function listLogFiles(lmstudioHome) {
  const files = [];
  for (const root of findLogRoots(lmstudioHome)) {
    for (const monthDir of fs.readdirSync(root)) {
      const full = path.join(root, monthDir);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const file of fs.readdirSync(full)) {
        if (file.endsWith('.log')) {
          files.push(path.join(full, file));
        }
      }
    }
  }
  return files;
}

/**
 * Tek bir log dosyasini parse eden durum makinesi. Her dosya kendi
 * gorev(task)/model eslesme kuyrugunu tutar (sunucu her yeniden baslayista
 * task id'lerini sifirlar).
 */
class LmStudioFileParser {
  constructor(filePath, onEvent, onLiveTick) {
    this.filePath = filePath;
    this.onEvent = onEvent;
    this.onLiveTick = onLiveTick;
    this.lastTimestamp = Date.now();
    this.currentModel = 'bilinmeyen-model';
    this.taskModel = new Map();
    this.taskPromptStats = new Map();
    this.taskLastLiveGen = new Map();
    this.taskCompleted = new Set();
  }

  _resolveModel(taskId) {
    return this.taskModel.get(taskId) || 'bilinmeyen-model';
  }

  processLine(line) {
    const tsMatch = TS_PREFIX_RE.exec(line);
    if (tsMatch) {
      // LM Studio zaman damgalari makinenin yerel saatiyle yazilir (UTC degil);
      // bilesenlerden yerel Date olusturmak sistem saat dilimiyle dogru eslesir.
      const [, y, mo, d, h, mi, s] = tsMatch;
      const parsed = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
      if (!Number.isNaN(parsed)) this.lastTimestamp = parsed;
    }

    const running = RUNNING_RE.exec(line);
    if (running) {
      // "Running chat completion" bir istek icin BIRDEN FAZLA launch_slot_
      // tetikleyebilir (ilk slot tamamlanmadan ikincisi baslayabilir); bu yuzden
      // model adi tek seferlik bir kuyruktan degil, bir sonraki "Running" satirina
      // kadar gecerli kalan "guncel model" degerinden okunur.
      this.currentModel = running[1];
      return;
    }

    const launch = LAUNCH_SLOT_RE.exec(line);
    if (launch) {
      const taskId = Number(launch[2]);
      this.taskModel.set(taskId, this.currentModel);
      return;
    }

    const livePrompt = LIVE_PROMPT_RE.exec(line);
    if (livePrompt) {
      const taskId = Number(livePrompt[2]);
      if (this.onLiveTick) {
        this.onLiveTick({
          phase: 'prompt',
          taskId,
          model: this._resolveModel(taskId),
          environment: ENVIRONMENT,
          tokens: Number(livePrompt[3]),
          progress: Number(livePrompt[4]),
          tokensPerSecond: Number(livePrompt[6]),
          ts: this.lastTimestamp,
        });
      }
      return;
    }

    const liveGen = LIVE_GEN_RE.exec(line);
    if (liveGen) {
      const taskId = Number(liveGen[2]);
      const nGen = Number(liveGen[3]);
      const tps3s = Number(liveGen[5]);
      this.taskLastLiveGen.set(taskId, { nGen, tps: tps3s });
      if (this.onLiveTick) {
        this.onLiveTick({
          phase: 'generate',
          taskId,
          model: this._resolveModel(taskId),
          environment: ENVIRONMENT,
          tokens: nGen,
          tokensPerSecond: tps3s,
          ts: this.lastTimestamp,
        });
      }
      return;
    }

    const promptEval = PROMPT_EVAL_RE.exec(line);
    if (promptEval) {
      const taskId = Number(promptEval[1]);
      this.taskPromptStats.set(taskId, {
        promptMs: Number(promptEval[2]),
        promptTokens: Number(promptEval[3]),
        promptTps: Number(promptEval[4]),
      });
      return;
    }

    const genEval = GEN_EVAL_RE.exec(line);
    if (genEval) {
      const taskId = Number(genEval[1]);
      const genMs = Number(genEval[2]);
      const completionTokens = Number(genEval[3]);
      const genTps = Number(genEval[4]);
      this._emitCompletion(taskId, { genMs, completionTokens, genTps, truncated: false });
      return;
    }

    const release = RELEASE_RE.exec(line);
    if (release) {
      const taskId = Number(release[2]);
      // Eger "eval time" satiri hic gelmediyse (istek iptal/kesildi), son canli
      // tikten tahmini bir kayit uret ki token harcamasi kaybolmasin.
      if (!this.taskCompleted.has(taskId) && this.taskModel.has(taskId)) {
        const lastLive = this.taskLastLiveGen.get(taskId);
        if (lastLive) {
          this._emitCompletion(taskId, {
            genMs: null,
            completionTokens: lastLive.nGen,
            genTps: lastLive.tps,
            truncated: true,
          });
        }
      }
      this.taskModel.delete(taskId);
      this.taskPromptStats.delete(taskId);
      this.taskLastLiveGen.delete(taskId);
      this.taskCompleted.delete(taskId);
    }
  }

  _emitCompletion(taskId, gen) {
    if (this.taskCompleted.has(taskId)) return;
    this.taskCompleted.add(taskId);
    const prompt = this.taskPromptStats.get(taskId) || { promptMs: null, promptTokens: 0, promptTps: null };
    const model = this._resolveModel(taskId);
    this.onEvent({
      id: `${ENVIRONMENT}-${taskId}-${this.lastTimestamp}-${Math.random().toString(36).slice(2, 8)}`,
      ts: this.lastTimestamp,
      environment: ENVIRONMENT,
      model,
      promptTokens: prompt.promptTokens,
      completionTokens: gen.completionTokens,
      totalTokens: prompt.promptTokens + gen.completionTokens,
      promptMs: prompt.promptMs,
      genMs: gen.genMs,
      promptTps: prompt.promptTps,
      genTps: gen.genTps,
      truncated: !!gen.truncated,
      taskId,
    });
  }
}

function defaultLmStudioHome() {
  return process.env.LMSTUDIO_HOME || path.join(os.homedir(), '.lmstudio');
}

module.exports = {
  ENVIRONMENT,
  listLogFiles,
  LmStudioFileParser,
  defaultLmStudioHome,
};
