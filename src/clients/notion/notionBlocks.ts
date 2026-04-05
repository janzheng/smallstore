/**
 * Notion Block ↔ Markdown conversion utilities.
 *
 * Standalone pure functions for converting between Markdown strings
 * and Notion block arrays. No external dependencies.
 *
 * Ported from platform/core/modules/compositions/notion-blogalog/core/notionCoreLoader.ts
 * as standalone functions for use in the smallstore package.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RichTextItem {
  type: 'text';
  text: { content: string; link?: { url: string } };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
  plain_text?: string;
  href?: string;
}

export interface NotionBlock {
  object?: 'block';
  id?: string;
  type: string;
  has_children?: boolean;
  parent?: { block_id?: string };
  [key: string]: any;
}

// ─── Notion rich_text → Markdown ─────────────────────────────────────────────

/**
 * Convert Notion rich_text array to inline markdown string.
 */
export function notionRichTextToMarkdown(richText: unknown): string {
  if (!richText || !Array.isArray(richText) || richText.length === 0) return '';

  let markdown = '';
  for (const item of richText) {
    const typedItem = item as RichTextItem;
    const textContent = typedItem.plain_text || typedItem.text?.content || '';
    let content = textContent;
    const annotations = typedItem.annotations;

    if (annotations) {
      const { bold, italic, strikethrough, code } = annotations;
      if (bold) content = `**${content}**`;
      if (italic) content = `*${content}*`;
      if (strikethrough) content = `~~${content}~~`;
      if (code) content = `\`${content}\``;
    }

    const href = typedItem.href;
    if (href) {
      content = `[${content}](${href})`;
    }
    markdown += content;
  }
  return markdown;
}

// ─── Markdown inline → Notion rich_text ──────────────────────────────────────

/**
 * Parse markdown inline formatting to Notion rich_text array.
 * Supports: bold, italic, strikethrough, code, links.
 */
export function parseMarkdownInline(text: string, depth = 0): RichTextItem[] {
  if (depth > 10) {
    // Too deeply nested — return as plain text to prevent infinite recursion
    return [{ type: 'text', text: { content: text } }];
  }
  const richText: RichTextItem[] = [];
  let i = 0;

  while (i < text.length) {
    // Code inline `code`
    const codeMatch = text.slice(i).match(/^`([^`]+)`/);
    if (codeMatch) {
      richText.push({
        type: 'text',
        text: { content: codeMatch[1] },
        annotations: { code: true },
      });
      i += codeMatch[0].length;
      continue;
    }

    // Strikethrough ~~text~~
    const strikethroughMatch = text.slice(i).match(/^~~(.+?)~~/);
    if (strikethroughMatch) {
      const inner = parseMarkdownInline(strikethroughMatch[1], depth + 1);
      richText.push(...inner.map((item) => ({
        ...item,
        annotations: { ...item.annotations, strikethrough: true },
      })));
      i += strikethroughMatch[0].length;
      continue;
    }

    // Bold **text** or __text__
    const boldMatch = text.slice(i).match(/^(\*\*|__)(.+?)\1/);
    if (boldMatch) {
      const inner = parseMarkdownInline(boldMatch[2], depth + 1);
      richText.push(...inner.map((item) => ({
        ...item,
        annotations: { ...item.annotations, bold: true },
      })));
      i += boldMatch[0].length;
      continue;
    }

    // Italic *text* or _text_
    const italicMatch = text.slice(i).match(/^([*_])([^*_\s~`][^*_~`]*?)\1/);
    if (italicMatch) {
      const inner = parseMarkdownInline(italicMatch[2], depth + 1);
      richText.push(...inner.map((item) => ({
        ...item,
        annotations: { ...item.annotations, italic: true },
      })));
      i += italicMatch[0].length;
      continue;
    }

    // Link [text](url)
    const linkMatch = text.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const linkText = linkMatch[1];
      const linkUrl = linkMatch[2];
      const inner = parseMarkdownInline(linkText, depth + 1);
      richText.push(...inner.map((item) => ({
        ...item,
        text: { ...item.text, link: { url: linkUrl } },
      })));
      i += linkMatch[0].length;
      continue;
    }

    // Regular text — advance to next special character
    let nextSpecial = text.length;
    for (const char of ['`', '*', '_', '[', '~']) {
      const idx = text.indexOf(char, i + 1);
      if (idx !== -1 && idx < nextSpecial) nextSpecial = idx;
    }

    // If nextSpecial didn't advance past i, consume at least one character
    if (nextSpecial <= i) nextSpecial = i + 1;

    const plainText = text.slice(i, nextSpecial);
    if (plainText) {
      richText.push({ type: 'text', text: { content: plainText } });
    }
    i = nextSpecial;
  }

  return richText;
}

