/**
 * Dictionaries for the settings section. The plugin follows the browser's
 * language preference through `navigator.language`: the two dictionaries are
 * keyed identically and `t()` picks one, falling back to English for any
 * language the pair does not cover.
 *
 * Deliberately dependency-free — no locale service, no registration order to
 * get right — so a deployment that needs a third language swaps this module,
 * not the section.
 * @module @roubaai/settings/client/locales
 */

/** The dictionary key union: both languages carry exactly these keys. */
const zh = {
  intro: '配置图片 / 视频 / 音乐生成服务的提供方。API Key 只写入、不回显。',
  categoryImage: '图片',
  categoryVideo: '视频',
  categoryMusic: '音乐',
  defaultProviderName: '默认',
  customBadge: '自定义',
  activeLabel: '使用中',
  useAction: '使用',
  editAction: '编辑',
  deleteAction: '删除',
  addProvider: '添加自定义提供方',
  apiKeyTitle: 'API Key',
  apiKeyDesc: '保存后不再显示',
  apiKeySaved: '已保存，留空表示不修改',
  apiKeyUnset: '尚未设置',
  adapterTitle: '适配器',
  adapterHint: '由哪个已安装的后端处理这一行。可选值来自本次部署实际挂载的插件。',
  baseUrlTitle: '接口地址',
  baseUrlReadonly: '内置默认端点，不可修改。',
  getApiKey: '获取专属 API Key',
  modelTitle: '模型',
  modelReadonly: '内置默认模型，不可修改',
  nameTitle: '名称',
  namePlaceholder: '提供方名称',
  cancel: '取消',
  save: '保存',
  saving: '保存中…',
  test: '测试连接',
  testing: '测试中…',
  saveFailed: '保存失败：',
  testFailed: '测试失败：',
  conflict: '配置已被其他端修改，请刷新后重试。',
  untitledProvider: '未命名提供方',
} as const

type MessageKey = keyof typeof zh

const en: Record<MessageKey, string> = {
  intro: 'Configure providers for the image / video / music generation services. API keys are write-only and are never shown back.',
  categoryImage: 'Image',
  categoryVideo: 'Video',
  categoryMusic: 'Music',
  defaultProviderName: 'Default',
  customBadge: 'Custom',
  activeLabel: 'In use',
  useAction: 'Use',
  editAction: 'Edit',
  deleteAction: 'Delete',
  addProvider: 'Add custom provider',
  apiKeyTitle: 'API key',
  apiKeyDesc: 'Hidden once saved',
  apiKeySaved: 'Saved — leave empty to keep it unchanged',
  apiKeyUnset: 'Not set yet',
  adapterTitle: 'Adapter',
  adapterHint: 'Which installed backend serves this row. The choices are the plugins this deployment actually mounted.',
  baseUrlTitle: 'Endpoint',
  baseUrlReadonly: 'Built-in default endpoint (read-only).',
  getApiKey: 'Get an exclusive API key',
  modelTitle: 'Model',
  modelReadonly: 'Built-in default model (read-only)',
  nameTitle: 'Name',
  namePlaceholder: 'Provider name',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving…',
  test: 'Test connection',
  testing: 'Testing…',
  saveFailed: 'Save failed: ',
  testFailed: 'Test failed: ',
  conflict: 'The configuration changed elsewhere; refresh and try again.',
  untitledProvider: 'Untitled provider',
}

/** Whether the browser prefers Chinese (any zh-* tag). */
function isChinese(): boolean {
  return (navigator.language ?? '').toLowerCase().startsWith('zh')
}

/**
 * Look up one message in the active language.
 * @param key - the dictionary key.
 * @returns the localized string.
 */
export function t(key: MessageKey): string {
  return isChinese() ? zh[key] : en[key]
}
