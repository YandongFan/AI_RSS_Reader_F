import { App, Modal, Notice, PluginSettingTab, Setting, TFile } from 'obsidian';
import type AiRssReaderPlugin from './main';
import { makeId } from './main';
import { DEFAULT_SETTINGS } from './defaults';
import { SUPPLEMENTARY_FILE_TYPES } from './attachments';
import { setArticleRead } from './retention';
import { pickJsonFile } from './json-import';
import type { FeedHealthResult } from './feed-health';
import { loginCodexAccount, logoutCodexAccount, readCodexAccount, readCodexModels, type CodexAccountStatus, type CodexModelOption } from './codex-app-server';
import type { NotePropertyTemplate, NotePropertyType, ProviderKind, ResearchProfile, RssArticle } from './types';
import { DEFAULT_PROVIDER_CONFIGS, switchProvider } from './provider-settings';
import { AUDIO_TUTOR_RULES_FOLDER, ensureAudioTutorPrompts } from './audio-tutor-prompts';
import { EDGE_TTS_DEFAULT_VOICE, EDGE_TTS_VOICE_OPTIONS, edgeTtsVoiceLabel } from './edge-tts-voices';

const PROVIDERS: Record<ProviderKind, { label: string }> = {
  openai: { label: 'OpenAI' },
  codex: { label: 'ChatGPT Plus/Pro (Codex)' },
  deepseek: { label: 'DeepSeek' },
  gemini: { label: 'Google Gemini' },
  ollama: { label: 'Ollama（本地）' },
  custom: { label: 'OpenAI 兼容接口' },
};

async function openExternal(url: string): Promise<void> {
  const electron = require('electron') as { shell?: { openExternal(value: string): Promise<void> } };
  if (!electron.shell?.openExternal) throw new Error('当前 Obsidian 环境无法打开外部登录页面');
  await electron.shell.openExternal(url);
}

function codexAccountDescription(status?: CodexAccountStatus): string {
  if (!status) return '状态尚未检查。登录由本机 Codex 管理，插件不会保存 OAuth 令牌。';
  if (!status.signedIn) return '尚未登录 ChatGPT。';
  if (status.authType !== 'chatgpt') return 'Codex 当前使用的不是 ChatGPT 订阅登录，请点击“登录 ChatGPT”切换。';
  return `已登录 ChatGPT${status.planType ? `（${status.planType}）` : ''}。`;
}

export class AiRssSettingTab extends PluginSettingTab {
  private codexAccount?: CodexAccountStatus;
  private codexModels?: CodexModelOption[];
  private codexModelsLoading = false;
  private codexModelsError?: string;