// ─── Markdown → Notion blocks ────────────────────────────────────────────────

/**
 * Convert a markdown string to an array of Notion blocks.
 *
 * NOTE: Markdown tables are not supported and will be lost on round-trip
 * (markdown -> blocks -> markdown). Tables in the source markdown are
 * currently treated as plain paragraph text.
 */
export function markdownToBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = markdown.split('\n');

  let inCodeBlock = false;
  let codeBlockLanguage = '';
  let codeBlockContent: string[] = [];

  let bulletedItems: string[] = [];
  let numberedItems: string[] = [];
  let todoItems: { text: string; checked: boolean }[] = [];
  let quoteContent: string[] = [];
  let inQuote = false;
  let toggleContent: string[] = [];
  let toggleTitle = '';
  let inToggle = false;

  // ── Flush helpers ──

  const flushBulleted = () => {
    for (const item of bulletedItems) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseMarkdownInline(item.trim()) },
      });
    }
    bulletedItems = [];
  };

  const flushNumbered = () => {
    for (const item of numberedItems) {
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: parseMarkdownInline(item.trim()) },
      });
    }
    numberedItems = [];
  };

  const flushTodo = () => {
    for (const item of todoItems) {
      blocks.push({
        object: 'block',
        type: 'to_do',
        to_do: {
          rich_text: parseMarkdownInline(item.text.trim()),
          checked: item.checked,
        },
      });
    }
    todoItems = [];
  };

  const flushQuote = () => {
    if (quoteContent.length === 0) return;
    const text = quoteContent.join('\n');
    // Callout detection: starts with emoji
    const emojiPattern = /^(\p{Emoji}|\p{Emoji_Presentation}|\p{Emoji_Modifier_Base})/u;
    const firstChar = text.trim().charAt(0);
    if (emojiPattern.test(firstChar)) {
      blocks.push({
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: parseMarkdownInline(text.slice(firstChar.length).trim()),
          icon: { type: 'emoji', emoji: firstChar },
        },
      });
    } else {
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: parseMarkdownInline(text.trim()) },
      });
    }
    quoteContent = [];
    inQuote = false;
  };

  const flushToggle = () => {
    blocks.push({
      object: 'block',
      type: 'toggle',
      toggle: {
        rich_text: parseMarkdownInline(toggleTitle),
        children: toggleContent.map((l) => ({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: parseMarkdownInline(l.trim()) },
        })),
      },
    });
    toggleContent = [];
    toggleTitle = '';
    inToggle = false;
  };

  const flushAll = () => {
    if (bulletedItems.length) flushBulleted();
    if (numberedItems.length) flushNumbered();
    if (todoItems.length) flushTodo();
    if (inQuote) flushQuote();
    if (inToggle) flushToggle();
  };

  // ── Main loop ──

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();

    // Divider --- or *** or ___
    if (/^[-*_]{3,}$/.test(trimmed) && !inCodeBlock) {
      flushAll();
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      continue;
    }

    // Code block fences
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        blocks.push({
          object: 'block',
          type: 'code',
          code: {
            rich_text: [{ type: 'text', text: { content: codeBlockContent.join('\n') } }],
            language: codeBlockLanguage || 'plain text',
          },
        });
        codeBlockContent = [];
        codeBlockLanguage = '';
        inCodeBlock = false;
      } else {
        flushAll();
        const langMatch = trimmed.match(/^```(\w+)?/);
        codeBlockLanguage = langMatch?.[1] ?? '';
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Toggle (HTML <details>)
    const toggleStartMatch = line.match(/^<details>\s*<summary>(.+?)<\/summary>/i);
    if (toggleStartMatch) {
      flushAll();
      toggleTitle = toggleStartMatch[1];
      inToggle = true;
      continue;
    }
    if (inToggle) {
      if (line.match(/<\/details>/i)) {
        flushToggle();
      } else {
        toggleContent.push(line);
      }
      continue;
    }

    // Todo items - [ ] or - [x]
    const todoMatch = line.match(/^[\s]*[-*]\s\[([ xX])\]\s(.+)$/);
    if (todoMatch) {
      if (bulletedItems.length) flushBulleted();
      if (numberedItems.length) flushNumbered();
      if (inQuote) flushQuote();
      todoItems.push({ text: todoMatch[2], checked: todoMatch[1].toLowerCase() === 'x' });
      continue;
    } else if (todoItems.length) {
      flushTodo();
    }

    // Blockquotes
    if (trimmed.startsWith('>')) {
      if (bulletedItems.length) flushBulleted();
      if (numberedItems.length) flushNumbered();
      inQuote = true;
      quoteContent.push(line.replace(/^>\s?/, ''));
      continue;
    } else if (inQuote) {
      flushQuote();
    }

    // Bulleted lists
    if (/^[\s]*[-*]\s/.test(line) && !line.match(/^[\s]*[-*]\s\[/)) {
      if (numberedItems.length) flushNumbered();
      if (inQuote) flushQuote();
      bulletedItems.push(line.replace(/^[\s]*[-*]\s/, ''));
      continue;
    } else if (bulletedItems.length) {
      flushBulleted();
    }

    // Numbered lists
    if (/^[\s]*\d+[.)]\s/.test(line)) {
      if (bulletedItems.length) flushBulleted();
      if (inQuote) flushQuote();
      numberedItems.push(line.replace(/^[\s]*\d+[.)]\s/, ''));
      continue;
    } else if (numberedItems.length) {
      flushNumbered();
    }

    // Image ![alt](url)
    const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imageMatch) {
      blocks.push({
        object: 'block',
        type: 'image',
        image: {
          type: 'external',
          external: { url: imageMatch[2] },
          caption: imageMatch[1]
            ? [{ type: 'text', text: { content: imageMatch[1] } }]
            : [],
        },
      });
      continue;
    }

    // Headings
    if (trimmed.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: parseMarkdownInline(trimmed.slice(4).trim()) },
      });
    } else if (trimmed.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: parseMarkdownInline(trimmed.slice(3).trim()) },
      });
    } else if (trimmed.startsWith('# ')) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: parseMarkdownInline(trimmed.slice(2).trim()) },
      });
    } else if (trimmed) {
      // Regular paragraph
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: parseMarkdownInline(trimmed) },
      });
    }
    // Empty lines are skipped (paragraph separation)
  }

  // Flush remaining
  flushAll();
  if (inCodeBlock) {
    blocks.push({
      object: 'block',
      type: 'code',
      code: {
        rich_text: [{ type: 'text', text: { content: codeBlockContent.join('\n') } }],
        language: codeBlockLanguage || 'plain text',
      },
    });
  }

  return blocks;
}

// ─── Notion blocks → Markdown ────────────────────────────────────────────────

/**
 * Convert an array of Notion blocks to a markdown string.
 */
export function blocksToMarkdown(blocks: unknown): string {
  if (typeof blocks === 'string') {
    try { blocks = JSON.parse(blocks); } catch { return ''; }
  }
  if (!blocks || !Array.isArray(blocks)) return '';

  let markdown = '';
  const processedIds = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as NotionBlock;
    if (!block) continue;
    if (block.id && processedIds.has(block.id)) continue;

    switch (block.type) {
      case 'paragraph': {
        const text = notionRichTextToMarkdown(block.paragraph?.rich_text);
        if (text) markdown += `${text}\n\n`;
        break;
      }
      case 'heading_1':
        markdown += `# ${notionRichTextToMarkdown(block.heading_1?.rich_text)}\n\n`;
        break;
      case 'heading_2':
        markdown += `## ${notionRichTextToMarkdown(block.heading_2?.rich_text)}\n\n`;
        break;
      case 'heading_3':
        markdown += `### ${notionRichTextToMarkdown(block.heading_3?.rich_text)}\n\n`;
        break;
      case 'bulleted_list_item':
        markdown += `- ${notionRichTextToMarkdown(block.bulleted_list_item?.rich_text)}\n`;
        break;
      case 'numbered_list_item':
        markdown += `1. ${notionRichTextToMarkdown(block.numbered_list_item?.rich_text)}\n`;
        break;
      case 'to_do': {
        const checked = block.to_do?.checked ? 'x' : ' ';
        markdown += `- [${checked}] ${notionRichTextToMarkdown(block.to_do?.rich_text)}\n`;
        break;
      }
      case 'code': {
        const lang = block.code?.language || '';
        const code = notionRichTextToMarkdown(block.code?.rich_text);
        markdown += `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
        break;
      }
      case 'quote':
        markdown += `> ${notionRichTextToMarkdown(block.quote?.rich_text)}\n\n`;
        break;
      case 'callout': {
        const emoji = block.callout?.icon?.emoji || '';
        markdown += `> ${emoji} ${notionRichTextToMarkdown(block.callout?.rich_text)}\n\n`;
        break;
      }
      case 'divider':
        markdown += `---\n\n`;
        break;
      case 'toggle': {
        const summary = notionRichTextToMarkdown(block.toggle?.rich_text);
        markdown += `<details>\n<summary>${summary}</summary>\n\n`;
        // Process children if inline
        if (block.toggle?.children) {
          for (const child of block.toggle.children) {
            markdown += blockToMarkdownLine(child);
          }
        }
        // Find children in flat array.
        // NOTE (A098): Notion's block API returns flat arrays without parent references
        // for deeply nested blocks. This lookup only finds direct children whose
        // parent.block_id matches the toggle's id. Deeply nested children (grandchildren
        // etc.) will be orphaned in the flat array and won't appear in the toggle output.
        // This is a Notion API limitation — not a bug in this code.
        if (block.has_children && block.id) {
          for (let j = i + 1; j < blocks.length; j++) {
            const next = blocks[j] as NotionBlock;
            if (next?.parent?.block_id === block.id) {
              markdown += blockToMarkdownLine(next);
              if (next.id) processedIds.add(next.id);
            }
          }
        }
        markdown += `</details>\n\n`;
        break;
      }
      case 'image': {
        const url = block.image?.type === 'external'
          ? block.image.external?.url
          : block.image?.file?.url;
        const caption = block.image?.caption
          ? notionRichTextToMarkdown(block.image.caption)
          : '';
        if (url) markdown += `![${caption}](${url})\n\n`;
        break;
      }
      case 'bookmark':
        if (block.bookmark?.url) {
          markdown += `[${block.bookmark.url}](${block.bookmark.url})\n\n`;
        }
        break;
      case 'table': {
        const rows = block.table?.children || block.children || [];
        if (rows.length > 0) {
          const hasHeader = block.table?.has_column_header || false;
          const firstRow = rows[0];
          const headerCells = extractTableCells(firstRow);
          markdown += `| ${headerCells.join(' | ')} |\n`;
          markdown += `| ${headerCells.map(() => '---').join(' | ')} |\n`;
          const startIdx = hasHeader ? 1 : 0;
          for (let r = startIdx; r < rows.length; r++) {
            const cells = extractTableCells(rows[r]);
            markdown += `| ${cells.join(' | ')} |\n`;
          }
          markdown += '\n';
          // Mark children as processed
          for (const row of rows) {
            if (row.id) processedIds.add(row.id);
          }
        }
        break;
      }
      // Skip unknown block types
    }
  }

  return markdown.trimEnd() + '\n';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function blockToMarkdownLine(block: NotionBlock): string {
  switch (block.type) {
    case 'paragraph':
      return `${notionRichTextToMarkdown(block.paragraph?.rich_text)}\n\n`;
    case 'heading_1':
      return `# ${notionRichTextToMarkdown(block.heading_1?.rich_text)}\n\n`;
    case 'heading_2':
      return `## ${notionRichTextToMarkdown(block.heading_2?.rich_text)}\n\n`;
    case 'heading_3':
      return `### ${notionRichTextToMarkdown(block.heading_3?.rich_text)}\n\n`;
    case 'bulleted_list_item':
      return `- ${notionRichTextToMarkdown(block.bulleted_list_item?.rich_text)}\n`;
    case 'numbered_list_item':
      return `1. ${notionRichTextToMarkdown(block.numbered_list_item?.rich_text)}\n`;
    case 'code': {
      const lang = block.code?.language || '';
      return `\`\`\`${lang}\n${notionRichTextToMarkdown(block.code?.rich_text)}\n\`\`\`\n\n`;
    }
    default:
      return '';
  }
}

function extractTableCells(row: any): string[] {
  if (row?.table_row?.cells) {
    return row.table_row.cells.map((cell: any) => notionRichTextToMarkdown(cell));
  }
  return [];
}
