/**
 * Display-layer Chinese descriptions for the built-in agent tools (REQ-003:
 * 工具和技能的描述支持中文 / 界面语言本地化).
 *
 * IMPORTANT: these translations are for the USER-FACING capabilities panel
 * ONLY. The LLM-facing tool definitions keep their English descriptions in
 * AgentTools.ts — the model selects tools by name + parameter schema, not by
 * the description text, so localizing the display text cannot affect actual
 * tool calls. Unknown tools fall back to the English description.
 */

export const TOOL_DESCRIPTIONS_ZH: Record<string, string> = {
  list_locations: '列出所有已连接的位置（文件夹），供后续文件操作使用。',
  search_knowledge_base: '在知识库中搜索条目，返回标题、摘要与匹配片段。',
  read_knowledge_entry: '读取知识库中的单条条目内容。',
  write_knowledge_entry: '向知识库写入新条目，沉淀可复用的知识。',
  search_files: '搜索文件与文件夹，支持 +tag / -tag / --type 等操作符。',
  list_folder: '列出文件夹内容（可递归），条目带 AI 摘要状态、描述与标签信息。',
  get_entry_tags: '获取文件或文件夹的标签列表。',
  add_tags: '为文件或文件夹添加标签。',
  remove_tags: '从文件或文件夹移除标签。',
  read_file_text: '读取文本文件内容（有大小与长度限制）。',
  set_description: '设置条目的描述文本（保护人工写的内容）。',
  get_description: '获取条目的当前描述文本。',
  move_file: '移动文件到目标文件夹（目标已存在时不覆盖）。',
  write_deliverable: '生成 .md / .txt 交付文档，可写入文件或直接回复文本。',
  web_search: '联网搜索网页，返回标题、URL 与摘要（快）。',
  fetch_web: '抓取单个网页的正文内容（有长度限制）。',
  deepseek_search: 'DeepSeek 深度搜索，综合多个来源给出结论与引用（较慢）。',
  organize_preview: '预览文件整理方案：按扩展名把文件分类到子文件夹。',
  organize_apply: '执行文件整理：自动创建分类文件夹、绝不覆盖、写历史记录。',
  organize_undo: '撤销一次整理：按历史记录恢复文件到原位置。',
  organize_history: '列出最近的整理操作记录。',
  delete_files: '删除文件（仅移入系统回收站，可恢复，需逐文件夹确认授权）。',
  delete_folder: '删除空文件夹（仅移入系统回收站）。',
  todo_list: '列出待办清单及统计信息。',
  todo_create: '创建新的待办事项。',
  todo_complete: '将待办事项标记为已完成。',
  todo_update_status: '更新待办事项状态（待办/进行中/已完成）。',
  report_issue:
    '把需求或缺陷上报到内置的「需求与缺陷收集」列表（自动附环境快照）。',
  list_issues: '列出「需求与缺陷收集」中的条目，可按状态/类型/关键词筛选。',
  run_command: '执行 shell 命令行（桌面端）；首次运行会弹出授权确认对话框。',
  exec_grants: '查看或撤销记住的 run_command 授权（list / revoke-all）。',
  wiztree_scan: '用 WizTree 分析磁盘或文件夹空间占用（Windows，直读 NTFS）。',
  scan_importable_skills: '扫描本机可导入的技能（SKILL.md）与工具/MCP 配置。',
  import_skills: '从扫描结果导入技能为自定义技能（支持整目录导入）。',
  init_scan: '扫描磁盘目录结构，为「收件箱自动归类」方案收集数据。',
  create_location: '新建并连接一个位置（文件夹）。',
  open_privacy_settings: '打开隐私设置说明（数据只读、不上传、跳过敏感目录）。',
  finish_disk_init: '标记磁盘初始化访谈完成，结束引导流程。',
  read_disk_init: '读取磁盘初始化状态（是否已完成、收件箱配置等）。',
  update_disk_init: '更新磁盘初始化配置（收件箱列表等）。',
  mark_inbox_organized: '标记收件箱已完成本轮整理（记录时间戳）。',
  schedule_task: '创建定时任务，让 Agent 在指定时间自动运行。',
  scheduled_tasks: '列出已创建的定时任务及其最近运行结果。',
  unschedule_task: '取消（删除）一个定时任务。',
};

/**
 * Localize a built-in tool description for display. Returns the Chinese text
 * for Chinese UI languages (and falls back to the English original for any
 * tool without a translation or for non-Chinese UI languages).
 */
export function localizeToolDescription(
  name: string,
  english: string,
  language: string,
): string {
  if (
    language &&
    String(language).toLowerCase().replace('_', '-').startsWith('zh')
  ) {
    return TOOL_DESCRIPTIONS_ZH[name] || english;
  }
  return english;
}