  constructor(app: App, private readonly plugin: AiRssReaderPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.state.settings;
    containerEl.empty();
    containerEl.addClass('ai-rss-settings');
    containerEl.createEl('h1', { text: 'AI RSS Reader' });
    containerEl.createEl('p', { text: '设置 RSS 来源、研究方向和用于筛选文章的模型。普通配置保存在当前仓库；Codex OAuth 令牌由本机 Codex 管理。', cls: 'setting-item-description' });

    containerEl.createEl('h2', { text: 'AI 模型' });
    new Setting(containerEl)
      .setName('服务商')
      .setDesc('支持 ChatGPT 订阅、云端 API、本地 Ollama 和 OpenAI 兼容服务。')
      .addDropdown((dropdown) => {
        Object.entries(PROVIDERS).forEach(([value, item]) => dropdown.addOption(value, item.label));
        dropdown.setValue(settings.provider.kind).onChange(async (value) => {
          const kind = value as ProviderKind;
          switchProvider(settings, kind);
          this.codexAccount = undefined;
          this.codexModels = undefined;
          this.codexModelsError = undefined;
          await this.plugin.saveState();
          this.display();
        });
      });
    if (settings.provider.kind === 'codex') {
      new Setting(containerEl).setName('Codex 命令').setDesc('默认自动查找 PATH 或 Windows Codex Desktop；仍找不到时可填写 codex.exe 的完整路径。').addText((input) => input
        .setPlaceholder('codex')
        .setValue(settings.provider.codexExecutable)
        .onChange(async (value) => {
          settings.provider.codexExecutable = value.trim() || 'codex';
          this.codexModels = undefined;
          this.codexModelsError = undefined;
          await this.plugin.saveState();
        }));
      new Setting(containerEl)
        .setName('ChatGPT 订阅登录')
        .setDesc(codexAccountDescription(this.codexAccount))
        .addButton((button) => button.setButtonText('登录 ChatGPT').setCta().onClick(async () => {
          button.setDisabled(true).setButtonText('等待登录…');
          try {
            this.codexAccount = await loginCodexAccount(settings.provider.codexExecutable, openExternal);
            this.codexModels = undefined;
            new Notice('ChatGPT 登录成功');
          } catch (error) {
            new Notice(`ChatGPT 登录失败：${error instanceof Error ? error.message : String(error)}`);
          } finally {
            this.display();
          }
        }))
        .addButton((button) => button.setButtonText('检查状态').onClick(async () => {
          button.setDisabled(true).setButtonText('检查中…');
          try {
            this.codexAccount = await readCodexAccount(settings.provider.codexExecutable);
          } catch (error) {
            new Notice(`Codex 状态检查失败：${error instanceof Error ? error.message : String(error)}`);
          } finally {
            this.display();
          }
        }))
        .addButton((button) => button.setButtonText('退出本机 Codex').setWarning().onClick(async () => {
          if (!window.confirm('这会退出本机共享的 Codex 登录，Codex CLI 等客户端也可能需要重新登录。是否继续？')) return;
          button.setDisabled(true);
          try {
            await logoutCodexAccount(settings.provider.codexExecutable);
            this.codexAccount = { signedIn: false };
            new Notice('已退出本机 Codex 登录');
          } catch (error) {
            new Notice(`退出 Codex 登录失败：${error instanceof Error ? error.message : String(error)}`);
          } finally {
            this.display();
          }
        }));
      const modelDescription = this.codexModelsError
        ? `读取模型失败：${this.codexModelsError}`
        : '模型列表由当前 ChatGPT 账户的 Codex 提供；选择“跟随 Codex 默认模型”可自动跟随推荐模型。';
      new Setting(containerEl).setName('模型').setDesc(modelDescription)
        .addDropdown((dropdown) => {
          dropdown.addOption('', this.codexModelsLoading ? '正在读取模型…' : '跟随 Codex 默认模型');
          for (const item of this.codexModels || []) {
            dropdown.addOption(item.model, `${item.displayName}${item.isDefault ? '（默认）' : ''}`);
          }
          dropdown.setValue(settings.provider.model).onChange(async (value) => {
            settings.provider.model = value;
            await this.plugin.saveState();
          });
          dropdown.selectEl.disabled = this.codexModelsLoading;
        })
        .addExtraButton((button) => button.setIcon('refresh-cw').setTooltip('刷新可用模型').onClick(() => {
          void this.loadCodexModels(true);
        }));
      if (!this.codexModels && !this.codexModelsLoading && !this.codexModelsError) void this.loadCodexModels(false);
    } else {
      new Setting(containerEl).setName('API Key').setDesc(settings.provider.kind === 'ollama' ? 'Ollama 通常不需要 API Key。' : '密钥会保存在 Obsidian 插件数据中。').addText((input) => {
        input.setPlaceholder('sk-…').setValue(settings.provider.apiKey).onChange(async (value) => { settings.provider.apiKey = value.trim(); await this.plugin.saveState(); });
        input.inputEl.type = 'password';
      });
      new Setting(containerEl).setName('模型').addText((input) => input.setValue(settings.provider.model).onChange(async (value) => { settings.provider.model = value.trim(); await this.plugin.saveState(); }));
      new Setting(containerEl).setName('API 地址').setDesc('OpenAI 兼容接口可填写服务根地址或以 /v1 结尾的地址。').addText((input) => input.setValue(settings.provider.baseUrl).onChange(async (value) => { settings.provider.baseUrl = value.trim(); await this.plugin.saveState(); }));
    }

    containerEl.createEl('h2', { text: 'RSS 来源' });
    settings.feeds.forEach((feed) => {
      const row = new Setting(containerEl).setName(feed.name).setDesc(feed.url).addToggle((toggle) => toggle.setValue(feed.enabled).onChange(async (value) => { feed.enabled = value; await this.plugin.saveState(); }));
      row.addExtraButton((button) => button.setIcon('pencil').setTooltip('编辑').onClick(() => new FeedModal(this.plugin, feed.id, () => this.display()).open()));
      row.addExtraButton((button) => button.setIcon('trash-2').setTooltip('删除').onClick(async () => { settings.feeds = settings.feeds.filter((item) => item.id !== feed.id); await this.plugin.saveState(); this.display(); }));
    });
    new Setting(containerEl)
      .addButton((button) => button.setButtonText('添加 RSS 源').setCta().onClick(() => new FeedModal(this.plugin, undefined, () => this.display()).open()))
      .addButton((button) => button.setButtonText('检测所有 RSS 源').onClick(async () => {
        if (settings.feeds.length === 0) { new Notice('还没有可检测的 RSS 源'); return; }
        button.setDisabled(true).setButtonText('检测中…');
        try {
          const results = await this.plugin.checkAndExportFeeds();
          new FeedHealthModal(this.app, results).open();
        } catch (error) { new Notice(`RSS 检测或文件写入失败：${String(error)}`); } finally {
          button.setDisabled(false).setButtonText('检测所有 RSS 源');
        }
      }));

    new Setting(containerEl).setName('本地 RSS 源文件').setDesc('检测完成后保存到 F 插件目录根部的 rss-sources.json；导入按链接合并，不重复添加。').addButton(button => button.setButtonText('从本地导入 RSS 链接').onClick(async () => { try { await this.plugin.importLocalFeeds(); this.display(); } catch (error) { new Notice(`导入失败：${String(error)}`); } }));

    containerEl.createEl('h2', { text: '研究方向' });
    settings.profiles.forEach((profile) => {
      const row = new Setting(containerEl).setName(profile.name).setDesc(profile.description).addToggle((toggle) => toggle.setValue(profile.enabled).onChange(async (value) => { profile.enabled = value; await this.plugin.saveState(); }));
      row.addExtraButton((button) => button.setIcon('pencil').setTooltip('编辑').onClick(() => new ProfileModal(this.plugin, profile.id, () => this.display()).open()));
      row.addExtraButton((button) => button.setIcon('trash-2').setTooltip('删除').onClick(async () => { settings.profiles = settings.profiles.filter((item) => item.id !== profile.id); await this.plugin.saveState(); this.display(); }));
    });
    new Setting(containerEl).addButton((button) => button.setButtonText('添加研究方向').setCta().onClick(() => new ProfileModal(this.plugin, undefined, () => this.display()).open()));

    containerEl.createEl('h2', { text: '处理与输出' });
    new Setting(containerEl).setName('关键词预筛').setDesc('先按研究方向关键词过滤，再调用模型；可显著减少 API 消耗。').addToggle((toggle) => toggle.setValue(settings.keywordFilter).onChange(async (value) => { settings.keywordFilter = value; await this.plugin.saveState(); }));
    /* Exploration always retains unselected papers. */
    new Setting(containerEl).setName('每个源最多文章数').addText((input) => { input.inputEl.type = 'number'; input.setValue(String(settings.maxItemsPerFeed)).onChange(async (value) => { settings.maxItemsPerFeed = clamp(value, 1, 500, 50); await this.plugin.saveState(); }); });
    new Setting(containerEl).setName('每批 AI 分析数').setDesc('上下文较小的模型建议设置为 3–5。').addText((input) => { input.inputEl.type = 'number'; input.setValue(String(settings.batchSize)).onChange(async (value) => { settings.batchSize = clamp(value, 1, 50, 8); await this.plugin.saveState(); }); });
    new Setting(containerEl).setName('隐藏条目保留天数').setDesc('隐藏超过此天数后转为已过期，可恢复；0 表示不自动过期。感兴趣和归档永久保留。').addText((input) => {
      input.inputEl.type = 'number'; input.inputEl.min = '0'; input.inputEl.max = '36500'; input.inputEl.step = '1';
      input.setValue(String(settings.readRetentionDays));
      input.inputEl.addEventListener('change', () => void (async () => { settings.readRetentionDays = clamp(input.getValue(), 0, 36500, 30); input.setValue(String(settings.readRetentionDays)); await this.plugin.saveState(); this.plugin.getView()?.render(); })());
    });
    new Setting(containerEl).setName('未读条目保留天数').setDesc('从 RSS 抓取或恢复未读时间开始计算，超时转为已过期；0 表示不自动过期。不会删除文献文件。').addText((input) => {
      input.inputEl.type = 'number'; input.inputEl.min = '0'; input.inputEl.max = '36500'; input.inputEl.step = '1';
      input.setValue(String(settings.unreadRetentionDays));
      input.inputEl.addEventListener('change', () => void (async () => { settings.unreadRetentionDays = clamp(input.getValue(), 0, 36500, 90); input.setValue(String(settings.unreadRetentionDays)); await this.plugin.saveState(); this.plugin.getView()?.render(); })());
    });
    new Setting(containerEl).setName('笔记输出文件夹').setDesc('保存结构：输出文件夹 / RSS 名称 / 文献文件夹。已有文件不会自动迁移。').addText((input) => input.setValue(settings.outputFolder).onChange(async (value) => { settings.outputFolder = value.trim() || 'AI RSS Reader'; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('文献文件夹命名模板').setDesc('变量：{author}、{authors}、{year}、{journal}、{title}、{citekey}、{doi}').addText((input) => input.setPlaceholder('{author} - {year} - {title}').setValue(settings.literatureFolderTemplate).onChange(async (value) => { settings.literatureFolderTemplate = value.trim() || '{author} - {year} - {title}'; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('单篇保存后打开笔记').setDesc('单篇文献抓取成功后，自动打开生成的 Markdown 笔记；不影响批量保存。').addToggle((toggle) => toggle.setValue(settings.openNoteAfterSingleSave).onChange(async (value) => { settings.openNoteAfterSingleSave = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('批量自动抓取检查间隔（秒）').setDesc('批量保存时检查论文页面是否可抓取的间隔，范围 0.5–30 秒。').addText((input) => {
      input.inputEl.type = 'number'; input.inputEl.min = '0.5'; input.inputEl.max = '30'; input.inputEl.step = '0.1';
      input.setValue(String(settings.batchCaptureIntervalSeconds)).onChange(async (value) => {
        settings.batchCaptureIntervalSeconds = clampDecimal(value, 0.5, 30, 1.5);
        await this.plugin.saveState();
      });
    });
    new Setting(containerEl).setName('Markdown 与 YAML 模板').setDesc('设置笔记文件名、正文格式和 YAML Properties；兼容导入 Web Clipper 模板的核心字段。')
      .addButton((button) => button.setButtonText('编辑模板').setCta().onClick(() => new NoteTemplateModal(this.plugin, () => this.display()).open()))
      .addButton((button) => button.setButtonText('导入 JSON').onClick(() => this.pickJson((value) => this.importClipperTemplate(value))));
    new Setting(containerEl).setName('使用 Defuddle 提取正文').setDesc('保存笔记时抓取文献页面，并将主要内容转换为 Markdown。').addToggle((toggle) => toggle.setValue(settings.extractFullText).onChange(async (value) => { settings.extractFullText = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('保存 BibTeX').setDesc('优先从 DOI 或出版社下载；没有可用记录时根据网页元数据生成。').addToggle((toggle) => toggle.setValue(settings.downloadBibtex).onChange(async (value) => { settings.downloadBibtex = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('尝试下载 PDF').setDesc('只下载文献页面公开提供或当前机构账号有权访问的 PDF。').addToggle((toggle) => toggle.setValue(settings.downloadPdf).onChange(async (value) => { settings.downloadPdf = value; await this.plugin.saveState(); }));

    new Setting(containerEl).setName('下载补充材料').setDesc('识别 Supporting Information、Supplementary/Supplemental Material、Additional Files、Source Data 等附件，支持 PDF、ZIP、Word、表格等格式。').addToggle((toggle) => toggle.setValue(settings.downloadSupplementary).onChange(async (value) => { settings.downloadSupplementary = value; await this.plugin.saveState(); }));
    const fileTypes = new Setting(containerEl).setName('补充材料文件类型').setDesc('勾选允许下载的格式；全部取消则跳过所有补充材料。仅影响补充材料。');
    fileTypes.settingEl.addClass('ai-rss-file-types');
    const choices = fileTypes.controlEl.createDiv({ cls: 'ai-rss-file-type-choices' });
    for (const extension of SUPPLEMENTARY_FILE_TYPES) {
      const label = choices.createEl('label', { cls: 'ai-rss-file-type-choice' });
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checkbox.checked = settings.supplementaryFileTypes.includes(extension);
      label.createSpan({ text: extension.toUpperCase() });
      checkbox.addEventListener('change', () => {
        settings.supplementaryFileTypes = checkbox.checked
          ? [...new Set([...settings.supplementaryFileTypes, extension])]
          : settings.supplementaryFileTypes.filter(type => type !== extension);
        void this.plugin.saveState();
      });
    }
    new Setting(containerEl).setName('下载同行评审文件').setDesc('识别 Peer Review、Review History、Reviewer/Referee Reports、Decision Letter、Author Response 等公开文件。').addToggle((toggle) => toggle.setValue(settings.downloadPeerReview).onChange(async (value) => { settings.downloadPeerReview = value; await this.plugin.saveState(); }));
    const peerReviewTypes = new Setting(containerEl).setName('同行评审文件类型').setDesc('勾选允许下载的格式；全部取消则跳过所有同行评审文件。仅影响同行评审附件。');
    peerReviewTypes.settingEl.addClass('ai-rss-file-types');
    const peerReviewChoices = peerReviewTypes.controlEl.createDiv({ cls: 'ai-rss-file-type-choices' });
    for (const extension of SUPPLEMENTARY_FILE_TYPES) {
      const label = peerReviewChoices.createEl('label', { cls: 'ai-rss-file-type-choice' });
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checkbox.checked = settings.peerReviewFileTypes.includes(extension);
      label.createSpan({ text: extension.toUpperCase() });
      checkbox.addEventListener('change', () => {
        settings.peerReviewFileTypes = checkbox.checked
          ? [...new Set([...settings.peerReviewFileTypes, extension])]
          : settings.peerReviewFileTypes.filter(type => type !== extension);
        void this.plugin.saveState();
      });
    }

    containerEl.createEl('h2', { text: 'MinerU PDF 解析' });
    containerEl.createEl('p', {
      text: '这是独立于文献抓取流程的 PDF 转换功能。配置 Token 时使用标准 API 并下载完整 ZIP；留空时使用免登录轻量 Agent API（最多 10 MB、20 页，只返回 Markdown）。',
      cls: 'setting-item-description',
    });
    new Setting(containerEl).setName('MinerU API Token').setDesc('可选。Token 仅保存在当前 Obsidian 仓库的插件设置中；留空自动使用轻量 Agent API。').addText(input => {
      input.inputEl.type = 'password';
      input.setPlaceholder('留空使用轻量 API').setValue(settings.mineruToken).onChange(async value => { settings.mineruToken = value.trim(); await this.plugin.saveState(); });
    });
    new Setting(containerEl).setName('标准 API 模型').setDesc('VLM 适合复杂版式；Pipeline 资源更轻。仅配置 Token 时生效。').addDropdown(dropdown => dropdown
      .addOption('vlm', 'VLM（推荐）').addOption('pipeline', 'Pipeline')
      .setValue(settings.mineruModelVersion).onChange(async value => { settings.mineruModelVersion = value as 'vlm' | 'pipeline'; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('OCR 语言').setDesc('仅影响 OCR 识别，例如 en、ch、korean、japan。').addText(input => input
      .setPlaceholder('en').setValue(settings.mineruLanguage).onChange(async value => { settings.mineruLanguage = value.trim() || 'en'; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('强制 OCR').setDesc('扫描版 PDF 建议开启；可复制文字的普通论文通常保持关闭。').addToggle(toggle => toggle
      .setValue(settings.mineruOcr).onChange(async value => { settings.mineruOcr = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('识别表格').addToggle(toggle => toggle
      .setValue(settings.mineruEnableTable).onChange(async value => { settings.mineruEnableTable = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('识别公式').addToggle(toggle => toggle
      .setValue(settings.mineruEnableFormula).onChange(async value => { settings.mineruEnableFormula = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('保存 Markdown').setDesc('保存为 <PDF 名称>_MinerU.md；轻量 API 只支持这一项。').addToggle(toggle => toggle
      .setValue(settings.mineruSaveMarkdown).onChange(async value => { settings.mineruSaveMarkdown = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('保存内容列表 JSON').setDesc('标准 API ZIP 中的 content_list JSON。').addToggle(toggle => toggle
      .setValue(settings.mineruSaveContentListJson).onChange(async value => { settings.mineruSaveContentListJson = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('保存布局信息 JSON').setDesc('标准 API ZIP 中的 middle/layout JSON。').addToggle(toggle => toggle
      .setValue(settings.mineruSaveLayoutJson).onChange(async value => { settings.mineruSaveLayoutJson = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('保存模型推理 JSON').setDesc('标准 API ZIP 中的 model JSON，体积可能较大。').addToggle(toggle => toggle
      .setValue(settings.mineruSaveModelJson).onChange(async value => { settings.mineruSaveModelJson = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('保存解析图片').setDesc('按 Markdown 中的出现顺序转换到 Miner_U/Figures/<PDF 名称>_MinerU_1.jpg、_2.jpg……并同步改写 Markdown 图片链接。').addToggle(toggle => toggle
      .setValue(settings.mineruSaveImages).onChange(async value => { settings.mineruSaveImages = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('保存其他解析文件').setDesc('保存 ZIP 中除原 PDF、上述 JSON、Markdown 和图片以外的附加结果，并统一添加 PDF 名称前缀。').addToggle(toggle => toggle
      .setValue(settings.mineruSaveOtherFiles).onChange(async value => { settings.mineruSaveOtherFiles = value; await this.plugin.saveState(); }));

    containerEl.createEl('h2', { text: 'Theory Paper Audio Tutor' });
    containerEl.createEl('p', {
      text: '仅使用完整 MinerU Markdown、content-list、layout 和图片生成学习材料。Edge TTS 可在任意 Markdown 视图中在线朗读或导出 MP3；公式详解、理解检查和复习均保存为 Note。',
      cls: 'setting-item-description',
    });
    new Setting(containerEl).setName('讲解语言').addText(input => input
      .setValue(settings.audioTutorLanguage).onChange(async value => { settings.audioTutorLanguage = value.trim() || DEFAULT_SETTINGS.audioTutorLanguage; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('学习者背景').setDesc('会注入所有 Audio Tutor 提示词。').addTextArea(input => {
      input.setValue(settings.audioTutorLearnerBackground).onChange(async value => { settings.audioTutorLearnerBackground = value.trim() || DEFAULT_SETTINGS.audioTutorLearnerBackground; await this.plugin.saveState(); });
      input.inputEl.rows = 3;
    });
    new Setting(containerEl).setName('粗读目标时长（分钟）').setDesc('用于控制讲稿长度，范围 5–90 分钟。').addText(input => {
      input.inputEl.type = 'number'; input.inputEl.min = '5'; input.inputEl.max = '90'; input.inputEl.step = '1';
      input.setValue(String(settings.audioTutorTargetMinutes)).onChange(async value => { settings.audioTutorTargetMinutes = clamp(value, 5, 90, 25); await this.plugin.saveState(); });
    });
    new Setting(containerEl).setName('Edge TTS 语音').setDesc('优先提供中文、英文和中英混读声音；括号内标注男女。').addDropdown(dropdown => {
      EDGE_TTS_VOICE_OPTIONS.forEach(option => dropdown.addOption(option.value, edgeTtsVoiceLabel(option)));
      if (settings.edgeTtsVoice && !EDGE_TTS_VOICE_OPTIONS.some(option => option.value === settings.edgeTtsVoice)) {
        dropdown.addOption(settings.edgeTtsVoice, `【已有自定义】${settings.edgeTtsVoice}`);
      }
      dropdown.setValue(settings.edgeTtsVoice || EDGE_TTS_DEFAULT_VOICE).onChange(async value => {
        settings.edgeTtsVoice = value || EDGE_TTS_DEFAULT_VOICE;
        await this.plugin.saveState();
      });
    });
    new Setting(containerEl).setName('Edge TTS 语速（%）').setDesc('-80 至 200。').addText(input => {
      input.inputEl.type = 'number'; input.inputEl.min = '-80'; input.inputEl.max = '200'; input.inputEl.step = '5';
      input.setValue(String(settings.edgeTtsRate)).onChange(async value => { settings.edgeTtsRate = clamp(value, -80, 200, 0); await this.plugin.saveState(); });
    });
    new Setting(containerEl).setName('Edge TTS 音调（Hz）').setDesc('-100 至 100。').addText(input => {
      input.inputEl.type = 'number'; input.inputEl.min = '-100'; input.inputEl.max = '100'; input.inputEl.step = '5';
      input.setValue(String(settings.edgeTtsPitch)).onChange(async value => { settings.edgeTtsPitch = clamp(value, -100, 100, 0); await this.plugin.saveState(); });
    });
    new Setting(containerEl).setName('Edge TTS 音量变化（%）').setDesc('-100 至 100。').addText(input => {
      input.inputEl.type = 'number'; input.inputEl.min = '-100'; input.inputEl.max = '100'; input.inputEl.step = '5';
      input.setValue(String(settings.edgeTtsVolume)).onChange(async value => { settings.edgeTtsVolume = clamp(value, -100, 100, 0); await this.plugin.saveState(); });
    });
    new Setting(containerEl).setName('Audio Tutor 提示词').setDesc(`所有相关提示词位于 ${AUDIO_TUTOR_RULES_FOLDER}，已有文件不会被自动覆盖。`)
      .addButton(button => button.setButtonText('补充缺失文件').onClick(async () => {
        try { await ensureAudioTutorPrompts(this.app); new Notice('Audio Tutor 默认提示词已检查'); }
        catch (error) { new Notice(`提示词初始化失败：${String(error)}`); }
      }))
      .addButton(button => button.setButtonText('打开粗读提示词').setCta().onClick(async () => {
        try {
          await ensureAudioTutorPrompts(this.app);
          const file = this.app.vault.getAbstractFileByPath(`${AUDIO_TUTOR_RULES_FOLDER}/rough-reading.md`);
          if (!(file instanceof TFile)) throw new Error('rough-reading.md 不存在');
          await this.app.workspace.getLeaf('tab').openFile(file);
        } catch (error) { new Notice(`无法打开提示词：${String(error)}`); }
      }));

    containerEl.createEl('h2', { text: 'EZProxy 机构访问' });
    new Setting(containerEl).setName('启用 EZProxy').setDesc('抓取正文和 PDF 时通过配置的机构代理访问。').addToggle((toggle) => toggle.setValue(settings.ezProxyEnabled).onChange(async (value) => { settings.ezProxyEnabled = value; await this.plugin.saveState(); }));
    new Setting(containerEl).setName('EZProxy 地址模板').setDesc('$@ 会直接替换为原始文献地址，不进行 URL 编码。').addText((input) => input.setPlaceholder('https://example.idm.oclc.org/login?url=$@').setValue(settings.ezProxyPrefix).onChange(async (value) => { settings.ezProxyPrefix = value.trim(); settings.ezProxyCookieHeader = ''; settings.ezProxyLastAuthenticated = ''; await this.plugin.saveState(); }));
    const authDescription = settings.ezProxyLastAuthenticated
      ? `最近记录：${new Date(settings.ezProxyLastAuthenticated).toLocaleString('zh-CN')}。使用 Obsidian 网页浏览器中的机构代理会话。`
      : '在 Obsidian 网页浏览器标签中登录，看到文献页面后点击“完成登录”。请先启用核心插件“网页浏览器”。';
    new Setting(containerEl).setName('EZProxy 登录会话').setDesc(authDescription)
      .addButton((button) => button.setButtonText(settings.ezProxyLastAuthenticated ? '重新登录' : '登录').setCta().onClick(() => {
        void this.plugin.authenticateEzProxy().then(() => this.display()).catch((error) => new Notice(`EZProxy 登录失败：${String(error)}`));
      }))
      .addButton((button) => button.setButtonText('清除会话').setWarning().onClick(async () => {
        try { await this.plugin.clearEzProxySession(); this.display(); }
        catch (error) { new Notice(`清除会话失败：${String(error)}`); }
      }));

    containerEl.createEl('h2', { text: '从 Python 版迁移' });
    new Setting(containerEl).setName('导入 config.json').setDesc('导入 RSS 源、研究方向和当前模型配置。不会读取原文件，需手动选择。').addButton((button) => button.setButtonText('选择配置文件').onClick(() => this.pickJson((value) => this.importLegacyConfig(value))));
    new Setting(containerEl).setName('导入 research_profiles.json').setDesc('导入旧版研究方向名称和关键词描述。').addButton((button) => button.setButtonText('选择方向文件').onClick(() => this.pickJson((value) => this.importLegacyProfiles(value))));
    new Setting(containerEl).setName('导入 filtered_papers.json').setDesc('导入旧版已分析文章；大型文件可能需要一些时间。').addButton((button) => button.setButtonText('选择论文文件').onClick(() => this.pickJson((value) => this.importLegacyPapers(value))));
    new Setting(containerEl).setName('导入 read_status.json').setDesc('按文章链接恢复旧版已读状态。请在导入论文后执行。').addButton((button) => button.setButtonText('选择已读文件').onClick(() => this.pickJson((value) => this.importLegacyReadStatus(value))));
  }

  private pickJson(onJson: (value: unknown) => Promise<void>): void {
    pickJsonFile(this.containerEl, onJson, (error) => new Notice(`导入失败：${String(error)}`));
  }

  private async loadCodexModels(showNotice: boolean): Promise<void> {
    const provider = this.plugin.state.settings.provider;
    if (provider.kind !== 'codex' || this.codexModelsLoading) return;
    const executable = provider.codexExecutable;
    this.codexModelsLoading = true;
    this.codexModelsError = undefined;
    this.display();
    try {
      const models = await readCodexModels(executable);
      if (this.plugin.state.settings.provider.kind !== 'codex' || this.plugin.state.settings.provider.codexExecutable !== executable) return;
      this.codexModels = models;
      const configured = this.plugin.state.settings.provider.model.trim();
      const match = configured ? models.find((item) =>
        item.model.toLowerCase() === configured.toLowerCase()
        || item.id.toLowerCase() === configured.toLowerCase()
        || item.displayName.toLowerCase() === configured.toLowerCase()
      ) : undefined;
      if (configured && match?.model !== configured) {
        this.plugin.state.settings.provider.model = match?.model || '';
        await this.plugin.saveState();
        new Notice(match ? `Codex 模型已规范为 ${match.model}` : '原 Codex 模型不可用，已改为跟随默认模型');
      } else if (showNotice) {
        new Notice(`已读取 ${models.length} 个可用 Codex 模型`);
      }
    } catch (error) {
      this.codexModels = undefined;
      this.codexModelsError = error instanceof Error ? error.message : String(error);
      if (showNotice) new Notice(`读取 Codex 模型失败：${this.codexModelsError}`);
    } finally {
      this.codexModelsLoading = false;
      this.display();
    }
  }

  private async importLegacyConfig(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置文件格式不正确');
    const data = value as Record<string, unknown>;
    if (Array.isArray(data.rss_urls)) {
      this.plugin.state.settings.feeds = data.rss_urls.filter((item): item is string => typeof item === 'string').map((entry) => {
        const [url, label] = entry.split('|', 2).map((part) => part.trim());
        return { id: makeId('feed'), url, name: label || url, enabled: true };
      });
    }
    const providerName = typeof data.llm_provider === 'string' ? data.llm_provider.toLowerCase() : 'custom';
    const kind = (providerName in PROVIDERS ? providerName : 'custom') as ProviderKind;
    const providers = data.providers && typeof data.providers === 'object' ? data.providers as Record<string, unknown> : {};
    const selected = providers[providerName] && typeof providers[providerName] === 'object' ? providers[providerName] as Record<string, unknown> : {};
    this.plugin.state.settings.provider = {
      kind,
      apiKey: stringValue(selected.api_key) || stringValue(data.api_key),
      model: stringValue(selected.model) || stringValue(data.model) || DEFAULT_PROVIDER_CONFIGS[kind].model,
      baseUrl: stringValue(selected.api_base) || stringValue(data.api_base) || DEFAULT_PROVIDER_CONFIGS[kind].baseUrl,
      codexExecutable: 'codex',
    };
    if (typeof data.research_interests === 'string' && data.research_interests.trim()) {
      this.plugin.state.settings.profiles = [{ id: makeId('profile'), name: '默认研究方向', description: data.research_interests, enabled: true }];
    }
    await this.plugin.saveState();
    new Notice('旧版配置已导入');
    this.display();
  }

  private async importClipperTemplate(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模板文件格式不正确');
    const data = value as Record<string, unknown>;
    const noteNameFormat = stringValue(data.noteNameFormat).trim();
    const noteContentFormat = stringValue(data.noteContentFormat);
    const properties = normalizeNoteProperties(data.properties);
    if (!noteNameFormat || !noteContentFormat || properties.length === 0) throw new Error('模板缺少 noteNameFormat、noteContentFormat 或 properties');
    this.plugin.state.settings.noteNameFormat = noteNameFormat;
    this.plugin.state.settings.noteContentFormat = noteContentFormat;
    this.plugin.state.settings.noteProperties = properties;
    if (typeof data.path === 'string' && data.path.trim()) this.plugin.state.settings.outputFolder = data.path.trim();
    await this.plugin.saveState();
    new Notice(`已导入模板：${stringValue(data.name) || '未命名模板'}`);
    this.display();
  }

  private async importLegacyPapers(value: unknown): Promise<void> {
    if (!Array.isArray(value)) throw new Error('论文文件应为 JSON 数组');
    const existing = new Map(this.plugin.state.articles.map((article) => [article.link, article]));
    let added = 0;
    value.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') return;
      const item = raw as Record<string, unknown>;
      const link = stringValue(item.link);
      if (!link || existing.has(link)) return;
      const analysis = normalizeAnalysis(item.analysis);
      const article: RssArticle = {
        id: makeId(`legacy-${index}`), title: stringValue(item.title) || '无标题', link,
        summary: stringValue(item.full_abstract) || stringValue(item.summary), published: stringValue(item.published),
        source: stringValue(item.journal) || arrayStrings(item.sources)[0] || '旧版数据', fetchedAt: stringValue(item.crawled_at) || new Date().toISOString(),
        read: false, matchedProfiles: arrayStrings(item.matched_profiles), analysis,
      };
      existing.set(link, article);
      added += 1;
    });
    this.plugin.state.articles = [...existing.values()];
    this.plugin.state.seenLinks = [...new Set([...this.plugin.state.seenLinks, ...this.plugin.state.articles.map((article) => article.link)])];
    await this.plugin.saveState();
    this.plugin.getView()?.render();
    new Notice(`已导入 ${added} 篇旧版文章`);
  }

  private async importLegacyProfiles(value: unknown): Promise<void> {
    if (!Array.isArray(value)) throw new Error('研究方向文件应为 JSON 数组');
    const profiles = value.flatMap((raw): ResearchProfile[] => {
      if (!raw || typeof raw !== 'object') return [];
      const item = raw as Record<string, unknown>;
      const name = stringValue(item.name).trim();
      if (!name) return [];
      return [{ id: makeId('profile'), name, description: stringValue(item.description), enabled: true }];
    });
    if (profiles.length === 0) throw new Error('没有找到有效的研究方向');
    this.plugin.state.settings.profiles = profiles;
    await this.plugin.saveState();
    new Notice(`已导入 ${profiles.length} 个研究方向`);
    this.display();
  }

  private async importLegacyReadStatus(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('已读状态文件格式不正确');
    const status = value as Record<string, unknown>;
    let updated = 0;
    this.plugin.state.articles.forEach((article) => {
      if (typeof status[article.link] === 'boolean') {
        setArticleRead(article, Boolean(status[article.link]));
        updated += 1;
      }
    });
    await this.plugin.saveState();
    this.plugin.getView()?.render();
    new Notice(`已恢复 ${updated} 篇文章的已读状态`);
  }
}

class FeedHealthModal extends Modal {
  constructor(app: App, private readonly results: FeedHealthResult[]) { super(app); }

  onOpen(): void {
    this.contentEl.addClass('ai-rss-feed-health-modal');
    this.contentEl.createEl('h2', { text: 'RSS 源检测结果' });
    const healthy = this.results.filter((result) => result.ok).length;
    this.contentEl.createEl('p', {
      text: `共检测 ${this.results.length} 个：${healthy} 个正常，${this.results.length - healthy} 个异常。`,
      cls: 'setting-item-description',
    });
    this.results.forEach((result) => {
      const detail = result.ok
        ? (result.hasEntries ? '格式有效，能够读取条目' : '格式有效，当前没有条目')
        : `检测失败：${result.error || '未知错误'}`;
      const row = new Setting(this.contentEl).setName(result.feed.name).setDesc(`${result.feed.url} · ${detail}`);
      row.controlEl.createSpan({
        text: result.ok ? '正常' : '异常',
        cls: `ai-rss-feed-health-status ${result.ok ? 'is-ok' : 'is-error'}`,
      });
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText('关闭').setCta().onClick(() => this.close()));
  }
}

class NoteTemplateModal extends Modal {
  private noteNameFormat: string;
  private noteContentFormat: string;
  private propertiesJson: string;

  constructor(private readonly plugin: AiRssReaderPlugin, private readonly done: () => void) {
    super(plugin.app);
    const settings = plugin.state.settings;
    this.noteNameFormat = settings.noteNameFormat;
    this.noteContentFormat = settings.noteContentFormat;
    this.propertiesJson = JSON.stringify(settings.noteProperties, null, 2);
  }

  onOpen(): void {
    this.contentEl.addClass('ai-rss-template-modal');
    this.contentEl.createEl('h2', { text: 'Markdown 文献模板' });
    this.contentEl.createEl('p', {
      text: '可用变量：{{title}}、{{url}}、{{author}}、{{authors}}、{{published}}、{{date}}、{{description}}、{{journal}}、{{year}}、{{doi}}、{{citekey}}、{{profiles}}、{{content}}、{{aiAnalysis}}、{{filesSection}}、{{warningsSection}}。支持 split、wikilink、join、trim、lower、upper 过滤器。',
      cls: 'setting-item-description',
    });
    new Setting(this.contentEl).setName('笔记文件名格式').setDesc('不需要填写 .md 后缀。').addText((input) => input.setValue(this.noteNameFormat).onChange((value) => { this.noteNameFormat = value; }));
    new Setting(this.contentEl).setName('Markdown 正文格式').addTextArea((input) => {
      input.setValue(this.noteContentFormat).onChange((value) => { this.noteContentFormat = value; });
      input.inputEl.rows = 14;
    });
    new Setting(this.contentEl).setName('YAML Properties').setDesc('JSON 数组；type 支持 text、multitext、date、number、checkbox。').addTextArea((input) => {
      input.setValue(this.propertiesJson).onChange((value) => { this.propertiesJson = value; });
      input.inputEl.rows = 16;
    });
    const actions = new Setting(this.contentEl);
    actions.addButton((button) => button.setButtonText('恢复默认').setWarning().onClick(() => {
      this.noteNameFormat = DEFAULT_SETTINGS.noteNameFormat;
      this.noteContentFormat = DEFAULT_SETTINGS.noteContentFormat;
      this.propertiesJson = JSON.stringify(DEFAULT_SETTINGS.noteProperties, null, 2);
      this.contentEl.empty();
      this.onOpen();
    }));
    actions.addButton((button) => button.setButtonText('保存模板').setCta().onClick(() => void this.save()));
  }

  private async save(): Promise<void> {
    try {
      const properties = normalizeNoteProperties(JSON.parse(this.propertiesJson));
      if (!this.noteNameFormat.trim()) throw new Error('笔记文件名格式不能为空');
      if (!this.noteContentFormat.trim()) throw new Error('Markdown 正文格式不能为空');
      if (properties.length === 0) throw new Error('至少需要一个有效的 YAML Property');
      this.plugin.state.settings.noteNameFormat = this.noteNameFormat.trim();
      this.plugin.state.settings.noteContentFormat = this.noteContentFormat;
      this.plugin.state.settings.noteProperties = properties;
      await this.plugin.saveState();
      this.close();
      this.done();
      new Notice('文献笔记模板已保存');
    } catch (error) {
      new Notice(`模板无法保存：${String(error)}`, 8000);
    }
  }
}

class FeedModal extends Modal {
  private name = '';
  private url = '';
  constructor(private readonly plugin: AiRssReaderPlugin, private readonly id: string | undefined, private readonly done: () => void) {
    super(plugin.app);
    const feed = plugin.state.settings.feeds.find((item) => item.id === id);
    this.name = feed?.name ?? '';
    this.url = feed?.url ?? '';
  }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: this.id ? '编辑 RSS 源' : '添加 RSS 源' });
    new Setting(this.contentEl).setName('名称').addText((input) => input.setValue(this.name).onChange((value) => { this.name = value; }));
    new Setting(this.contentEl).setName('URL').addText((input) => input.setPlaceholder('https://example.com/feed.xml').setValue(this.url).onChange((value) => { this.url = value; }));
    new Setting(this.contentEl).addButton((button) => button.setButtonText('保存').setCta().onClick(() => void this.save()));
  }
  private async save(): Promise<void> {
    if (!this.name.trim() || !/^https?:\/\//i.test(this.url.trim())) { new Notice('请填写名称和有效的 HTTP(S) URL'); return; }
    const feeds = this.plugin.state.settings.feeds;
    const existing = feeds.find((item) => item.id === this.id);
    if (existing) Object.assign(existing, { name: this.name.trim(), url: this.url.trim() });
    else feeds.push({ id: makeId('feed'), name: this.name.trim(), url: this.url.trim(), enabled: true });
    await this.plugin.saveState(); this.close(); this.done();
  }
}

class ProfileModal extends Modal {
  private name = '';
  private description = '';
  constructor(private readonly plugin: AiRssReaderPlugin, private readonly id: string | undefined, private readonly done: () => void) {
    super(plugin.app);
    const profile = plugin.state.settings.profiles.find((item) => item.id === id);
    this.name = profile?.name ?? '';
    this.description = profile?.description ?? '';
  }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: this.id ? '编辑研究方向' : '添加研究方向' });
    new Setting(this.contentEl).setName('名称').addText((input) => input.setValue(this.name).onChange((value) => { this.name = value; }));
    new Setting(this.contentEl).setName('关键词与描述').setDesc('中英文关键词均可；描述越具体，AI 判断越稳定。').addTextArea((input) => input.setValue(this.description).onChange((value) => { this.description = value; }));
    new Setting(this.contentEl).addButton((button) => button.setButtonText('保存').setCta().onClick(() => void this.save()));
  }
  private async save(): Promise<void> {
    if (!this.name.trim() || !this.description.trim()) { new Notice('请填写名称和描述'); return; }
    const profiles = this.plugin.state.settings.profiles;
    const duplicate = profiles.some((item) => item.name === this.name.trim() && item.id !== this.id);
    if (duplicate) { new Notice('研究方向名称不能重复'); return; }
    const existing = profiles.find((item) => item.id === this.id);
    const patch: Partial<ResearchProfile> = { name: this.name.trim(), description: this.description.trim() };
    if (existing) Object.assign(existing, patch);
    else profiles.push({ id: makeId('profile'), name: this.name.trim(), description: this.description.trim(), enabled: true });
    await this.plugin.saveState(); this.close(); this.done();
  }
}

function clamp(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function clampDecimal(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
function arrayStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function normalizeNoteProperties(value: unknown): NotePropertyTemplate[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<NotePropertyType>(['text', 'multitext', 'date', 'number', 'checkbox']);
  return value.flatMap((raw): NotePropertyTemplate[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const name = stringValue(item.name).trim();
    const propertyValue = stringValue(item.value);
    const rawType = stringValue(item.type) as NotePropertyType;
    if (!name) return [];
    return [{ name, value: propertyValue, type: allowed.has(rawType) ? rawType : 'text' }];
  });
}
function normalizeAnalysis(value: unknown): RssArticle['analysis'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: RssArticle['analysis'] = {};
  Object.entries(value as Record<string, unknown>).forEach(([name, raw]) => {
    if (!raw || typeof raw !== 'object') return;
    const item = raw as Record<string, unknown>;
    output[name] = { relevant: Boolean(item.relevant), reason: stringValue(item.reason) };
  });
  return output;
}
