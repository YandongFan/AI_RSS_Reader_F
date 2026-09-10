import { Notice, TFile, normalizePath, setIcon, type App, type MarkdownView } from 'obsidian';
import { MsEdgeTTS, OUTPUT_FORMAT, type Voice } from 'msedge-tts';
import type { AiRssSettings } from './types';
import { EDGE_TTS_VOICE_OPTIONS, edgeTtsVoiceLabel } from './edge-tts-voices';
export { EDGE_TTS_DEFAULT_VOICE, EDGE_TTS_VOICE_OPTIONS } from './edge-tts-voices';

export interface EdgeTtsPlaybackSettings {
  voice: string;
  rate: number;
  pitch: number;
  volume: number;
}

type EdgeTtsFormat = 'webm' | 'mp3';

export interface MarkdownTtsHost {
  app: App;
  settings: () => AiRssSettings;
  saveSettings: () => Promise<void>;
  position: (path: string) => number;
  savePosition: (path: string, index: number) => Promise<void>;
}

export class EdgeTtsService {
  private active?: MsEdgeTTS;
  private voices?: Promise<Voice[]>;

  async synthesize(text: string, options: EdgeTtsPlaybackSettings, format: EdgeTtsFormat = 'webm'): Promise<Blob> {
    this.cancel();
    const tts = new MsEdgeTTS();
    this.active = tts;
    try {
      const outputFormat = format === 'mp3'
        ? OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3
        : OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS;
      await tts.setMetadata(options.voice, outputFormat);
      const { audioStream } = tts.toStream(escapeXml(text), {
        rate: signed(options.rate, '%'),
        pitch: signed(options.pitch, 'Hz'),
        volume: signed(options.volume, '%'),
      });
      const chunks = await streamChunks(audioStream);
      const parts = chunks.map(chunk => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer);
      return new Blob(parts, { type: format === 'mp3' ? 'audio/mpeg' : 'audio/webm; codecs=opus' });
    } finally {
      tts.close();
      if (this.active === tts) this.active = undefined;
    }
  }

  async getVoices(): Promise<Voice[]> {
    if (!this.voices) {
      this.voices = (async () => {
        const tts = new MsEdgeTTS();
        try { return await tts.getVoices(); }
        finally { tts.close(); }
      })().catch(error => {
        this.voices = undefined;
        throw error;
      });
    }
    return this.voices;
  }

  cancel(): void {
    this.active?.close();
    this.active = undefined;
  }
}

export class MarkdownTtsPlayer {
  private readonly playbackTts = new EdgeTtsService();
  private readonly exportTts = new EdgeTtsService();
  private root?: HTMLElement;
  private file?: TFile;
  private segments: string[] = [];
  private index = 0;
  private audio?: HTMLAudioElement;
  private objectUrl?: string;
  private generation = 0;
  private statusEl?: HTMLElement;
  private currentEl?: HTMLElement;
  private playButton?: HTMLButtonElement;
  private rateInput?: HTMLInputElement;
  private rateLabel?: HTMLElement;
  private volumeInput?: HTMLInputElement;
  private volumeLabel?: HTMLElement;
  private voiceSelect?: HTMLSelectElement;
  private exporting = false;
  private mountVersion = 0;

  constructor(private readonly host: MarkdownTtsHost) {}

  async attach(view: MarkdownView): Promise<void> {
    const version = ++this.mountVersion;
    const file = view.file;
    if (!shouldShowMarkdownTts(view) || !(file instanceof TFile)) {
      this.clearMounted(view.containerEl.ownerDocument);
      return;
    }
    const viewContent = view.containerEl.querySelector<HTMLElement>('.view-content');
    if (!viewContent) return;
    if (this.file?.path === file.path && this.root?.isConnected && this.root.parentElement === viewContent) return;

    const markdown = await this.host.app.vault.cachedRead(file);
    if (version !== this.mountVersion || !shouldShowMarkdownTts(view) || view.file?.path !== file.path) return;

    this.clearMounted(view.containerEl.ownerDocument);
    this.file = file;
    this.segments = markdownToSpeechSegments(markdown);
    this.index = Math.min(Math.max(0, this.host.position(file.path)), Math.max(0, this.segments.length - 1));
    this.root = document.createElement('div');
    this.root.className = 'ai-rss-markdown-tts';
    viewContent.prepend(this.root);
    this.renderControls();
    void this.loadVoiceOptions();
  }

  detach(): void {
    this.mountVersion += 1;
    this.clearMounted();
  }

