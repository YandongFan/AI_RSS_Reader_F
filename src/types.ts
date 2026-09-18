export type ProviderKind = 'openai' | 'codex' | 'deepseek' | 'gemini' | 'ollama' | 'custom';

export interface FeedSource {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
}

export interface ResearchProfile {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface ProviderSettings {
  kind: ProviderKind;
  apiKey: string;
  model: string;
  baseUrl: string;
  codexExecutable: string;
}

export interface AnalysisResult {
  relevant: boolean;
  reason: string;
}

export interface RssArticle {
  curated?: boolean;
  translatedTitle?: string;
  authors?: string;
  status?: ArticleStatus;
  statusChangedAt?: string;
  imageUrl?: string;
  updatedAt?: string;
  id: string;
  title: string;
  link: string;
  summary: string;
  published: string;
  source: string;
  fetchedAt: string;
  read: boolean;
  readAt?: string;
  savedPath?: string;
  matchedProfiles: string[];
  analysis: Record<string, AnalysisResult>;
}

export type NotePropertyType = 'text' | 'multitext' | 'date' | 'number' | 'checkbox';

export interface NotePropertyTemplate {
  name: string;
  value: string;
  type: NotePropertyType;
}

export interface AiRssSettings {
  feeds: FeedSource[];
  profiles: ResearchProfile[];
  provider: ProviderSettings;
  providerConfigs: Record<ProviderKind, ProviderSettings>;
  keywordFilter: boolean;
  keepIrrelevant: boolean;
  maxItemsPerFeed: number;
  batchSize: number;
  profileReanalysisDays: number;
  readRetentionDays: number;
  unreadRetentionDays: number;
  outputFolder: string;
  literatureFolderTemplate: string;
  openNoteAfterSingleSave: boolean;
  batchCaptureIntervalSeconds: number;
  extractFullText: boolean;
  downloadBibtex: boolean;
  downloadPdf: boolean;
  downloadSupplementary: boolean;
  supplementaryFileTypes: string[];
  downloadPeerReview: boolean;
  peerReviewFileTypes: string[];
  ezProxyEnabled: boolean;
  ezProxyPrefix: string;
  ezProxyCookieHeader: string;
  ezProxyLastAuthenticated: string;
  noteNameFormat: string;
  noteContentFormat: string;
  noteProperties: NotePropertyTemplate[];
  mineruToken: string;
  mineruModelVersion: 'vlm' | 'pipeline';
  mineruLanguage: string;
  mineruOcr: boolean;
  mineruEnableTable: boolean;
  mineruEnableFormula: boolean;
  mineruSaveMarkdown: boolean;
  mineruSaveContentListJson: boolean;
  mineruSaveLayoutJson: boolean;
  mineruSaveModelJson: boolean;
  mineruSaveImages: boolean;
  mineruSaveOtherFiles: boolean;
  audioTutorLanguage: string;
  audioTutorLearnerBackground: string;
  audioTutorTargetMinutes: number;
  edgeTtsVoice: string;
  edgeTtsRate: number;
  edgeTtsPitch: number;
  edgeTtsVolume: number;
}

export type ArticleStatus = 'unread' | 'interested' | 'archived' | 'hidden' | 'expired';
export type ArticleSort = 'title' | 'updated' | 'journal' | 'relevance';
export interface RecommendationScore {
  keywordTier?: 'high' | 'pending' | 'low';
  review?: { tier?: 'high' | 'low'; error?: string };
  score: number;
  tier: 'high' | 'pending' | 'low';
  terms: string[];
}
export interface RecommendationState {
  trainingFingerprint?: string;
  keywords?: { term: string; weight: number; idf: number; positive: number; negative: number }[];
  intercept?: number;
  accuracy?: number | null;
  lowThreshold?: number;
  highThreshold?: number;
  fingerprint: string;
  updatedAt: string;
  positive: number;
  negative: number;
  scores: Record<string, RecommendationScore>;
}

export interface PluginState {
  readerMode?: 'curated' | 'explore';
  recommendationOptions?: { disabledKeywords: string[]; lowThreshold: number | null; highThreshold: number | null; userInterest: string };
  recommendations?: RecommendationState;
  articleSort?: ArticleSort;
  curatedSort?: { key: ArticleSort; reversed: boolean };
  settings: AiRssSettings;
  articles: RssArticle[];
  seenLinks: string[];
  lastFetchedAt: string;
  analysisProfileFingerprint?: string;
  lastLiteratureSaveFolder: string;
  tableColumnWidths: TableColumnWidths;
  audioTutorPlaybackPositions: Record<string, number>;
}

export type TableColumnKey = 'select' | 'title' | 'source' | 'profiles' | 'reason' | 'date' | 'preview';
export type TableColumnWidths = Record<TableColumnKey, number>;

export interface FetchProgress {
  phase: 'feeds' | 'filter' | 'analysis' | 'saving' | 'done';
  message: string;
  current: number;
  total: number;
}
