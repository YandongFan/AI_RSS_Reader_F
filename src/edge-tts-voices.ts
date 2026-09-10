export type EdgeTtsVoiceGroup = '中英通用' | '中文' | '英文';
export type EdgeTtsVoiceGender = '女' | '男';

export interface EdgeTtsVoiceOption {
  value: string;
  name: string;
  gender: EdgeTtsVoiceGender;
  group: EdgeTtsVoiceGroup;
  accent: string;
}

export const EDGE_TTS_DEFAULT_VOICE = 'en-US-AndrewMultilingualNeural';

export const EDGE_TTS_VOICE_OPTIONS: EdgeTtsVoiceOption[] = [
  { value: 'en-US-AndrewMultilingualNeural', name: 'Andrew', gender: '男', group: '中英通用', accent: '多语言／美式主音色' },
  { value: 'en-US-AvaMultilingualNeural', name: 'Ava', gender: '女', group: '中英通用', accent: '多语言／美式主音色' },
  { value: 'en-US-BrianMultilingualNeural', name: 'Brian', gender: '男', group: '中英通用', accent: '多语言／美式主音色' },
  { value: 'en-US-EmmaMultilingualNeural', name: 'Emma', gender: '女', group: '中英通用', accent: '多语言／美式主音色' },

  { value: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: '女', group: '中文', accent: '普通话' },
  { value: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: '女', group: '中文', accent: '普通话' },
  { value: 'zh-CN-XiaohanNeural', name: '晓涵', gender: '女', group: '中文', accent: '普通话' },
  { value: 'zh-CN-XiaomengNeural', name: '晓梦', gender: '女', group: '中文', accent: '普通话' },
  { value: 'zh-CN-XiaoruiNeural', name: '晓睿', gender: '女', group: '中文', accent: '普通话' },
  { value: 'zh-CN-YunxiNeural', name: '云希', gender: '男', group: '中文', accent: '普通话' },
  { value: 'zh-CN-YunjianNeural', name: '云健', gender: '男', group: '中文', accent: '普通话' },
  { value: 'zh-CN-YunyangNeural', name: '云扬', gender: '男', group: '中文', accent: '普通话' },
  { value: 'zh-CN-YunxiaNeural', name: '云夏', gender: '男', group: '中文', accent: '普通话' },
  { value: 'zh-CN-YunyeNeural', name: '云野', gender: '男', group: '中文', accent: '普通话' },

  { value: 'en-US-JennyNeural', name: 'Jenny', gender: '女', group: '英文', accent: '美式英语' },
  { value: 'en-US-AriaNeural', name: 'Aria', gender: '女', group: '英文', accent: '美式英语' },
  { value: 'en-US-MichelleNeural', name: 'Michelle', gender: '女', group: '英文', accent: '美式英语' },
  { value: 'en-GB-SoniaNeural', name: 'Sonia', gender: '女', group: '英文', accent: '英式英语' },
  { value: 'en-US-GuyNeural', name: 'Guy', gender: '男', group: '英文', accent: '美式英语' },
  { value: 'en-US-ChristopherNeural', name: 'Christopher', gender: '男', group: '英文', accent: '美式英语' },
  { value: 'en-GB-RyanNeural', name: 'Ryan', gender: '男', group: '英文', accent: '英式英语' },
];

export function edgeTtsVoiceLabel(option: EdgeTtsVoiceOption): string {
  const suffix = option.value === EDGE_TTS_DEFAULT_VOICE ? ' · 默认' : '';
  return `【${option.group}】${option.name}（${option.gender}）· ${option.accent}${suffix}`;
}