  private clearMounted(ownerDocument = this.root?.ownerDocument): void {
    this.stop();
    ownerDocument?.querySelectorAll('.ai-rss-markdown-tts').forEach(element => element.remove());
    this.root?.remove();
    this.root = undefined;
    this.file = undefined;
    this.segments = [];
  }

  dispose(): void {
    this.detach();
    this.exportTts.cancel();
  }

  async play(): Promise<void> {
    await this.playOrPause();
  }

  async exportMp3(file = this.file): Promise<TFile | undefined> {
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md' || this.exporting) return undefined;
    const segments = markdownToSpeechSegments(await this.host.app.vault.cachedRead(file));
    if (segments.length === 0) {
      new Notice('当前 Markdown 中没有可朗读的正文');
      return undefined;
    }

    this.exporting = true;
    this.stop();
    const notice = new Notice(`正在导出 MP3：0/${segments.length}…`, 0);
    try {
      const settings = this.playbackSettings();
      const parts: ArrayBuffer[] = [];
      for (let index = 0; index < segments.length; index += 1) {
        notice.setMessage(`正在导出 MP3：${index + 1}/${segments.length}…`);
        parts.push(await (await this.exportTts.synthesize(segments[index], settings, 'mp3')).arrayBuffer());
      }
      const path = markdownMp3Path(file);
      const bytes = await new Blob(parts, { type: 'audio/mpeg' }).arrayBuffer();
      const existing = this.host.app.vault.getFileByPath(path);
      const saved = existing
        ? (await this.host.app.vault.modifyBinary(existing, bytes), existing)
        : await this.host.app.vault.createBinary(path, bytes);
      notice.hide();
      new Notice(`MP3 已保存：${path}`, 8000);
      return saved;
    } catch (error) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Edge TTS 导出失败：${message}`, 12000);
      return undefined;
    } finally {
      this.exporting = false;
    }
  }

  private renderControls(): void {
    if (!this.root) return;
    const transport = this.root.createDiv({ cls: 'ai-rss-markdown-tts-transport' });
    transport.createSpan({ text: 'Edge TTS', cls: 'ai-rss-markdown-tts-title' });
    this.addIconButton(transport, 'skip-back', '上一段', () => void this.move(-1));
    this.playButton = this.addIconButton(transport, 'play', '播放／暂停', () => void this.playOrPause());
    this.addIconButton(transport, 'skip-forward', '下一段', () => void this.move(1));
    this.addIconButton(transport, 'square', '停止', () => this.stop());
    this.addIconButton(transport, 'download', '保存为 MP3', () => void this.exportMp3());
    this.statusEl = transport.createSpan({ cls: 'ai-rss-markdown-tts-status' });

    const options = this.root.createDiv({ cls: 'ai-rss-markdown-tts-options' });
    this.voiceSelect = options.createEl('select', { attr: { 'aria-label': 'Edge TTS 声音' } });
    this.addKnownVoiceOptions();
    this.voiceSelect.value = this.host.settings().edgeTtsVoice;
    this.voiceSelect.addEventListener('change', () => void this.changeVoice());

    options.createSpan({ text: '语速' });
    this.rateInput = options.createEl('input', { type: 'range', attr: { min: '-80', max: '200', step: '5', 'aria-label': '语速' } });
    this.rateInput.value = String(this.host.settings().edgeTtsRate);
    this.rateLabel = options.createSpan({ cls: 'ai-rss-markdown-tts-value' });
    this.rateInput.addEventListener('input', () => this.updateOptionLabels());
    this.rateInput.addEventListener('change', () => void this.changeRate());

    options.createSpan({ text: '音量' });
    this.volumeInput = options.createEl('input', { type: 'range', attr: { min: '-100', max: '100', step: '5', 'aria-label': '音量' } });
    this.volumeInput.value = String(this.host.settings().edgeTtsVolume);
    this.volumeLabel = options.createSpan({ cls: 'ai-rss-markdown-tts-value' });
    this.volumeInput.addEventListener('input', () => { this.updateOptionLabels(); this.applyLiveVolume(); });
    this.volumeInput.addEventListener('change', () => void this.changeVolume());

    this.currentEl = this.root.createDiv({ cls: 'ai-rss-markdown-tts-current' });
    this.updateOptionLabels();
    this.renderCurrent();
  }

  private addIconButton(container: HTMLElement, icon: string, label: string, click: () => void): HTMLButtonElement {
    const button = container.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label, title: label } });
    setIcon(button, icon);
    button.addEventListener('click', click);
    return button;
  }

  private async playOrPause(): Promise<void> {
    if (this.segments.length === 0) {
      new Notice('当前 Markdown 中没有可朗读的正文');
      return;
    }
    if (this.audio && !this.audio.ended) {
      if (this.audio.paused) {
        await this.audio.play();
        this.setPlayIcon('pause');
        this.setStatus(`正在播放 ${this.index + 1}/${this.segments.length}`);
      } else {
        this.audio.pause();
        this.setPlayIcon('play');
        this.setStatus(`已暂停 ${this.index + 1}/${this.segments.length}`);
      }
      return;
    }
    await this.synthesizeAndPlay();
  }

  private async synthesizeAndPlay(): Promise<void> {
    const token = ++this.generation;
    this.releaseAudio();
    this.setStatus(`正在合成 ${this.index + 1}/${this.segments.length}…`);
    if (this.playButton) this.playButton.disabled = true;
    try {
      const blob = await this.playbackTts.synthesize(this.segments[this.index], this.playbackSettings());
      if (token !== this.generation) return;
      this.objectUrl = URL.createObjectURL(blob);
      this.audio = new Audio(this.objectUrl);
      this.applyLiveVolume();
      this.audio.addEventListener('ended', () => void this.afterEnded(token));
      await this.audio.play();
      this.setStatus(`正在播放 ${this.index + 1}/${this.segments.length}`);
      this.setPlayIcon('pause');
      await this.saveCurrentPosition();
    } catch (error) {
      if (token === this.generation) {
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus(`播放失败：${message}`);
        new Notice(`Edge TTS 播放失败：${message}`, 10000);
      }
    } finally {
      if (this.playButton) this.playButton.disabled = false;
    }
  }

  private async afterEnded(token: number): Promise<void> {
    if (token !== this.generation) return;
    if (this.index >= this.segments.length - 1) {
      this.setStatus('播放完成');
      this.setPlayIcon('rotate-ccw');
      return;
    }
    this.index += 1;
    this.renderCurrent();
    await this.synthesizeAndPlay();
  }

  private async move(delta: number): Promise<void> {
    if (this.segments.length === 0) return;
    const wasPlaying = Boolean(this.audio && !this.audio.paused && !this.audio.ended);
    this.interruptAudio();
    this.index = Math.min(this.segments.length - 1, Math.max(0, this.index + delta));
    this.renderCurrent();
    await this.saveCurrentPosition();
    if (wasPlaying) await this.synthesizeAndPlay();
  }

  private stop(): void {
    this.interruptAudio();
    if (this.segments.length > 0) this.setStatus(`已停止 · ${this.index + 1}/${this.segments.length}`);
    this.setPlayIcon('play');
  }

  private interruptAudio(): void {
    this.generation += 1;
    this.playbackTts.cancel();
    this.releaseAudio();
  }

  private releaseAudio(): void {
    this.audio?.pause();
    this.audio = undefined;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }

  private renderCurrent(): void {
    this.setStatus(this.segments.length > 0 ? `${this.index + 1}/${this.segments.length}` : '没有可朗读内容');
    this.currentEl?.setText(this.segments[this.index] ?? '');
  }

  private setStatus(value: string): void { this.statusEl?.setText(value); }

  private setPlayIcon(icon: string): void {
    if (this.playButton) setIcon(this.playButton, icon);
  }

  private playbackSettings(): EdgeTtsPlaybackSettings {
    const settings = this.host.settings();
    return {
      voice: this.voiceSelect?.value || settings.edgeTtsVoice,
      rate: numberValue(this.rateInput, settings.edgeTtsRate),
      pitch: settings.edgeTtsPitch,
      volume: numberValue(this.volumeInput, settings.edgeTtsVolume),
    };
  }

  private updateOptionLabels(): void {
    if (this.rateLabel) this.rateLabel.setText(signed(numberValue(this.rateInput, 0), '%'));
    if (this.volumeLabel) this.volumeLabel.setText(signed(numberValue(this.volumeInput, 0), '%'));
  }

  private applyLiveVolume(): void {
    if (this.audio) this.audio.volume = Math.min(1, Math.max(0, (numberValue(this.volumeInput, 0) + 100) / 100));
  }

  private async changeVoice(): Promise<void> {
    const value = this.voiceSelect?.value;
    if (!value) return;
    this.host.settings().edgeTtsVoice = value;
    await this.host.saveSettings();
    await this.restartIfPlaying();
  }

  private async changeRate(): Promise<void> {
    this.host.settings().edgeTtsRate = numberValue(this.rateInput, 0);
    await this.host.saveSettings();
    await this.restartIfPlaying();
  }

  private async changeVolume(): Promise<void> {
    this.host.settings().edgeTtsVolume = numberValue(this.volumeInput, 0);
    await this.host.saveSettings();
  }

  private async restartIfPlaying(): Promise<void> {
    const wasPlaying = Boolean(this.audio && !this.audio.paused && !this.audio.ended);
    if (!wasPlaying) return;
    this.interruptAudio();
    await this.synthesizeAndPlay();
  }

  private async saveCurrentPosition(): Promise<void> {
    if (this.file) await this.host.savePosition(this.file.path, this.index);
  }

  private addKnownVoiceOptions(): void {
    if (!this.voiceSelect) return;
    const current = this.host.settings().edgeTtsVoice;
    if (current && !EDGE_TTS_VOICE_OPTIONS.some(option => option.value === current)) {
      this.voiceSelect.createEl('option', { value: current, text: `【已有自定义】${current}` });
    }
    for (const option of EDGE_TTS_VOICE_OPTIONS) {
      this.voiceSelect.createEl('option', { value: option.value, text: edgeTtsVoiceLabel(option) });
    }
  }

  private async loadVoiceOptions(): Promise<void> {
    try {
      const voices = await this.playbackTts.getVoices();
      const select = this.voiceSelect;
      if (!select?.isConnected) return;
      const current = select.value;
      const preferredLocales = new Set(['zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'en-GB']);
      for (const voice of voices.filter(item => preferredLocales.has(item.Locale)).sort((a, b) => a.Locale.localeCompare(b.Locale) || a.ShortName.localeCompare(b.ShortName))) {
        if (Array.from(select.options).some(option => option.value === voice.ShortName)) continue;
        const gender = voice.Gender === 'Female' ? '女' : voice.Gender === 'Male' ? '男' : voice.Gender;
        select.createEl('option', { value: voice.ShortName, text: `【在线】${voice.FriendlyName || voice.ShortName}（${gender}）· ${voice.Locale}` });
      }
      select.value = current;
    } catch {
      // The built-in choices remain available when the online voice list cannot be fetched.
    }
  }
}

export function shouldShowMarkdownTts(view: Pick<MarkdownView, 'file' | 'getMode'>): boolean {
  return view.getMode() === 'preview' && view.file?.extension.toLowerCase() === 'md';
}

export function markdownMp3Path(file: Pick<TFile, 'basename' | 'parent'>): string {
  const folder = file.parent?.path && file.parent.path !== '/' ? `${file.parent.path}/` : '';
  return normalizePath(`${folder}${file.basename}-EdgeTTS.mp3`);
}

export function markdownToSpeechSegments(markdown: string, maximum = 700): string[] {
  const cleaned = markdown
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\$\$[\s\S]*?\$\$/g, '')
    .replace(/\$[^$\n]+\$/g, '')
    .replace(/\\\[[\s\S]*?\\\]/g, '')
    .replace(/\\\([^\n]*?\\\)/g, '')
    .replace(/!\[\[[^\]]+\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, '')
    .replace(/^\s*>\s*\[![^\]]+\].*$/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  const output: string[] = [];
  for (const paragraph of cleaned.split(/\n\s*\n+/).map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    if (paragraph.length <= maximum) {
      output.push(paragraph);
      continue;
    }
    let current = '';
    for (const sentence of paragraph.split(/(?<=[。！？!?；;])\s*/).filter(Boolean)) {
      if (current && current.length + sentence.length > maximum) {
        output.push(current.trim());
        current = '';
      }
      if (sentence.length > maximum) {
        if (current) output.push(current.trim());
        for (let index = 0; index < sentence.length; index += maximum) output.push(sentence.slice(index, index + maximum));
        current = '';
      } else current += sentence;
    }
    if (current.trim()) output.push(current.trim());
  }
  return output;
}

async function streamChunks(audioStream: NodeJS.ReadableStream): Promise<Uint8Array[]> {
  return new Promise<Uint8Array[]>((resolve, reject) => {
    const output: Uint8Array[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      output.length > 0 ? resolve(output) : reject(new Error('Edge TTS 没有返回音频'));
    };
    audioStream.on('data', (chunk: Buffer | Uint8Array) => output.push(new Uint8Array(chunk)));
    audioStream.on('end', finish);
    audioStream.on('close', finish);
    audioStream.on('error', reject);
  });
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character] ?? character));
}

function signed(value: number, unit: string): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe >= 0 ? '+' : ''}${safe}${unit}`;
}

function numberValue(input: HTMLInputElement | undefined, fallback: number): number {
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}
