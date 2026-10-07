import { memo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/common';

// Responses as a rendered page: real heading sizes, tables, highlighted
// code with a copy button, task lists. Links open in the browser.

type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastNode[] };

function textOf(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Highlighted HTML for `code` in `lang` (escaped plain text when the language is unknown). */
export function highlight(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to plain text
    }
  }
  return escapeHtml(code);
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void window.binder.copyText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang || 'text'}</span>
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: highlight(code.replace(/\n$/, ''), lang) }} />
      </pre>
    </div>
  );
}

function openLink(href: string | undefined) {
  if (href) void window.binder.openExternal(href);
}

const components: Components = {
  pre({ node }) {
    const code = (node?.children?.[0] ?? undefined) as HastNode | undefined;
    const cls = code?.properties?.className;
    const lang = (Array.isArray(cls) ? cls : [])
      .map(String)
      .find((c) => c.startsWith('language-'))
      ?.slice('language-'.length);
    return <CodeBlock code={textOf(code)} lang={lang} />;
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault();
          openLink(href);
        }}
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    );
  },
  input({ type, checked }) {
    // Task list boxes, drawn so they do not look like disabled controls.
    if (type !== 'checkbox') return null;
    return <span className={`check${checked ? ' on' : ''}`}>{checked ? '✓' : ''}</span>;
  },
  img({ src, alt }) {
    // Never loaded on their own: text injected into Claude's context could
    // otherwise make the app fetch any URL just by showing a response. A
    // remote image is a link to open in the browser.
    const url = typeof src === 'string' ? src : '';
    const label = `Image: ${alt || url.split('/').pop() || 'untitled'}`;
    if (!/^https?:/.test(url)) return <span className="md-image" title={url}>{label}</span>;
    return (
      <a
        className="md-image"
        href={url}
        title={url}
        onClick={(e) => {
          e.preventDefault();
          openLink(url);
        }}
      >
        {label} ({URL.parse(url)?.host ?? url})
      </a>
    );
  },
};

const plugins = [remarkGfm];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
